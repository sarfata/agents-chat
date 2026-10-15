import { nanoid } from "nanoid";
import type { AgentIdentity } from "./config.js";
import { ChatError, publicAgent } from "./chat.js";
import { AgentService, tokenHash } from "./agents.js";
import { INBOX, ownerId, RETENTION_MS, type PrivateStore } from "./private-store.js";
import { ChatRateLimiter } from "./rate-limits.js";
import type { DebugLog } from "./debug-log.js";

export class MessageService {
  private readonly rates;
  constructor(private readonly store: PrivateStore, private readonly agents: AgentService, private readonly debug?: DebugLog) { this.rates = new ChatRateLimiter(store.db); }

  send(owner: AgentIdentity, agentToken: string, targetId: string, text: string, idempotencyKey: string, inReplyTo?: string) {
    const sender = this.agents.resolve(owner, agentToken);
    return this.deliver(owner, sender.id, publicAgent(sender), targetId, text, idempotencyKey, "agent", inReplyTo);
  }

  ring(owner: AgentIdentity, pairingId: string, name: string, targetId: string, text: string, messageId: string, recordedAt: string) {
    return this.deliver(owner, pairingId, { id: pairingId, name }, targetId, text, messageId, "ring", undefined, recordedAt);
  }

  private deliver(owner: AgentIdentity, senderId: string, sender: { id: string; name: string }, targetId: string, text: string,
    key: string, source: "agent" | "ring", inReplyTo?: string, recordedAt?: string) {
    const max = source === "ring" ? 8000 : 200;
    if ([...text].length < 1 || [...text].length > max || !key || key.length > 256) throw new ChatError("invalid", `Text must be 1-${max} characters and idempotencyKey 1-256 characters`);
    const fingerprint = tokenHash(JSON.stringify([targetId, text, inReplyTo ?? null, recordedAt ?? null]));
    let event: ReturnType<PrivateStore["record"]> | undefined;
    const result = this.store.db.transaction(() => {
      const old = this.store.db.prepare(`select fingerprint, result_json from private_idempotency where owner_id = ? and sender_id = ? and request_key = ? and expires_at > ?`)
        .get(ownerId(owner), senderId, key, Date.now()) as { fingerprint: string; result_json: string } | undefined;
      if (old) {
        if (old.fingerprint !== fingerprint) throw new ChatError("conflict", "Idempotency key was already used with different content");
        return { ...JSON.parse(old.result_json), duplicate: true };
      }
      this.agents.target(owner, targetId);
      this.rates.consume(ownerId(owner), "messages_post");
      const id = `message_${nanoid(20)}`;
      event = this.store.record(ownerId(owner), INBOX, "message.received", {
        kind: "message.received", source, sender, recipient: { id: targetId },
        message: { id, text, ...(inReplyTo ? { inReplyTo } : {}), ...(recordedAt ? { recordedAt } : {}) }
      }, [targetId]);
      const receipt = { id, eventId: event.eventId, targetAgentId: targetId, createdAt: event.occurredAt, accepted: true, duplicate: false };
      this.store.db.prepare(`insert into private_idempotency values (?, ?, ?, ?, ?, ?) on conflict(owner_id, sender_id, request_key) do update set fingerprint=excluded.fingerprint, result_json=excluded.result_json, expires_at=excluded.expires_at`)
        .run(ownerId(owner), senderId, key, fingerprint, JSON.stringify(receipt), Date.now() + RETENTION_MS);
      return receipt;
    }).immediate();
    if (event) {
      this.store.publish(event);
      this.debug?.record(source === "ring" ? "ring.message_received" : "message.sent", { actor: sender, eventId: event.eventId });
    }
    return result;
  }
}
