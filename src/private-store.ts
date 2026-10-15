import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { nanoid } from "nanoid";
import type { Db } from "./db.js";
import type { EventHub } from "./hub.js";
import type { AgentIdentity } from "./config.js";

export const ACTIVITY = "agents-chat.activity";
export const INBOX = "agents-chat.inbox";
export const PRESENCE = "agents-chat.presence";
export const RETENTION_MS = 24 * 60 * 60_000;
export const ownerId = (agent: AgentIdentity) => agent.ownerId ?? agent.id;
const stores = new WeakMap<Db, PrivateStore>();
export function privateStore(db: Db, hub: EventHub, key?: Buffer) {
  let store = stores.get(db);
  if (!store) { store = new PrivateStore(db, hub, key ?? randomBytes(32)); stores.set(db, store); }
  return store;
}
export type PrivateEventRow = { id: number; event_id: string; name: string; payload: string; occurred_at: string };

/** New tables deliberately do NOT import the old cross-account public history. */
export class PrivateStore {
  constructor(readonly db: Db, readonly hub: EventHub, private readonly key: Buffer) {
    if (key.length !== 32) throw new Error("Private event encryption requires a 32-byte key");
    db.exec(`
      create table if not exists account_channels (
        id text primary key, owner_id text not null, name text not null collate nocase,
        created_by text not null, created_at text not null, unique(owner_id, name)
      );
      create table if not exists private_config (name text primary key, value text not null);
      create table if not exists account_memberships (
        channel_id text not null references account_channels(id), agent_id text not null,
        agent_name text not null, joined_at text not null, primary key(channel_id, agent_id)
      );
      create table if not exists account_events (
        id integer primary key autoincrement, event_id text not null unique, owner_id text not null,
        name text not null, kind text not null, payload text not null, occurred_at text not null
      );
      create table if not exists account_event_recipients (
        event_row_id integer not null references account_events(id) on delete cascade,
        recipient_id text not null, primary key(event_row_id, recipient_id)
      );
      create index if not exists account_event_scope on account_events(owner_id, name, id);
      create index if not exists account_event_recipient on account_event_recipients(recipient_id, event_row_id);
      create table if not exists account_feed_positions (
        owner_id text not null, recipient_id text not null, name text not null,
        head integer not null, pruned_through integer not null default 0,
        primary key(owner_id, recipient_id, name)
      );
      create table if not exists runtime_agents (
        id text primary key, owner_id text not null, name text not null, description text not null,
        token_hash text not null unique, expires_at integer not null, created_at text not null, revoked_at integer
      );
      create index if not exists runtime_agent_owner on runtime_agents(owner_id, expires_at);
      create table if not exists runtime_listeners (
        agent_id text not null references runtime_agents(id) on delete cascade,
        listener_key text not null, mode text not null, expires_at integer not null,
        primary key(agent_id, listener_key)
      );
      create table if not exists ring_pairings (
        id text primary key, owner_id text not null, agent_id text not null references runtime_agents(id),
        name text not null, token_hash text not null unique, created_at text not null, revoked_at integer
      );
      create table if not exists private_idempotency (
        owner_id text not null, sender_id text not null, request_key text not null,
        fingerprint text not null, result_json text not null, expires_at integer not null,
        primary key(owner_id, sender_id, request_key)
      );
    `);
    const check = db.prepare(`select value from private_config where name = 'encryption_key_check'`).get() as { value: string } | undefined;
    if (check) {
      try { if (this.open(check.value, "encryption_key_check").ok !== true) throw new Error(); }
      catch { throw new Error("AGENTS_CHAT_ENCRYPTION_KEY does not match this database; restore the original key"); }
    } else db.prepare(`insert into private_config values ('encryption_key_check', ?)`).run(this.seal({ ok: true }, "encryption_key_check"));
    // Push streams and webhook leases cannot survive a process restart. Poll
    // listeners must re-establish liveness as well. Registrations do survive.
    db.exec("delete from runtime_listeners");
  }

  seal(value: unknown, context: string): string {
    const nonce = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, nonce);
    cipher.setAAD(Buffer.from(context));
    const encrypted = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
    return ["v1", nonce.toString("base64"), cipher.getAuthTag().toString("base64"), encrypted.toString("base64")].join(".");
  }

  open(payload: string, context: string): Record<string, unknown> {
    const [version, nonce, tag, encrypted] = payload.split(".");
    if (version !== "v1") throw new Error("Unknown private payload version");
    const decipher = createDecipheriv("aes-256-gcm", this.key, Buffer.from(nonce, "base64"));
    decipher.setAAD(Buffer.from(context));
    decipher.setAuthTag(Buffer.from(tag, "base64"));
    return JSON.parse(Buffer.concat([decipher.update(Buffer.from(encrypted, "base64")), decipher.final()]).toString("utf8"));
  }

  record(owner: string, name: string, kind: string, data: unknown, recipients: string[]) {
    const eventId = `event_${nanoid(20)}`;
    const occurredAt = new Date().toISOString();
    const result = this.db.prepare(`insert into account_events(event_id, owner_id, name, kind, payload, occurred_at) values (?, ?, ?, ?, ?, ?)`)
      .run(eventId, owner, name, kind, this.seal(data, eventId), occurredAt);
    const rowId = Number(result.lastInsertRowid);
    const insert = this.db.prepare(`insert into account_event_recipients values (?, ?)`);
    for (const id of new Set(recipients)) {
      insert.run(rowId, id);
      this.db.prepare(`insert into account_feed_positions(owner_id, recipient_id, name, head) values (?, ?, ?, ?)
        on conflict(owner_id, recipient_id, name) do update set head = excluded.head`).run(owner, id, name, rowId);
    }
    return { rowId, eventId, recipients, occurredAt };
  }

  publish(event: { rowId: number; recipients: string[] }) { this.hub.publish(event.recipients, event.rowId); }

  prune() {
    this.db.transaction(() => {
      const cutoff = new Date(Date.now() - RETENTION_MS).toISOString();
      this.db.prepare(`update account_feed_positions set pruned_through = max(pruned_through, coalesce((
        select max(e.id) from account_events e join account_event_recipients r on r.event_row_id = e.id
        where e.owner_id = account_feed_positions.owner_id and e.name = account_feed_positions.name
          and r.recipient_id = account_feed_positions.recipient_id and e.occurred_at < ?), 0))`).run(cutoff);
      this.db.prepare(`delete from account_events where occurred_at < ?`).run(cutoff);
      this.db.prepare(`delete from private_idempotency where expires_at <= ?`).run(Date.now());
      this.db.prepare(`delete from runtime_listeners where expires_at <= ?`).run(Date.now());
      // Expired runtime credentials and pairings are retained for at most the
      // replay window. This is not a message archive or indefinite identity log.
      this.db.prepare(`delete from ring_pairings where agent_id in (select id from runtime_agents where expires_at < ?)`)
        .run(Date.now() - RETENTION_MS);
      this.db.prepare(`delete from runtime_agents where expires_at < ?`).run(Date.now() - RETENTION_MS);
    })();
  }
}
