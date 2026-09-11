import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openDb, type Db } from "../src/db.js";
import { ChatService } from "../src/chat.js";
import { EventHub } from "../src/hub.js";
import { ChatRateLimiter, RateLimitError } from "../src/rate-limits.js";

const databases: Db[] = [];
const directories: string[] = [];
const alice = { id: "user_alice", name: "alice" };
const bob = { id: "user_bob", name: "bob" };
afterEach(() => {
  for (const db of databases.splice(0)) if (db.open) db.close();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function setup(path = ":memory:") {
  const db = openDb(path);
  databases.push(db);
  let now = Date.parse("2026-09-10T12:00:00Z");
  const rateLimits = new ChatRateLimiter(db, () => now);
  const hub = new EventHub();
  const published = vi.spyOn(hub, "publish");
  const chat = new ChatService(db, hub, rateLimits);
  return { db, rateLimits, chat, published, advance: (ms: number) => { now += ms; } };
}

function snapshot(db: Db) {
  return db.prepare(`select * from chat_rate_limits order by principal_id, bucket`).all();
}

describe("persistent account rate limits", () => {
  it("limits a burst and refills exactly one message token per second", () => {
    const f = setup();
    for (let i = 0; i < 60; i++) f.rateLimits.consume(alice.id, "messages_post");
    const before = snapshot(f.db);
    expect(() => f.rateLimits.consume(alice.id, "messages_post")).toThrowError(expect.objectContaining({
      code: "rate_limited", action: "messages_post", retryAfterMs: 1000,
      limits: [{ capacity: 60, periodMs: 60_000 }]
    }));
    expect(snapshot(f.db)).toEqual(before);
    f.advance(999);
    expect(() => f.rateLimits.consume(alice.id, "messages_post")).toThrowError(expect.objectContaining({ retryAfterMs: 1 }));
    f.advance(1);
    expect(() => f.rateLimits.consume(alice.id, "messages_post")).not.toThrow();
    expect(() => f.rateLimits.consume(alice.id, "messages_post")).toThrow(RateLimitError);
  });

  it("applies the longer message budget even when the short bucket has refilled", () => {
    const f = setup();
    let blocked: RateLimitError | undefined;
    for (let i = 0; i < 2000; i++) {
      try { f.rateLimits.consume(alice.id, "messages_post"); }
      catch (error) { blocked = error as RateLimitError; break; }
      f.advance(1000);
    }
    expect(blocked).toBeInstanceOf(RateLimitError);
    expect(blocked!.limits).toEqual([{ capacity: 1000, periodMs: 3_600_000 }]);
    expect(blocked!.retryAfterMs).toBeGreaterThan(0);
    f.advance(blocked!.retryAfterMs);
    expect(() => f.rateLimits.consume(alice.id, "messages_post")).not.toThrow();
  });

  it("enforces hourly and daily channel-creation buckets independently", () => {
    const f = setup();
    for (let i = 0; i < 5; i++) f.rateLimits.consume(alice.id, "channels_create");
    expect(() => f.rateLimits.consume(alice.id, "channels_create")).toThrowError(expect.objectContaining({ retryAfterMs: 720_000 }));
    let dailyBlocked: RateLimitError | undefined;
    for (let hour = 0; hour < 8 && !dailyBlocked; hour++) {
      f.advance(3_600_000);
      for (let i = 0; i < 5; i++) {
        try { f.rateLimits.consume(alice.id, "channels_create"); }
        catch (error) { dailyBlocked = error as RateLimitError; break; }
      }
    }
    expect(dailyBlocked?.limits).toContainEqual({ capacity: 20, periodMs: 86_400_000 });
  });

  it("keeps account and operation budgets independent", () => {
    const f = setup();
    for (let i = 0; i < 60; i++) f.rateLimits.consume(alice.id, "messages_post");
    expect(() => f.rateLimits.consume(bob.id, "messages_post")).not.toThrow();
    expect(() => f.rateLimits.consume(alice.id, "channels_create")).not.toThrow();
    expect(() => f.rateLimits.consume(alice.id, "channels_join")).not.toThrow();
  });

  it("does not reset budgets at wall-clock boundaries or when the clock goes backwards", () => {
    const f = setup();
    f.advance(59_999);
    for (let i = 0; i < 60; i++) f.rateLimits.consume(alice.id, "messages_post");
    f.advance(1);
    expect(() => f.rateLimits.consume(alice.id, "messages_post")).toThrowError(expect.objectContaining({ retryAfterMs: 999 }));
    f.advance(-5000);
    expect(() => f.rateLimits.consume(alice.id, "messages_post")).toThrowError(expect.objectContaining({ retryAfterMs: 5999 }));
    f.advance(86_400_000);
    for (let i = 0; i < 60; i++) f.rateLimits.consume(alice.id, "messages_post");
    expect(snapshot(f.db)).toHaveLength(2);
    expect(() => f.rateLimits.consume(alice.id, "messages_post")).toThrow(RateLimitError);
  });

  it("shares counters across database connections and preserves them after reopening", () => {
    const directory = mkdtempSync(join(tmpdir(), "agents-chat-rate-test-"));
    directories.push(directory);
    const path = join(directory, "chat.sqlite");
    const first = setup(path);
    const second = setup(path);
    for (let i = 0; i < 60; i++) (i % 2 ? first : second).rateLimits.consume(alice.id, "messages_post");
    expect(() => first.rateLimits.consume(alice.id, "messages_post")).toThrow(RateLimitError);
    expect(() => second.rateLimits.consume(alice.id, "messages_post")).toThrow(RateLimitError);
    first.db.close(); second.db.close();
    const reopened = setup(path);
    expect(() => reopened.rateLimits.consume(alice.id, "messages_post")).toThrow(RateLimitError);
    reopened.advance(1000);
    expect(() => reopened.rateLimits.consume(alice.id, "messages_post")).not.toThrow();
  });
});

describe("rate-limited chat mutations", () => {
  it("does not write messages, events, recipients, or publish when limited", () => {
    const f = setup();
    const channel = f.chat.createChannel(alice, "test");
    for (let i = 0; i < 60; i++) f.chat.postMessage(alice, channel.id, `message ${i}`);
    const calls = f.published.mock.calls.length;
    expect(() => f.chat.postMessage({ ...alice, name: "renamed" }, channel.id, "blocked")).toThrow(RateLimitError);
    expect(f.db.prepare(`select count(*) as count from messages`).get()).toEqual({ count: 60 });
    expect(f.db.prepare(`select count(*) as count from chat_events`).get()).toEqual({ count: 61 });
    expect(f.db.prepare(`select count(*) as count from event_recipients`).get()).toEqual({ count: 61 });
    expect(f.published).toHaveBeenCalledTimes(calls);
    expect(f.chat.listChannels(alice)).toHaveLength(1);
  });

  it("does not spend quota on invalid, unauthorized, duplicate, or no-op actions", () => {
    const f = setup();
    const channel = f.chat.createChannel(alice, "test");
    const before = snapshot(f.db);
    expect(() => f.chat.createChannel(alice, "test")).toThrow("already exists");
    expect(() => f.chat.postMessage(alice, channel.id, "x".repeat(201))).toThrow("1-200");
    expect(() => f.chat.postMessage(bob, channel.id, "not joined")).toThrow("Join the channel");
    expect(() => f.chat.joinChannel(bob, "missing")).toThrow("not found");
    expect(f.chat.joinChannel(alice, channel.id).alreadyJoined).toBe(true);
    expect(snapshot(f.db)).toEqual(before);
  });

  it("rolls back quota alongside a database failure", () => {
    const f = setup();
    const channel = f.chat.createChannel(alice, "test");
    const before = snapshot(f.db);
    f.db.exec(`create trigger fail_message_event before insert on chat_events
      when new.kind = 'message.posted' begin select raise(abort, 'injected failure'); end;`);
    expect(() => f.chat.postMessage(alice, channel.id, "rolled back")).toThrow("injected failure");
    expect(snapshot(f.db)).toEqual(before);
    expect(f.db.prepare(`select count(*) as count from messages`).get()).toEqual({ count: 0 });
    expect(f.published).toHaveBeenCalledTimes(1);
  });

  it("limits new channels without creating their membership or event", () => {
    const f = setup();
    for (let i = 0; i < 5; i++) f.chat.createChannel(alice, `test-${i}`);
    expect(() => f.chat.createChannel(alice, "blocked")).toThrow(RateLimitError);
    expect(f.chat.listChannels(alice)).toHaveLength(5);
    expect(f.db.prepare(`select count(*) as count from memberships`).get()).toEqual({ count: 5 });
    expect(f.published).toHaveBeenCalledTimes(5);
  });

  it("limits new joins but keeps repeat joins idempotent even while exhausted", () => {
    const f = setup();
    const channels = Array.from({ length: 31 }, (_, i) => f.chat.createChannel({ id: `owner-${i}`, name: "owner" }, `test-${i}`));
    for (const channel of channels.slice(0, 30)) f.chat.joinChannel(alice, channel.id);
    const before = snapshot(f.db);
    const calls = f.published.mock.calls.length;
    expect(() => f.chat.joinChannel(alice, channels[30].id)).toThrowError(expect.objectContaining({ retryAfterMs: 2000 }));
    expect(f.chat.joinChannel(alice, channels[0].id).alreadyJoined).toBe(true);
    expect(snapshot(f.db)).toEqual(before);
    expect(f.published).toHaveBeenCalledTimes(calls);
    f.advance(2000);
    expect(f.chat.joinChannel(alice, channels[30].id).alreadyJoined).toBe(false);
  });
});
