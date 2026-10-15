import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ServerContext } from "@modelcontextprotocol/server";
import { openDb } from "../src/db.js";
import { EventHub } from "../src/hub.js";
import { privateStore, INBOX, PRESENCE, RETENTION_MS } from "../src/private-store.js";
import { AgentService, AGENT_TTL_MS } from "../src/agents.js";
import { MessageService } from "../src/messages.js";
import { EventsService } from "../src/events.js";
import { WebhookService } from "../src/webhooks.js";
import { ChatService } from "../src/chat.js";
import { DebugLog } from "../src/debug-log.js";
import { RingService } from "../src/rings.js";

const owner = { id: "github-numeric-123", name: "owner" }, foreign = { id: "github-numeric-456", name: "same-login" };
const closes: Array<() => unknown> = [], directories: string[] = [];
afterEach(async () => { for (const close of closes.splice(0).reverse()) await close(); for (const path of directories.splice(0)) rmSync(path, { recursive: true }); vi.useRealTimers(); });
function setup(path = ":memory:", key = randomBytes(32)) {
  const db = openDb(path), hub = new EventHub(), store = privateStore(db, hub, key), debug = new DebugLog(db), agents = new AgentService(store, debug);
  closes.push(() => { if (db.open) db.close(); });
  const events = new EventsService(db, hub, debug, agents), messages = new MessageService(store, agents, debug), chat = new ChatService(db, hub, undefined, debug);
  const rings = new RingService(store, agents, messages, "https://chat.example");
  const a = agents.register(owner, "alpha", "planner"), b = agents.register(owner, "beta", "implementer"), c = agents.register(foreign, "alpha", "foreign");
  const input = (token = b.agentToken, cursor: string | null = b.inbox.cursor) => ({ name: INBOX, arguments: { agentToken: token }, cursor });
  return { db, hub, store, debug, agents, messages, events, chat, rings, a, b, c, input };
}

describe("private runtime identities", () => {
  it("requires an inbox listener, expires quiet polling presence, and refreshes on a real poll lease", () => {
    vi.useFakeTimers(); const f = setup();
    expect(f.agents.list(owner)).toEqual([]);
    f.events.listen(owner, f.input(), "poll", "poll", Date.now() + 60_000);
    expect(f.agents.list(owner)).toMatchObject([{ id: f.b.agent.id, description: "implementer", deliveryModes: ["poll"] }]);
    vi.advanceTimersByTime(59_000);
    f.events.listen(owner, f.input(), "poll", "poll", Date.now() + 60_000);
    vi.advanceTimersByTime(59_000); expect(f.agents.list(owner)).toHaveLength(1);
    vi.advanceTimersByTime(1001); expect(f.agents.list(owner)).toEqual([]);
    const presence = f.events.poll(owner, { name: PRESENCE, cursor: "private-event:0" });
    expect(presence.events.map((e) => e.data.kind)).toEqual(["agent.registered", "agent.registered", "agent.online", "agent.offline"]);
    expect(f.events.poll(foreign, { name: PRESENCE, cursor: "private-event:0" }).events).toHaveLength(1);
  });

  it("keeps multiple listeners independent and requires the account plus the registration credential", () => {
    const f = setup(), listener = f.agents.resolve(owner, f.b.agentToken);
    f.agents.listen(listener, "one", "push", Date.now() + 60_000); f.agents.listen(listener, "two", "webhook", Date.now() + 60_000);
    f.agents.unlisten(listener, "one"); expect(f.agents.list(owner)[0].deliveryModes).toEqual(["webhook"]);
    expect(() => f.agents.resolve(foreign, f.b.agentToken)).toThrow("not found");
    expect(() => f.agents.resolve(owner, f.b.agent.id)).toThrow("not found");
    expect(() => f.messages.send(foreign, f.c.agentToken, f.b.agent.id, "foreign", "key")).toThrow("not found");
    expect(() => f.events.poll(foreign, f.input())).toThrow("NotFound");
  });

  it("renews registration separately from listening and rejects all operations after registration expiry", () => {
    vi.useFakeTimers(); const f = setup();
    vi.advanceTimersByTime(AGENT_TTL_MS - 1000); const renewal = f.agents.renew(owner, f.a.agentToken);
    vi.advanceTimersByTime(1001);
    expect(() => f.agents.resolve(owner, f.a.agentToken)).not.toThrow();
    expect(Date.parse(renewal.expiresAt)).toBeGreaterThan(Date.now());
    expect(() => f.agents.resolve(owner, f.b.agentToken)).toThrow("expired");
    expect(() => f.messages.send(owner, f.a.agentToken, f.b.agent.id, "expired", "key")).toThrow("expired");
    expect(() => f.agents.renew(owner, f.b.agentToken)).toThrow("expired");
  });

  it("terminates a revoked push stream without delivering later inbox messages", async () => {
    const f = setup(), controller = new AbortController(), notifications: any[] = [];
    const ctx = { mcpReq: { id: "live", signal: controller.signal, notify: async (value: unknown) => { notifications.push(value); } } } as unknown as ServerContext;
    const streaming = f.events.stream(owner, f.input(), ctx);
    await vi.waitFor(() => expect(notifications[0]?.method).toBe("notifications/events/active"));
    f.agents.unregister(owner, f.b.agentToken); await streaming;
    expect(notifications.at(-1).method).toBe("notifications/events/terminated");
    expect(f.agents.list(owner)).toEqual([]);
    expect(() => f.events.poll(owner, f.input())).toThrow("NotFound");
  });
});

describe("private delivery and storage", () => {
  it("encrypts every new payload and omits text and credentials from diagnostic records", () => {
    const f = setup(), secretText = "private transcript marker 98765";
    f.messages.send(owner, f.a.agentToken, f.b.agent.id, secretText, "same-key");
    const channel = f.chat.createChannel(f.agents.resolve(owner, f.a.agentToken), "private");
    f.chat.postMessage(f.agents.resolve(owner, f.a.agentToken), channel.id, secretText);
    for (const table of ["account_events", "debug_events", "private_idempotency", "runtime_agents"]) {
      const raw = JSON.stringify(f.db.prepare(`select * from ${table}`).all());
      expect(raw).not.toContain(secretText); expect(raw).not.toContain(f.a.agentToken); expect(raw).not.toContain(f.b.agentToken);
    }
    expect(f.events.poll(owner, f.input()).events[0].data).toMatchObject({ message: { text: secretText } });
    const row = f.db.prepare(`select id, payload from account_events where name = ?`).get(INBOX) as any;
    f.db.prepare(`update account_events set payload = ? where id = ?`).run(row.payload.slice(0, -5) + "AAAAA", row.id);
    expect(() => f.events.poll(owner, f.input())).toThrow();
  });

  it("does not lose a message sent between registration and first listener establishment", () => {
    const f = setup(); const sent = f.messages.send(owner, f.a.agentToken, f.b.agent.id, "before subscribe", "gap");
    expect(f.events.poll(owner, f.input()).events.map((e) => e.eventId)).toEqual([sent.eventId]);
  });

  it("deduplicates identical retries and rejects conflicting keys without spending quota", () => {
    const f = setup(); const first = f.messages.send(owner, f.a.agentToken, f.b.agent.id, "retry", "key");
    const before = f.db.prepare(`select * from chat_rate_limits`).all();
    expect(f.messages.send(owner, f.a.agentToken, f.b.agent.id, "retry", "key")).toMatchObject({ eventId: first.eventId, duplicate: true });
    expect(() => f.messages.send(owner, f.a.agentToken, f.b.agent.id, "changed", "key")).toThrow("different content");
    expect(f.db.prepare(`select * from chat_rate_limits`).all()).toEqual(before);
    expect(f.events.poll(owner, f.input()).events).toHaveLength(1);
  });

  it("shares the posting budget across direct messages, channel posts, and agent credentials", () => {
    const f = setup(), actor = f.agents.resolve(owner, f.a.agentToken), channel = f.chat.createChannel(actor, "quota");
    for (let i = 0; i < 60; i++) f.messages.send(owner, i % 2 ? f.a.agentToken : f.b.agentToken, f.b.agent.id, "quota", `key-${i}`);
    expect(() => f.chat.postMessage(actor, channel.id, "blocked")).toThrow("rate limit");
    expect(f.events.poll(owner, f.input()).events).toHaveLength(50);
    expect(f.agents.list(owner)).toEqual([]); // Internal replay does not invent presence.
  });

  it("preserves the public legacy tables but never imports their memberships or payloads", () => {
    const f = setup();
    f.db.prepare(`insert into channels values ('old-channel', 'old-public', ?, ?)`).run(owner.id, new Date().toISOString());
    f.db.prepare(`insert into memberships values ('old-channel', ?, 'owner', ?)`).run(owner.id, new Date().toISOString());
    f.db.prepare(`insert into chat_events(event_id, channel_id, kind, data_json, occurred_at) values ('legacy-event', 'old-channel', 'message.posted', '{"text":"public history"}', ?)`)
      .run(new Date().toISOString());
    f.db.prepare(`insert into event_recipients values (1, ?)`).run(owner.id);
    expect(f.chat.listChannels(owner)).toEqual([]); expect(() => f.chat.joinChannel(owner, "old-channel")).toThrow("not found");
    expect(f.events.poll(owner, { name: "agents-chat.activity", cursor: "private-event:0" }).events).toEqual([]);
    expect(f.db.prepare(`select count(*) as n from chat_events`).get()).toEqual({ n: 1 });
  });

  it("prunes the replay window and signals a cursor gap even when the feed is empty", () => {
    vi.useFakeTimers(); const f = setup();
    f.messages.send(owner, f.a.agentToken, f.b.agent.id, "expired history", "key");
    vi.advanceTimersByTime(RETENTION_MS + 1); f.store.prune();
    // Use a still-valid runtime credential to test this feed's pruning watermark.
    f.db.prepare(`update runtime_agents set expires_at = ?`).run(Date.now() + AGENT_TTL_MS);
    const replay = f.events.poll(owner, f.input()); expect(replay.truncated).toBe(true); expect(replay.events).toEqual([]);
    expect(replay.cursor).not.toBe("private-event:0");
  });

  it("persists registrations and encrypted replay over restart but not listening leases", () => {
    const directory = mkdtempSync(join(tmpdir(), "private-chat-restart-")); directories.push(directory);
    const path = join(directory, "chat.db"), key = randomBytes(32), f = setup(path, key);
    f.messages.send(owner, f.a.agentToken, f.b.agent.id, "restart replay", "key");
    f.events.listen(owner, f.input(), "poll", "poll", Date.now() + 60_000); expect(f.agents.list(owner)).toHaveLength(1);
    f.db.close();
    const db = openDb(path), hub = new EventHub(), store = privateStore(db, hub, key), agents = new AgentService(store), events = new EventsService(db, hub, undefined, agents);
    closes.push(() => db.close());
    expect(agents.list(owner)).toEqual([]); expect(events.poll(owner, f.input()).events[0].data).toMatchObject({ message: { text: "restart replay" } });
    const wrongDb = openDb(path); closes.push(() => wrongDb.close());
    expect(() => privateStore(wrongDb, new EventHub(), randomBytes(32))).toThrow("does not match");
  });

  it("keeps webhook presence until lease expiry and cancels delivery when unregistered", async () => {
    vi.useFakeTimers(); const f = setup(); let count = 0;
    const service = new WebhookService(f.events, f.hub, { async post(_url, raw) { const body = JSON.parse(raw); if (body.eventId) count++; return { status: 200, body: JSON.stringify({ challenge: body.challenge }) }; } });
    closes.push(() => service.close());
    const input = { ...f.input(), ttlMs: 60_000, delivery: { mode: "webhook", url: "https://receiver.example/hook", secret: `whsec_${randomBytes(32).toString("base64")}` } };
    await service.subscribe(owner, input); expect(f.agents.list(owner)[0].deliveryModes).toEqual(["webhook"]);
    vi.advanceTimersByTime(59_000); await service.subscribe(owner, input); vi.advanceTimersByTime(59_000); expect(f.agents.list(owner)).toHaveLength(1);
    f.agents.unregister(owner, f.b.agentToken); await vi.advanceTimersByTimeAsync(0); expect(count).toBe(0); expect(f.agents.list(owner)).toEqual([]);
    expect(() => f.messages.send(owner, f.a.agentToken, f.b.agent.id, "revoked", "key")).toThrow("expired");
  });

  it("rejects cross-account ring pairing and accepts only the narrow pairing credential", async () => {
    const f = setup(); expect(() => f.rings.pair(foreign, f.b.agent.id, "foreign")).toThrow("not found");
    const pairing = f.rings.pair(owner, f.b.agent.id, "Ring");
    const path = new URL(pairing.webhookUrl).pathname.replace("/api/rings", "");
    const post = (token: string, text: string) => f.rings.app.request(path, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify({ message_id: "ring-source-key", recorded_at: new Date().toISOString(), transcript: text }) });
    expect((await post(f.a.agentToken, "wrong token type")).status).toBe(401);
    expect((await post(pairing.ingestToken, "x".repeat(8000))).status).toBe(202);
    expect((await post(pairing.ingestToken, "changed")).status).toBe(409);
    expect((await post(pairing.ingestToken, "x".repeat(8001))).status).toBe(400);
    const event = f.events.poll(owner, f.input()).events[0]; expect(event.data.source).toBe("ring");
    expect(() => f.rings.unpair(foreign, pairing.pairingId)).toThrow("not found");
    f.agents.unregister(owner, f.b.agentToken); expect((await post(pairing.ingestToken, "revoked")).status).toBe(401);
  });
});
