import { randomBytes } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ServerContext } from "@modelcontextprotocol/server";
import { createApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { openDb } from "../src/db.js";
import { DebugLog } from "../src/debug-log.js";
import { ChatService } from "../src/chat.js";
import { EventsService, CHAT_ACTIVITY_EVENT } from "../src/events.js";
import { EventHub } from "../src/hub.js";
import { WebhookService } from "../src/webhooks.js";

const cleanups: Array<() => unknown> = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); vi.restoreAllMocks(); vi.useRealTimers(); });
const base = "https://chat.example.test";
const alice = { id: "alice", name: "Alice" };
const bob = { id: "bob", name: "Bob", ownerId: alice.id };

function setup(ids = "1234", githubId = 1234) {
  const config = loadConfig({ PUBLIC_BASE_URL: base, DATABASE_URL: ":memory:",
    GITHUB_CLIENT_ID: "test-client", GITHUB_CLIENT_SECRET: "test-secret", AGENTS_CHAT_DEBUG_GITHUB_IDS: ids });
  const github = { identify: vi.fn(async () => ({ id: githubId, login: "debug-owner" })) };
  const fixture = createApp(config, { github });
  cleanups.push(() => fixture.close());
  return { ...fixture, config, github };
}
async function beginLogin(f: ReturnType<typeof setup>) {
  const login = await f.app.request("/debug/login");
  expect(login.status).toBe(302);
  const cookie = login.headers.get("set-cookie")!.split(";")[0];
  const authorize = await f.app.request(login.headers.get("location")!);
  const state = new URL(authorize.headers.get("location")!).searchParams.get("state")!;
  const consent = await f.app.request(`/oauth/github/callback?state=${state}&code=github-test-code`);
  const approval = /name="approval_token" value="([^"]+)"/.exec(await consent.text())![1];
  const approved = await f.app.request("/oauth/approve", { method: "POST",
    body: new URLSearchParams({ transaction_id: state, approval_token: approval, decision: "allow" }) });
  return { cookie, url: approved.headers.get("location")!, login };
}
async function login(f: ReturnType<typeof setup>) {
  const start = await beginLogin(f);
  const callback = await f.app.request(start.url, { headers: { Cookie: start.cookie } });
  const cookies = callback.headers.getSetCookie();
  const cookie = cookies.find((c) => c.startsWith("__Secure-agents_chat_debug="))?.split(";")[0];
  return { ...start, callback, cookie, cookies };
}
function services() {
  const db = openDb(":memory:");
  const hub = new EventHub();
  const log = new DebugLog(db);
  const chat = new ChatService(db, hub, undefined, log);
  const events = new EventsService(db, hub, log);
  cleanups.push(() => db.close());
  return { db, hub, log, chat, events };
}

describe("administrator debug view", () => {
  it("is disabled by default and accepts numeric account IDs only", async () => {
    const f = setup("");
    for (const path of ["/debug", "/debug/login", "/debug/api/events", "/debug/debug.js"]) {
      expect((await f.app.request(path)).status).toBe(404);
    }
    expect(() => setup("sarfata")).toThrow("numeric GitHub account IDs");
  });

  it("has no homepage/guide link and exposes no activity before sign-in", async () => {
    const f = setup();
    for (const path of ["/", "/agents.md"]) expect(await (await f.app.request(path)).text()).not.toContain("/debug");
    const shell = await f.app.request("/debug");
    expect(shell.status).toBe(200);
    expect(shell.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    expect(shell.headers.get("cache-control")).toBe("no-store");
    expect(shell.headers.get("x-robots-tag")).toBe("noindex, nofollow");
    expect((await f.app.request("/debug/api/events")).status).toBe(401);
  });

  it("completes PKCE sign-in once, authorizes by stable ID, and keeps credentials HttpOnly", async () => {
    const f = setup();
    const auth = await login(f);
    expect(auth.callback.status).toBe(302);
    expect(auth.callback.headers.get("location")).toBe("/debug");
    const session = auth.cookies.find((c) => c.startsWith("__Secure-agents_chat_debug="))!;
    for (const flag of ["HttpOnly", "Secure", "SameSite=Lax", "Path=/debug", "Max-Age=3600"]) expect(session).toContain(flag);
    expect(f.db.prepare(`select count(*) as count from oauth_refresh_tokens`).get()).toEqual({ count: 0 });
    const response = await f.app.request("/debug/api/events", { headers: { Cookie: auth.cookie! } });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.viewer).toBe("debug-owner");
    expect(body.events.map((e: any) => e.kind)).toEqual(["server.started", "agent.registered"]);
    expect(JSON.stringify(body)).not.toMatch(/test-secret|github-test-code|ac_|rf_|code_verifier/);
    expect((await f.app.request(auth.url, { headers: { Cookie: auth.cookie! } })).status).toBe(400);
    f.db.prepare(`update users set display_name = 'renamed-account'`).run();
    expect((await (await f.app.request("/debug/api/events", { headers: { Cookie: auth.cookie! } })).json()).viewer).toBe("renamed-account");
    f.config.debugGithubIds = ["5678"];
    expect((await f.app.request("/debug/api/events", { headers: { Cookie: auth.cookie! } })).status).toBe(403);
  });

  it("denies other GitHub identities even with the same display name, and removes their issued tokens", async () => {
    const f = setup("1234", 5678);
    const auth = await login(f);
    expect(auth.callback.status).toBe(403);
    expect(auth.cookie).toBeUndefined();
    expect(f.db.prepare(`select count(*) as count from oauth_access_tokens`).get()).toEqual({ count: 0 });
    expect(f.db.prepare(`select count(*) as count from oauth_refresh_tokens`).get()).toEqual({ count: 0 });
  });

  it("rejects mismatched, missing, expired browser state and an incorrect issuer", async () => {
    const f = setup();
    const start = await beginLogin(f);
    expect((await f.app.request(start.url)).status).toBe(400);
    expect((await f.app.request(start.url, { headers: { Cookie: start.cookie + "wrong" } })).status).toBe(400);
    const wrongIssuer = new URL(start.url); wrongIssuer.searchParams.set("iss", "https://evil.example");
    expect((await f.app.request(wrongIssuer.toString(), { headers: { Cookie: start.cookie } })).status).toBe(400);
    const expired = await beginLogin(f);
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 11 * 60_000);
    expect((await f.app.request(expired.url, { headers: { Cookie: expired.cookie } })).status).toBe(400);
    expect(f.db.prepare(`select count(*) as count from oauth_access_tokens`).get()).toEqual({ count: 0 });
  });

  it("requires the session cookie, validates cursors, enforces expiry, and revokes on same-origin logout", async () => {
    const f = setup();
    const auth = await login(f);
    const headers = { Cookie: auth.cookie! };
    const token = auth.cookie!.split("=")[1];
    expect((await f.app.request("/debug/api/events", { headers: { Authorization: `Bearer ${token}` } })).status).toBe(401);
    for (const query of ["after=-1", "after=wat", "after=1.2", "after=9007199254740992", "limit=0", "limit=501"]) {
      expect((await f.app.request(`/debug/api/events?${query}`, { headers })).status).toBe(400);
    }
    expect((await f.app.request("/debug/api/events?after=0&limit=1", { headers })).status).toBe(200);
    expect((await f.app.request("/debug/logout", { method: "POST", headers: { ...headers, Origin: "https://evil.example" } })).status).toBe(403);
    for (const site of ["cross-site", "same-site", "none"]) {
      expect((await f.app.request("/debug/logout", { method: "POST", headers: { ...headers, Origin: "null", "Sec-Fetch-Site": site } })).status).toBe(403);
    }
    expect((await f.app.request("/debug/logout", { method: "POST", headers: { ...headers, Origin: "null" } })).status).toBe(403);
    expect((await f.app.request("/debug/logout", { method: "POST", headers: { ...headers, Origin: base } })).status).toBe(303);
    expect((await f.app.request("/debug/api/events", { headers })).status).toBe(401);
    const again = await login(f);
    f.db.prepare(`update oauth_access_tokens set expires_at = '2000-01-01T00:00:00.000Z'`).run();
    expect((await f.app.request("/debug/api/events", { headers: { Cookie: again.cookie! } })).status).toBe(401);
    const third = await login(f);
    expect((await f.app.request("/debug/logout", { method: "POST", headers: { Cookie: third.cookie!, Origin: "null", "Sec-Fetch-Site": "same-origin" } })).status).toBe(303);
    expect((await f.app.request("/debug/api/events", { headers: { Cookie: third.cookie! } })).status).toBe(401);
  });
});

describe("bounded activity recording", () => {
  it("captures committed event metadata without retaining private message text", () => {
    const f = services();
    const channel = f.chat.createChannel(alice, "test");
    f.chat.joinChannel(bob, channel.id);
    f.chat.joinChannel(bob, channel.id);
    f.chat.postMessage(bob, channel.id, "<script>untrusted message</script>");
    expect(() => f.chat.createChannel(alice, "test")).toThrow();
    expect(() => f.chat.postMessage(alice, channel.id, "a".repeat(201))).toThrow();
    const result = f.log.read();
    expect(result.events.map((e) => e.kind)).toEqual(["channel.created", "member.joined", "message.posted"]);
    expect(result.events[2].details.message).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain("<script>untrusted message</script>");
    expect(result.events[2].details.eventId).toBe((f.db.prepare(`select event_id from account_events order by id desc limit 1`).get() as any).event_id);
  });

  it("retains a bounded window across logger recreation with incremental cursors and gap detection", () => {
    const f = services();
    const log = new DebugLog(f.db, 3);
    for (let i = 0; i < 5; i++) log.record("events.polled", { mode: "poll", count: i });
    const current = new DebugLog(f.db, 3);
    expect(current.read().events.map((e) => e.id)).toEqual([3, 4, 5]);
    expect(current.read(1)).toMatchObject({ reset: true, retained: 3, cursor: 5 });
    expect(current.read(99)).toMatchObject({ reset: true, cursor: 5 });
    expect(current.read(3, 1)).toMatchObject({ cursor: 4, hasMore: true, reset: false });
    expect(current.read(5)).toMatchObject({ cursor: 5, events: [], hasMore: false });
    expect(() => current.read(-1)).toThrow();
  });

  it("strips non-allowlisted fields and never throws on logging failure", () => {
    const f = services();
    f.log.record("subscription.created", { actor: { ...alice, token: "private" }, mode: "webhook", secret: "private", url: "https://private", headers: {} } as any);
    expect(f.log.read().events[0].details).toEqual({ actor: alice, mode: "webhook" });
    vi.spyOn(console, "error").mockImplementation(() => {});
    f.log.record("delivery.failed", { reason: "an arbitrary secret error" } as any);
    expect(f.log.read().recordingFailures).toBe(1);
    f.db.exec("drop table debug_events");
    expect(() => f.chat.createChannel(alice, "still-works")).not.toThrow();
  });

  it("records push creation, transport handoff, cancellation and errors without phantom subscriptions", async () => {
    const f = services();
    const channel = f.chat.createChannel(alice, "stream");
    const abort = new AbortController();
    const notify = vi.fn(async (_message: unknown) => {});
    const ctx = { mcpReq: { id: "request-id", signal: abort.signal, notify } } as unknown as ServerContext;
    const stream = f.events.stream(alice, { name: CHAT_ACTIVITY_EVENT }, ctx);
    await vi.waitFor(() => expect(notify).toHaveBeenCalledTimes(1));
    f.chat.postMessage(alice, channel.id, "hello push");
    await vi.waitFor(() => expect(notify).toHaveBeenCalledTimes(2));
    abort.abort(); await stream;
    expect(f.log.read().events.filter((e) => e.details.mode === "push").map((e) => e.kind))
      .toEqual(["subscription.created", "delivery.sent", "subscription.closed"]);
    expect(f.log.read().events.at(-1)?.details.reason).toBe("cancelled");
    const failedCtx = { mcpReq: { id: "request-id", signal: new AbortController().signal, notify: async () => { throw new Error("private transport error"); } } } as unknown as ServerContext;
    await f.events.stream(alice, { name: CHAT_ACTIVITY_EVENT }, failedCtx);
    expect(f.log.read().events.at(-1)).toMatchObject({ kind: "delivery.failed", details: { reason: "transport_error" } });
    const before = f.log.read().retained;
    await f.events.stream(alice, { name: CHAT_ACTIVITY_EVENT }, ctx); // Already aborted.
    expect(f.log.read().retained).toBe(before);
    expect(JSON.stringify(f.log.read())).not.toContain("private transport error");
  });

  it("records webhook renewals, expiry, verification errors, retries and abandonment without credentials", async () => {
    vi.useFakeTimers();
    const f = services();
    const channel = f.chat.createChannel(alice, "webhook");
    let status = 503, rejectVerification = false;
    const client = { post: vi.fn(async (_url: string, raw: string) => {
      const body = JSON.parse(raw);
      return body.type === "verification"
        ? { status: 200, body: JSON.stringify({ challenge: rejectVerification ? "private challenge" : body.challenge }) }
        : { status, body: "private receiver response" };
    }) };
    const service = new WebhookService(f.events, f.hub, client, f.log);
    cleanups.push(() => service.close());
    const input = { name: CHAT_ACTIVITY_EVENT, ttlMs: 60_000, delivery: { mode: "webhook", url: "https://receiver.example/secret-path?token=private", secret: `whsec_${randomBytes(32).toString("base64")}` } };
    await service.subscribe(alice, input);
    f.chat.postMessage(alice, channel.id, "hello webhook");
    await vi.advanceTimersByTimeAsync(0);
    status = 200;
    await vi.advanceTimersByTimeAsync(1000);
    await service.subscribe(alice, input);
    expect(f.log.read().events.filter((e) => e.details.mode === "webhook").map((e) => e.kind)).toEqual([
      "webhook.verified", "subscription.created", "delivery.attempted", "delivery.failed", "delivery.retry_scheduled", "delivery.attempted", "delivery.sent", "subscription.renewed"
    ]);
    status = 410;
    f.chat.postMessage(alice, channel.id, "no retry");
    await vi.advanceTimersByTimeAsync(500);
    expect(f.log.read().events.at(-1)?.kind).toBe("delivery.abandoned");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(f.log.read().events.at(-1)).toMatchObject({ kind: "subscription.expired", details: { reason: "expired" } });
    expect(f.log.read().events.filter((e) => e.kind === "subscription.expired")).toHaveLength(1);
    await service.subscribe(alice, input);
    await service.unsubscribe(alice, input);
    expect(f.log.read().events.at(-1)).toMatchObject({ kind: "subscription.closed", details: { reason: "unsubscribed" } });
    rejectVerification = true;
    await expect(service.subscribe({ id: "other-account", name: "Other" }, input)).rejects.toThrow();
    expect(f.log.read().events.at(-1)?.kind).toBe("webhook.verification_failed");
    expect(f.log.read().recordingFailures).toBe(0);
    const serialized = JSON.stringify(f.log.read());
    for (const secret of [input.delivery.url, input.delivery.secret, "private receiver response", "private challenge", "secret-path"]) expect(serialized).not.toContain(secret);
    expect(f.log.read().events.some((e) => e.kind === "events.polled")).toBe(false); // Internal webhook reads aren't client polls.
  });

  it("captures client polls as stateless reads without inventing leases", async () => {
    const f = setup();
    const auth = await login(f);
    const token = auth.cookie!.split("=")[1];
    const response = await f.app.request("/mcp", { method: "POST", headers: {
      Authorization: `Bearer ${token}`, Accept: "application/json, text/event-stream", "Content-Type": "application/json", Host: "chat.example.test"
    }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "events/poll", params: { name: CHAT_ACTIVITY_EVENT } }) });
    expect(response.status).toBe(200); await response.text();
    const rows = f.db.prepare(`select kind, details_json from debug_events where kind = 'events.polled'`).all() as any[];
    expect(rows).toHaveLength(1);
    expect(JSON.parse(rows[0].details_json)).toMatchObject({ mode: "poll", count: 0 });
    expect(rows[0].details_json).not.toContain("expiresAt");
  });
});
