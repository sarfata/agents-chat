import { ProtocolError, type RequestId, type ServerContext } from "@modelcontextprotocol/server";
import type { AgentIdentity } from "./config.js";
import type { Db } from "./db.js";
import type { EventHub } from "./hub.js";
import { nanoid } from "nanoid";
import type { DebugLog } from "./debug-log.js";
import { AgentService } from "./agents.js";
import { ChatError } from "./chat.js";
import { ACTIVITY, INBOX, PRESENCE, RETENTION_MS, ownerId, privateStore, type PrivateEventRow } from "./private-store.js";

export const CHAT_ACTIVITY_EVENT = ACTIVITY;
export type EventRequest = { name: string; arguments?: Record<string, unknown>; cursor?: string | null; maxAgeMs?: number };
export type PollEventRequest = EventRequest & { maxEvents?: number };
type Feed = { agent: AgentIdentity; name: string };

export class EventsService {
  private readonly store;
  readonly agents: AgentService;
  constructor(private readonly db: Db, private readonly hub: EventHub, private readonly debug?: DebugLog, agents?: AgentService) {
    this.store = privateStore(db, hub); this.agents = agents ?? new AgentService(this.store, debug);
  }

  list() {
    const token = { type: "string", description: "Private registration credential returned by agents_register; requires the same authenticated account." };
    return { events: [
      { name: ACTIVITY, description: "Private activity in this account's joined channels.",
        inputSchema: { type: "object", properties: { agentToken: token }, additionalProperties: false },
        payloadSchema: { type: "object", required: ["kind", "channel"], properties: { kind: { enum: ["channel.created", "member.joined", "message.posted"] }, channel: { type: "object" } } } },
      { name: INBOX, description: "Private direct and paired-ring messages addressed to this registered agent.",
        inputSchema: { type: "object", properties: { agentToken: token }, required: ["agentToken"], additionalProperties: false },
        payloadSchema: { type: "object", required: ["kind", "source", "sender", "recipient", "message"], properties: { kind: { const: "message.received" }, source: { enum: ["agent", "ring"] }, sender: { type: "object" }, recipient: { type: "object" }, message: { type: "object" } } } },
      { name: PRESENCE, description: "Agent registration and online/offline presence within your own account only.",
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
        payloadSchema: { type: "object", required: ["kind", "agent"], properties: { kind: { enum: ["agent.registered", "agent.online", "agent.offline", "agent.unregistered"] }, agent: { type: "object" } } } }
    ].map((e) => ({ ...e, delivery: ["poll", "push", "webhook"] })) };
  }

  principal(owner: AgentIdentity, input: EventRequest): AgentIdentity { return this.feed(owner, input).agent; }
  listen(owner: AgentIdentity, input: EventRequest, key: string, mode: "poll" | "push" | "webhook", expiresAt: number) {
    if (input.name === INBOX) this.agents.listen(this.principal(owner, input), key, mode, expiresAt);
  }
  unlisten(owner: AgentIdentity, input: EventRequest, key: string) {
    if (input.name !== INBOX) return;
    try { this.agents.unlisten(this.principal(owner, input), key); } catch { /* Already revoked/expired. */ }
  }

  webhookStart(owner: AgentIdentity, input: EventRequest) {
    const feed = this.feed(owner, input), head = this.head(feed);
    if (input.cursor == null) return { cursor: formatCursor(head), truncated: false };
    let start = Math.min(parseCursor(input.cursor), head);
    let truncated = parseCursor(input.cursor) > head || start < this.position(feed).pruned_through;
    const cutoff = this.cutoff(input);
    const skipped = this.db.prepare(`select max(e.id) as id from account_events e join account_event_recipients r on r.event_row_id = e.id
      where e.owner_id = ? and e.name = ? and r.recipient_id = ? and e.id > ? and e.occurred_at < ?`)
      .get(ownerId(feed.agent), feed.name, feed.agent.id, start, cutoff) as { id: number | null };
    if (skipped.id !== null) { start = skipped.id; truncated = true; }
    return { cursor: formatCursor(start), truncated };
  }

  poll(owner: AgentIdentity, input: PollEventRequest) {
    const feed = this.feed(owner, input), head = this.head(feed), limit = Math.min(input.maxEvents ?? 50, 100);
    if (!Number.isInteger(limit) || limit < 1) throw new ProtocolError(-32602, "InvalidParams", { field: "maxEvents" });
    if (input.cursor == null) return { events: [], cursor: formatCursor(head), truncated: false, hasMore: false, nextPollMs: 2000 };
    const start = this.webhookStart(owner, input);
    const rows = this.rows(feed, parseCursor(start.cursor), this.cutoff(input), limit + 1), selected = rows.slice(0, limit), hasMore = rows.length > limit;
    return { events: selected.map((r) => this.occurrence(r)), cursor: formatCursor(hasMore ? selected.at(-1)!.id : head),
      truncated: start.truncated, hasMore, nextPollMs: 2000 };
  }

  async stream(owner: AgentIdentity, input: EventRequest, ctx: ServerContext): Promise<{ _meta: Record<string, never> }> {
    const feed = this.feed(owner, input), initial = this.webhookStart(owner, input);
    const listenerKey = `push_${nanoid(20)}`;
    let cursor = initial.cursor, stopped = false, active = false, reason: "cancelled" | "transport_error" = "cancelled";
    let finish!: () => void;
    const ended = new Promise<void>((resolve) => { finish = resolve; });
    let queue = Promise.resolve(), dirty = false, pumping = false;
    const details = { actor: feed.agent, mode: "push" as const, subscriptionId: listenerKey };
    const notify = async (method: string, params: Record<string, unknown>) => {
      if (!stopped) await ctx.mcpReq.notify({ method, params: withSubscriptionId(params, ctx.mcpReq.id) });
    };
    const fail = () => { reason = "transport_error"; stopped = true; this.debug?.record("delivery.failed", { ...details, reason }); finish(); };
    const pump = () => {
      dirty = true;
      if (pumping || stopped || !active) return;
      pumping = true;
      queue = queue.then(async () => {
        do {
          dirty = false;
          let batch: ReturnType<EventsService["poll"]>;
          try { batch = this.poll(owner, { ...input, cursor, maxEvents: 100 }); }
          catch (error) {
            if (!(error instanceof ProtocolError)) throw error;
            await notify("notifications/events/terminated", { reason: "authorization_revoked" });
            stopped = true; finish(); return;
          }
          if (batch.truncated) await notify("notifications/events/active", { cursor, truncated: true });
          for (const event of batch.events) { await notify("notifications/events/event", event); this.debug?.record("delivery.sent", { ...details, eventId: event.eventId }); }
          cursor = batch.cursor;
          dirty ||= batch.hasMore;
        } while (dirty && !stopped);
      }).catch(fail).finally(() => { pumping = false; if (dirty && !stopped) pump(); });
    };
    const off = this.hub.onEvent(feed.agent.id, () => pump());
    const abort = () => { stopped = true; finish(); };
    ctx.mcpReq.signal.addEventListener("abort", abort, { once: true });
    if (ctx.mcpReq.signal.aborted) abort();
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    try {
      if (!stopped) {
        this.listen(owner, input, listenerKey, "push", Date.now() + 60_000);
        await notify("notifications/events/active", initial);
        active = true;
        this.debug?.record("subscription.created", { ...details, truncated: initial.truncated });
        pump();
        heartbeat = setInterval(() => {
          try { this.listen(owner, input, listenerKey, "push", Date.now() + 60_000); }
          catch { pump(); return; }
          pump();
          queue = queue.then(() => notify("notifications/events/heartbeat", { cursor })).catch(fail);
        }, 25_000);
        heartbeat.unref?.();
      }
      await ended;
    } catch { fail(); }
    finally {
      stopped = true; clearInterval(heartbeat); off(); this.unlisten(owner, input, listenerKey);
      ctx.mcpReq.signal.removeEventListener("abort", abort); await queue;
      if (active) this.debug?.record("subscription.closed", { ...details, reason });
    }
    return { _meta: {} };
  }

  private feed(owner: AgentIdentity, input: EventRequest): Feed {
    if (![ACTIVITY, INBOX, PRESENCE].includes(input.name)) throw new ProtocolError(-32011, "NotFound", { kind: "event" });
    const args = input.arguments ?? {};
    const token = args.agentToken;
    if (Object.keys(args).some((key) => key !== "agentToken") || (token !== undefined && (typeof token !== "string" || token.length > 100)) ||
      (input.name === INBOX && !token) || (input.name === PRESENCE && Object.keys(args).length > 0) ||
      (input.maxAgeMs !== undefined && (!Number.isSafeInteger(input.maxAgeMs) || input.maxAgeMs < 0))) throw new ProtocolError(-32602, "InvalidParams");
    try { return { name: input.name, agent: token ? this.agents.resolve(owner, token as string) : { id: ownerId(owner), name: owner.name } }; }
    catch (error) { if (error instanceof ChatError) throw new ProtocolError(-32011, "NotFound", { kind: "agent" }); throw error; }
  }
  private cutoff(input: EventRequest) { return new Date(Date.now() - Math.min(input.maxAgeMs ?? RETENTION_MS, RETENTION_MS)).toISOString(); }
  private position(feed: Feed) {
    return this.db.prepare(`select head, pruned_through from account_feed_positions where owner_id = ? and name = ? and recipient_id = ?`)
      .get(ownerId(feed.agent), feed.name, feed.agent.id) as { head: number; pruned_through: number } | undefined ?? { head: 0, pruned_through: 0 };
  }
  private head(feed: Feed) { return this.position(feed).head; }
  private rows(feed: Feed, start: number, cutoff: string, limit: number) {
    return this.db.prepare(`select e.* from account_events e join account_event_recipients r on r.event_row_id = e.id
      where e.owner_id = ? and e.name = ? and r.recipient_id = ? and e.id > ? and e.occurred_at >= ? order by e.id limit ?`)
      .all(ownerId(feed.agent), feed.name, feed.agent.id, start, cutoff, limit) as PrivateEventRow[];
  }
  private occurrence(row: PrivateEventRow) { return { eventId: row.event_id, name: row.name, timestamp: row.occurred_at,
    data: this.store.open(row.payload, row.event_id), cursor: formatCursor(row.id) }; }
}

export function formatCursor(position: number) { return `private-event:${position}`; }
function parseCursor(cursor: string) {
  const match = /^private-event:(\d+)$/.exec(cursor), value = match ? Number(match[1]) : NaN;
  if (!Number.isSafeInteger(value) || value < 0) throw new ProtocolError(-32602, "InvalidParams", { field: "cursor" });
  return value;
}
function withSubscriptionId(params: Record<string, unknown>, id: RequestId) { return { ...params, _meta: { "io.modelcontextprotocol/subscriptionId": String(id) } }; }
