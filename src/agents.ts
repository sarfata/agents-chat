import { createHash, randomBytes } from "node:crypto";
import { nanoid } from "nanoid";
import type { AgentIdentity } from "./config.js";
import { ChatError } from "./chat.js";
import { ACTIVITY, INBOX, PRESENCE, ownerId, type PrivateStore } from "./private-store.js";
import { ChatRateLimiter } from "./rate-limits.js";
import type { DebugLog } from "./debug-log.js";

export const AGENT_TTL_MS = 30 * 60_000;
export const tokenHash = (token: string) => createHash("sha256").update(token).digest("hex");
export type AgentRow = { id: string; owner_id: string; name: string; description: string; expires_at: number; revoked_at: number | null };

export class AgentService {
  private readonly rates: ChatRateLimiter;
  constructor(readonly store: PrivateStore, private readonly debug?: DebugLog) { this.rates = new ChatRateLimiter(store.db); }

  register(owner: AgentIdentity, name: string, description: string) {
    if (!name.trim() || name.length > 64 || description.length > 500) throw new ChatError("invalid", "Name must be 1–64 characters and description at most 500");
    const ownerKey = ownerId(owner), id = `runtime_${nanoid(20)}`, agentToken = `agt_${randomBytes(32).toString("base64url")}`;
    const expiresAt = Date.now() + AGENT_TTL_MS;
    this.store.db.transaction(() => {
      const count = this.store.db.prepare(`select count(*) as n from runtime_agents where owner_id = ? and revoked_at is null and expires_at > ?`).get(ownerKey, Date.now()) as { n: number };
      if (count.n >= 32) throw new ChatError("conflict", "At most 32 current agents per account; unregister unused agents");
      this.rates.consume(ownerKey, "agents_register");
      this.store.db.prepare(`insert into runtime_agents(id, owner_id, name, description, token_hash, expires_at, created_at) values (?, ?, ?, ?, ?, ?, ?)`)
        .run(id, ownerKey, name.trim(), description, tokenHash(agentToken), expiresAt, new Date().toISOString());
    }).immediate();
    this.presence(ownerKey, "agent.registered", { id, name: name.trim(), description, expiresAt: new Date(expiresAt).toISOString() });
    this.debug?.record("runtime.registered", { actor: { id, name: name.trim() }, expiresAt: new Date(expiresAt).toISOString() });
    return { agent: { id, name: name.trim(), description }, agentToken, expiresAt: new Date(expiresAt).toISOString(),
      inbox: { name: INBOX, arguments: { agentToken }, cursor: this.cursor(ownerKey, id, INBOX) },
      activity: { name: ACTIVITY, arguments: { agentToken }, cursor: this.cursor(ownerKey, id, ACTIVITY) } };
  }

  resolve(owner: AgentIdentity, token: string): AgentIdentity {
    const row = this.store.db.prepare(`select * from runtime_agents where owner_id = ? and token_hash = ? and revoked_at is null and expires_at > ?`)
      .get(ownerId(owner), tokenHash(token), Date.now()) as AgentRow | undefined;
    if (!row) throw new ChatError("not_found", "Agent registration not found or expired");
    return { id: row.id, name: row.name, ownerId: row.owner_id };
  }

  renew(owner: AgentIdentity, token: string) {
    const agent = this.resolve(owner, token), expiresAt = Date.now() + AGENT_TTL_MS;
    this.store.db.prepare(`update runtime_agents set expires_at = ? where id = ?`).run(expiresAt, agent.id);
    return { agentId: agent.id, expiresAt: new Date(expiresAt).toISOString() };
  }

  unregister(owner: AgentIdentity, token: string) {
    const agent = this.resolve(owner, token);
    this.store.db.transaction(() => {
      this.store.db.prepare(`update runtime_agents set revoked_at = ? where id = ?`).run(Date.now(), agent.id);
      this.store.db.prepare(`delete from runtime_listeners where agent_id = ?`).run(agent.id);
      this.store.db.prepare(`update ring_pairings set revoked_at = ? where agent_id = ? and revoked_at is null`).run(Date.now(), agent.id);
    }).immediate();
    this.presence(ownerId(owner), "agent.unregistered", { id: agent.id, name: agent.name });
    this.store.hub.publish([agent.id], 0); // Wake listeners to recheck authorization immediately.
    this.debug?.record("runtime.unregistered", { actor: agent });
    return { agentId: agent.id, unregistered: true };
  }

  list(owner: AgentIdentity) {
    this.sweep();
    const rows = this.store.db.prepare(`select a.id, a.name, a.description, a.expires_at,
      max(min(a.expires_at, l.expires_at)) as listening_until,
      group_concat(distinct l.mode) as modes
      from runtime_agents a join runtime_listeners l on l.agent_id = a.id
      where a.owner_id = ? and a.revoked_at is null and a.expires_at > ? and l.expires_at > ?
      group by a.id order by a.name, a.id`).all(ownerId(owner), Date.now(), Date.now()) as Array<AgentRow & { listening_until: number; modes: string }>;
    return rows.map((r) => ({ id: r.id, name: r.name, description: r.description, deliveryModes: r.modes.split(",").sort(),
      listeningUntil: new Date(r.listening_until).toISOString(), expiresAt: new Date(r.expires_at).toISOString() }));
  }

  target(owner: AgentIdentity, id: string) {
    const row = this.store.db.prepare(`select * from runtime_agents where id = ? and owner_id = ? and revoked_at is null and expires_at > ?`)
      .get(id, ownerId(owner), Date.now()) as AgentRow | undefined;
    if (!row) throw new ChatError("not_found", "Agent not found or expired");
    return row;
  }

  listen(agent: AgentIdentity, key: string, mode: "poll" | "push" | "webhook", expiresAt: number) {
    if (!agent.ownerId) return; // Legacy account-level channel listener, not a runtime.
    const row = this.target(agent, agent.id);
    const wasOnline = this.isOnline(agent.id);
    this.store.db.prepare(`insert into runtime_listeners values (?, ?, ?, ?) on conflict(agent_id, listener_key) do update set expires_at = excluded.expires_at`)
      .run(agent.id, key, mode, Math.min(expiresAt, row.expires_at));
    if (!wasOnline) this.presence(agent.ownerId, "agent.online", { id: row.id, name: row.name, description: row.description });
  }

  unlisten(agent: AgentIdentity, key: string) {
    if (!agent.ownerId) return;
    const existed = this.store.db.prepare(`delete from runtime_listeners where agent_id = ? and listener_key = ?`).run(agent.id, key).changes;
    if (existed && !this.isOnline(agent.id)) this.presence(agent.ownerId, "agent.offline", { id: agent.id, name: agent.name });
  }

  sweep() {
    const stale = this.store.db.prepare(`select distinct a.id, a.owner_id, a.name from runtime_agents a join runtime_listeners l on l.agent_id = a.id
      where a.revoked_at is not null or a.expires_at <= ? or not exists (select 1 from runtime_listeners live where live.agent_id = a.id and live.expires_at > ?)`)
      .all(Date.now(), Date.now()) as AgentRow[];
    this.store.db.prepare(`delete from runtime_listeners where expires_at <= ? or agent_id in (select id from runtime_agents where revoked_at is not null or expires_at <= ?)`)
      .run(Date.now(), Date.now());
    for (const a of stale) {
      this.presence(a.owner_id, "agent.offline", { id: a.id, name: a.name });
      this.store.hub.publish([a.id], 0);
    }
  }

  private isOnline(id: string) { return Boolean(this.store.db.prepare(`select 1 from runtime_listeners where agent_id = ? and expires_at > ?`).get(id, Date.now())); }
  private presence(owner: string, kind: string, agent: unknown) {
    const event = this.store.db.transaction(() => this.store.record(owner, PRESENCE, kind, { kind, agent }, [owner]))();
    this.store.publish(event);
  }
  private cursor(owner: string, recipient: string, name: string) {
    const head = this.store.db.prepare(`select coalesce(max(e.id), 0) as id from account_events e join account_event_recipients r on r.event_row_id = e.id where e.owner_id = ? and e.name = ? and r.recipient_id = ?`)
      .get(owner, name, recipient) as { id: number };
    return `private-event:${head.id}`;
  }
}
