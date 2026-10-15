import { nanoid } from "nanoid";
import type { AgentIdentity } from "./config.js";
import type { Db } from "./db.js";
import type { EventHub } from "./hub.js";
import { ChatRateLimiter } from "./rate-limits.js";
import type { DebugLog } from "./debug-log.js";
import { ACTIVITY, ownerId, privateStore } from "./private-store.js";

export class ChatError extends Error {
  constructor(readonly code: "not_found" | "conflict" | "forbidden" | "invalid", message: string) { super(message); }
}

export class ChatService {
  private readonly store;
  constructor(private readonly db: Db, hub: EventHub,
    private readonly rateLimits = new ChatRateLimiter(db), private readonly debug?: DebugLog) { this.store = privateStore(db, hub); }

  listChannels(agent: AgentIdentity, joinedOnly = false) {
    const rows = this.db.prepare(`select c.id, c.name, c.created_at, count(m.agent_id) as member_count,
      max(case when mine.agent_id is not null then 1 else 0 end) as joined
      from account_channels c left join account_memberships m on m.channel_id = c.id
      left join account_memberships mine on mine.channel_id = c.id and mine.agent_id = ?
      where c.owner_id = ? ${joinedOnly ? "and mine.agent_id is not null" : ""}
      group by c.id order by c.name collate nocase`).all(agent.id, ownerId(agent)) as
      Array<{ id: string; name: string; created_at: string; member_count: number; joined: number }>;
    return rows.map((r) => ({ id: r.id, name: r.name, memberCount: r.member_count, joined: Boolean(r.joined), createdAt: r.created_at }));
  }

  createChannel(agent: AgentIdentity, name: string) {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,39}$/.test(name)) throw new ChatError("invalid", "Invalid channel name");
    const normalizedName = name.toLowerCase(), channelId = `channel_${nanoid(16)}`, now = new Date().toISOString();
    let event!: ReturnType<typeof this.store.record>;
    try {
      this.db.transaction(() => {
        this.rateLimits.consume(ownerId(agent), "channels_create");
        this.db.prepare(`insert into account_channels values (?, ?, ?, ?, ?)`).run(channelId, ownerId(agent), normalizedName, agent.id, now);
        this.db.prepare(`insert into account_memberships values (?, ?, ?, ?)`).run(channelId, agent.id, agent.name, now);
        event = this.record(agent, channelId, "channel.created", { channel: { id: channelId, name: normalizedName }, actor: publicAgent(agent) });
      }).immediate();
    } catch (error) {
      if (error instanceof Error && error.message.includes("UNIQUE constraint failed")) throw new ChatError("conflict", `Channel ${normalizedName} already exists`);
      throw error;
    }
    this.debug?.chatEvent(event.rowId); this.store.publish(event);
    return { id: channelId, name: normalizedName, joined: true, createdAt: now };
  }

  joinChannel(agent: AgentIdentity, channelId: string) {
    const channel = this.channel(agent, channelId);
    if (this.db.prepare(`select 1 from account_memberships where channel_id = ? and agent_id = ?`).get(channelId, agent.id)) {
      return { channel, joined: true, alreadyJoined: true };
    }
    const event = this.db.transaction(() => {
      this.rateLimits.consume(ownerId(agent), "channels_join");
      this.db.prepare(`insert into account_memberships values (?, ?, ?, ?)`).run(channelId, agent.id, agent.name, new Date().toISOString());
      return this.record(agent, channelId, "member.joined", { channel, member: publicAgent(agent) });
    }).immediate();
    this.debug?.chatEvent(event.rowId); this.store.publish(event);
    return { channel, joined: true, alreadyJoined: false };
  }

  postMessage(agent: AgentIdentity, channelId: string, text: string) {
    const channel = this.channel(agent, channelId);
    if (!this.db.prepare(`select 1 from account_memberships where channel_id = ? and agent_id = ?`).get(channelId, agent.id)) throw new ChatError("forbidden", "Join the channel before posting");
    if ([...text].length < 1 || [...text].length > 200) throw new ChatError("invalid", "Messages must contain 1-200 characters");
    const id = `message_${nanoid(20)}`, sender = publicAgent(agent);
    const event = this.db.transaction(() => {
      this.rateLimits.consume(ownerId(agent), "messages_post");
      return this.record(agent, channelId, "message.posted", { channel, message: { id, text }, sender });
    }).immediate();
    this.debug?.chatEvent(event.rowId); this.store.publish(event);
    return { id, channel, text, sender, createdAt: event.occurredAt };
  }

  private channel(agent: AgentIdentity, channelId: string) {
    const row = this.db.prepare(`select id, name from account_channels where id = ? and owner_id = ?`).get(channelId, ownerId(agent)) as { id: string; name: string } | undefined;
    if (!row) throw new ChatError("not_found", "Channel not found");
    return row;
  }

  private record(agent: AgentIdentity, channelId: string, kind: string, data: Record<string, unknown>) {
    const recipients = (this.db.prepare(`select agent_id from account_memberships where channel_id = ?`).all(channelId) as Array<{ agent_id: string }>).map((r) => r.agent_id);
    return this.store.record(ownerId(agent), ACTIVITY, kind, { kind, ...data }, recipients);
  }
}

export const publicAgent = (agent: AgentIdentity) => ({ id: agent.id, name: agent.name });
