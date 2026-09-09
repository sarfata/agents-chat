import { createHmac, randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openDb } from "../src/db.js";
import { ChatService } from "../src/chat.js";
import { EventHub } from "../src/hub.js";
import { EventsService, CHAT_ACTIVITY_EVENT } from "../src/events.js";
import { WebhookService, decodeSecret } from "../src/webhooks.js";
import type { WebhookHttpClient, WebhookPostResult } from "../src/webhook-http.js";

const alice = { id: "alice", name: "alice" };
const bob = { id: "bob", name: "bob" };
const url = "https://receiver.example/hooks/chat";
const secret = `whsec_${randomBytes(32).toString("base64")}`;
const input = { name: CHAT_ACTIVITY_EVENT, arguments: {}, delivery: { mode: "webhook", url, secret }, cursor: null };
type Delivery = { url: string; raw: string; body: any; headers: Record<string, string>; signal: AbortSignal };

function verify(delivery: Delivery, key = secret) {
  const headers = delivery.headers;
  expect(headers["Content-Type"]).toBe("application/json");
  expect(headers["X-MCP-Subscription-Id"]).toMatch(/^sub_/);
  const expected = createHmac("sha256", Buffer.from(key.slice(6), "base64"))
    .update(`${headers["webhook-id"]}.${headers["webhook-timestamp"]}.${delivery.raw}`).digest("base64");
  expect(headers["webhook-signature"].split(" ")).toContain(`v1,${expected}`);
}

class Receiver implements WebhookHttpClient {
  deliveries: Delivery[] = [];
  statuses: number[] = [];
  rejectChallenge = false;
  async post(url: string, raw: string, headers: Record<string, string>, signal: AbortSignal): Promise<WebhookPostResult> {
    signal.throwIfAborted();
    const body = JSON.parse(raw);
    this.deliveries.push({ url, raw, body, headers, signal });
    if (body.type === "verification") return { status: 200, body: JSON.stringify({ challenge: this.rejectChallenge ? "private error response" : body.challenge }) };
    return { status: this.statuses.shift() ?? 200, body: "private response" };
  }
  events() { return this.deliveries.filter((d) => d.body.eventId); }
  challenges() { return this.deliveries.filter((d) => d.body.type === "verification"); }
}

const fixtures: ReturnType<typeof setup>[] = [];
function setup() {
  const db = openDb(":memory:");
  const hub = new EventHub();
  const events = new EventsService(db, hub);
  const chat = new ChatService(db, hub);
  const receiver = new Receiver();
  const service = new WebhookService(events, hub, receiver);
  const channel = chat.createChannel(alice, "test");
  const fixture = { db, hub, events, chat, receiver, service, channel };
  fixtures.push(fixture);
  return fixture;
}
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date("2026-09-09T01:00:00Z")); });
afterEach(async () => {
  for (const fixture of fixtures.splice(0)) { await fixture.service.close(); fixture.db.close(); }
  vi.useRealTimers();
});

describe("webhook delivery", () => {
  it("verifies intent, signs events, refreshes idempotently, and stops on unsubscribe", async () => {
    const f = setup();
    const subscribed = await f.service.subscribe(alice, input);
    expect(subscribed).toMatchObject({ cursor: "chat-event:1", truncated: false, deliveryStatus: { active: true } });
    expect(f.receiver.events()).toHaveLength(0);
    verify(f.receiver.challenges()[0]);
    expect(f.receiver.challenges()[0].headers["webhook-id"]).toMatch(/^msg_verification_/);
    f.chat.postMessage(alice, f.channel.id, "signed event");
    await vi.advanceTimersByTimeAsync(0);
    const delivered = f.receiver.events()[0];
    verify(delivered);
    expect(delivered.body).toMatchObject({ name: CHAT_ACTIVITY_EVENT, cursor: "chat-event:2", data: { kind: "message.posted", message: { text: "signed event" } } });
    expect(delivered.headers["webhook-id"]).toBe(delivered.body.eventId);
    const polled = f.events.poll(alice, { name: CHAT_ACTIVITY_EVENT, cursor: subscribed.cursor });
    expect(polled.events[0].eventId).toBe(delivered.body.eventId);
    const refreshed = await f.service.subscribe(alice, { ...input, cursor: subscribed.cursor });
    expect(refreshed.id).toBe(subscribed.id);
    expect(refreshed.cursor).toBe("chat-event:2");
    expect(f.receiver.challenges()).toHaveLength(1);
    await f.service.unsubscribe(alice, input);
    f.chat.postMessage(alice, f.channel.id, "after unsubscribe");
    await vi.advanceTimersByTimeAsync(5000);
    expect(f.receiver.events()).toHaveLength(1);
    await expect(f.service.unsubscribe(alice, input)).rejects.toMatchObject({ code: -32011 });
  });

  it("isolates principals and membership at event time", async () => {
    const f = setup();
    const a = await f.service.subscribe(alice, input);
    const b = await f.service.subscribe(bob, input);
    expect(a.id).not.toBe(b.id);
    expect(f.receiver.challenges()).toHaveLength(2);
    f.chat.postMessage(alice, f.channel.id, "before bob joined");
    await vi.advanceTimersByTimeAsync(1000);
    expect(f.receiver.events()).toHaveLength(1);
    f.chat.joinChannel(bob, f.channel.id);
    f.chat.postMessage(alice, f.channel.id, "both members");
    await vi.advanceTimersByTimeAsync(2000);
    const bobEvents = f.receiver.events().filter((d) => d.headers["X-MCP-Subscription-Id"] === b.id);
    expect(bobEvents.map((d) => d.body.data.kind)).toEqual(["member.joined", "message.posted"]);
    await f.service.unsubscribe(bob, input);
    expect((await f.service.subscribe(alice, input)).id).toBe(a.id);
    const anotherUrl = { ...input, delivery: { ...input.delivery, url: "https://receiver.example/alice-only" } };
    await f.service.subscribe(alice, anotherUrl);
    await expect(f.service.unsubscribe(bob, anotherUrl)).rejects.toMatchObject({ code: -32011 });
  });

  it("keeps refresh watermarks behind unacknowledged events and regenerates retry signatures", async () => {
    const f = setup();
    f.receiver.statuses = [503, 200, 200];
    const subscribed = await f.service.subscribe(alice, input);
    f.chat.postMessage(alice, f.channel.id, "first");
    f.chat.postMessage(alice, f.channel.id, "second");
    await vi.advanceTimersByTimeAsync(0);
    const refresh = await f.service.subscribe(alice, { ...input, cursor: subscribed.cursor });
    expect(refresh.cursor).toBe(subscribed.cursor);
    expect(refresh.deliveryStatus.lastError).toBe("http_5xx");
    await vi.advanceTimersByTimeAsync(2000);
    const deliveries = f.receiver.events();
    expect(deliveries.map((d) => d.body.data.message.text)).toEqual(["first", "first", "second"]);
    expect(deliveries[0].headers["webhook-id"]).toBe(deliveries[1].headers["webhook-id"]);
    expect(deliveries[0].headers["webhook-timestamp"]).not.toBe(deliveries[1].headers["webhook-timestamp"]);
    deliveries.forEach((d) => verify(d));
    expect(deliveries[2].body.cursor).toBe("chat-event:3");
    expect((await f.service.subscribe(alice, input)).cursor).toBe("chat-event:3");
  });

  it.each([410, 413])("does not retry HTTP %i and continues the subscription", async (status) => {
    const f = setup();
    f.receiver.statuses = [status, 200];
    await f.service.subscribe(alice, input);
    f.chat.postMessage(alice, f.channel.id, "abandon");
    f.chat.postMessage(alice, f.channel.id, "next");
    await vi.advanceTimersByTimeAsync(5000);
    expect(f.receiver.events().map((d) => d.body.data.message.text)).toEqual(["abandon", "next"]);
  });

  it("bounds retries to five attempts and exposes only categorized failures", async () => {
    const f = setup();
    f.receiver.statuses = [500, 500, 500, 500, 500];
    await f.service.subscribe(alice, input);
    f.chat.postMessage(alice, f.channel.id, "retry limit");
    await vi.advanceTimersByTimeAsync(200_000);
    expect(f.receiver.events()).toHaveLength(5);
    const result = await f.service.subscribe(alice, input);
    expect(result.deliveryStatus.lastError).toBe("http_5xx");
    expect(JSON.stringify(result)).not.toContain("private response");
    expect(result.cursor).toBe("chat-event:2");
  });

  it("aborts sleeping retries on unsubscribe and lease expiry", async () => {
    const f = setup();
    f.receiver.statuses = Array(20).fill(503);
    await f.service.subscribe(alice, { ...input, ttlMs: 0 });
    f.chat.postMessage(alice, f.channel.id, "cancelled");
    await vi.advanceTimersByTimeAsync(0);
    await f.service.unsubscribe(alice, input);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(f.receiver.events()).toHaveLength(1);
    await f.service.subscribe(alice, { ...input, ttlMs: 0 });
    f.chat.postMessage(alice, f.channel.id, "expires");
    await vi.advanceTimersByTimeAsync(60_000);
    const count = f.receiver.events().length;
    await vi.advanceTimersByTimeAsync(200_000);
    expect(f.receiver.events()).toHaveLength(count);
    await expect(f.service.unsubscribe(alice, input)).rejects.toMatchObject({ code: -32011 });
  });

  it("rotates secrets on retries with a bounded dual-signature grace period", async () => {
    const f = setup();
    f.receiver.statuses = [503, 200];
    await f.service.subscribe(alice, input);
    f.chat.postMessage(alice, f.channel.id, "rotate while retrying");
    await vi.advanceTimersByTimeAsync(0);
    const rotated = `whsec_${randomBytes(32).toString("base64")}`;
    await f.service.subscribe(alice, { ...input, delivery: { ...input.delivery, secret: rotated } });
    await vi.advanceTimersByTimeAsync(2000);
    verify(f.receiver.events()[1], secret);
    verify(f.receiver.events()[1], rotated);
    await vi.advanceTimersByTimeAsync(60_000);
    f.chat.postMessage(alice, f.channel.id, "after grace");
    await vi.advanceTimersByTimeAsync(0);
    const last = f.receiver.events().at(-1)!;
    verify(last, rotated);
    expect(last.headers["webhook-signature"].split(" ")).toHaveLength(1);
  });

  it("clamps finite/no-expiry requests to short leases and recovers after restart from the client cursor", async () => {
    const f = setup();
    const first = await f.service.subscribe(alice, { ...input, ttlMs: null });
    expect(Date.parse(first.refreshBefore) - Date.now()).toBe(300_000);
    const minimum = await f.service.subscribe(alice, { ...input, ttlMs: 0 });
    expect(Date.parse(minimum.refreshBefore) - Date.now()).toBe(60_000);
    await f.service.close();
    f.chat.postMessage(alice, f.channel.id, "during restart");
    const restarted = new WebhookService(f.events, f.hub, f.receiver);
    try {
      const resumed = await restarted.subscribe(alice, { ...input, cursor: first.cursor });
      expect(resumed.id).toBe(first.id);
      expect(f.receiver.challenges()).toHaveLength(2);
      await vi.advanceTimersByTimeAsync(0);
      expect(f.receiver.events().at(-1)!.body.data.message.text).toBe("during restart");
    } finally { await restarted.close(); }
  });

  it("signals a replay gap and advances quiet refresh cursors without skipping unacked data", async () => {
    const f = setup();
    const start = f.events.poll(alice, { name: CHAT_ACTIVITY_EVENT }).cursor;
    f.chat.postMessage(alice, f.channel.id, "old message");
    await vi.advanceTimersByTimeAsync(20_000);
    f.chat.postMessage(alice, f.channel.id, "recent message");
    const sub = await f.service.subscribe(alice, { ...input, cursor: start, maxAgeMs: 1000 });
    expect(sub.truncated).toBe(true);
    expect(sub.cursor).toBe("chat-event:2");
    await vi.advanceTimersByTimeAsync(1000);
    expect(f.receiver.events().map((d) => d.body.data.message.text)).toEqual(["recent message"]);
    f.chat.createChannel(bob, "bob-private-history");
    expect((await f.service.subscribe(alice, input)).cursor).toBe("chat-event:4");
  });

  it("rejects invalid parameters and failed endpoint verification without leaking responses", async () => {
    const f = setup();
    for (const delivery of [
      { ...input.delivery, url: "http://example.com/hook" },
      { ...input.delivery, url: "https://user:pass@example.com/hook" },
      { ...input.delivery, url: "https://example.com/hook#fragment" },
      { ...input.delivery, secret: "not-a-secret" }
    ]) await expect(f.service.subscribe(alice, { ...input, delivery })).rejects.toMatchObject({ code: -32602 });
    await expect(f.service.subscribe(alice, { ...input, arguments: { channel: "wrong" } })).rejects.toMatchObject({ code: -32602 });
    await expect(f.service.subscribe(alice, { ...input, cursor: "chat-event:999999999999999999999" })).rejects.toMatchObject({ code: -32602 });
    await expect(f.service.subscribe(alice, { ...input, delivery: { ...input.delivery, mode: "push" } })).rejects.toMatchObject({ code: -32014 });
    expect(f.receiver.deliveries).toHaveLength(0);
    f.receiver.rejectChallenge = true;
    await expect(f.service.subscribe(alice, input)).rejects.toMatchObject({ code: -32015, data: { reason: "challenge_failed" } });
    f.chat.postMessage(alice, f.channel.id, "unverified must not deliver");
    await vi.advanceTimersByTimeAsync(0);
    expect(f.receiver.events()).toHaveLength(0);
  });

  it("rate limits verification attempts and caps subscriptions per principal", async () => {
    const f = setup();
    f.receiver.rejectChallenge = true;
    for (let i = 0; i < 10; i++) await expect(f.service.subscribe(alice, input)).rejects.toMatchObject({ code: -32015 });
    await expect(f.service.subscribe(alice, input)).rejects.toMatchObject({ code: -32013 });
    expect(f.receiver.challenges()).toHaveLength(10);
    f.receiver.rejectChallenge = false;
    for (let i = 0; i < 16; i++) await f.service.subscribe(alice, {
      ...input, delivery: { ...input.delivery, url: `https://receiver${i}.example/hooks` }
    });
    await expect(f.service.subscribe(alice, { ...input, delivery: { ...input.delivery, url: "https://extra.example/hooks" } })).rejects.toMatchObject({ code: -32013 });
  });

  it("validates canonical Standard Webhooks secrets at both size limits", () => {
    for (const size of [24, 32, 64]) expect(decodeSecret(`whsec_${randomBytes(size).toString("base64")}`)).toHaveLength(size);
    for (const size of [0, 23, 65]) expect(() => decodeSecret(`whsec_${randomBytes(size).toString("base64")}`)).toThrow();
    expect(() => decodeSecret(secret + "=" )).toThrow();
  });
});
