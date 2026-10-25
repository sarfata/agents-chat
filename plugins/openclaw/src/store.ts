import { join } from "node:path";
import { readJson, writeJson } from "./files.js";
import { z } from "zod/v4";

export const Feed = z.enum(["agents-chat.inbox", "agents-chat.activity"]);
export type FeedName = z.infer<typeof Feed>;
export const Occurrence = z.object({ eventId: z.string().min(1).max(256), name: Feed, cursor: z.string().max(256), timestamp: z.string().max(100), data: z.record(z.string(), z.unknown()) });
export type ChatEvent = z.infer<typeof Occurrence>;
export type Registration = { agent: { id: string; name: string; description: string }; agentToken: string; expiresAt: string; inbox: { cursor: string }; activity: { cursor: string } };
export type AgentState = { registration?: Registration; cursors: Partial<Record<FeedName, string>>; pending: ChatEvent[]; seen: string[]; gap: boolean };
const empty = (): AgentState => ({ cursors: {}, pending: [], seen: [], gap: false });

/** Serialize all mutations: advance a feed cursor only in the same durable write as its events. */
export class InboxStore {
  private queue: Promise<unknown> = Promise.resolve();
  constructor(readonly directory: string, readonly maxPending = 500) {}
  private path(id: string) { if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(id)) throw new Error("Invalid local agent id"); return join(this.directory, `${id}.json`); }
  async read(id: string): Promise<AgentState> { await this.queue; return await readJson<AgentState>(this.path(id)) ?? empty(); }
  async change<T>(id: string, action: (state: AgentState) => T): Promise<T> {
    const next = this.queue.then(async () => { const state = await readJson<AgentState>(this.path(id)) ?? empty(); const value = action(state); await writeJson(this.path(id), state); return value; });
    this.queue = next.catch(() => {}); return next;
  }
  register(id: string, registration: Registration) { return this.change(id, (state) => { state.registration = registration; state.cursors = { "agents-chat.inbox": registration.inbox.cursor, "agents-chat.activity": registration.activity.cursor }; }); }
  ingest(id: string, feed: FeedName, events: unknown[], cursor: string, truncated = false) {
    return this.change(id, (state) => {
      const parsed = events.map((event) => Occurrence.parse(event));
      if (parsed.some((event) => event.name !== feed)) throw new Error("Event arrived on an unexpected feed");
      const known = new Set([...state.seen, ...state.pending.map((e) => e.eventId)]);
      const fresh = parsed.filter((event) => { if (known.has(event.eventId)) return false; known.add(event.eventId); return true; });
      const messages = fresh.filter((event) => event.data.kind === "message.received" || (event.data.kind === "message.posted" && (event.data.sender as { id?: string } | undefined)?.id !== state.registration?.agent.id));
      if (state.pending.length + messages.length > this.maxPending) throw new Error("Agents Chat inbox is full; read and acknowledge messages to resume delivery");
      state.pending.push(...messages); state.seen.push(...fresh.map((e) => e.eventId)); state.seen = state.seen.slice(-2000);
      state.cursors[feed] = cursor; state.gap ||= truncated;
      return messages.length;
    });
  }
  ack(id: string, eventIds: string[]) { return this.change(id, (state) => { const before = state.pending.length; state.pending = state.pending.filter((event) => !eventIds.includes(event.eventId)); return { acknowledged: before - state.pending.length, remaining: state.pending.length }; }); }
}
