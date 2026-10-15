import { randomBytes } from "node:crypto";
import { nanoid } from "nanoid";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod/v4";
import type { AgentIdentity } from "./config.js";
import { AgentService, tokenHash } from "./agents.js";
import type { PrivateStore } from "./private-store.js";
import { ownerId } from "./private-store.js";
import { ChatError } from "./chat.js";
import type { MessageService } from "./messages.js";
import { ChatRateLimiter, RateLimitError } from "./rate-limits.js";

const RingInput = z.object({ message_id: z.string().min(1).max(256), recorded_at: z.string().datetime(),
  transcript: z.string().refine((s) => [...s].length > 0 && [...s].length <= 8000),
  // Ring-compatible optional fields are accepted but not retained or trusted.
  trigger: z.string().optional(), audio_url: z.string().nullable().optional(), metadata: z.record(z.string(), z.unknown()).optional() });
type Pairing = { id: string; owner_id: string; agent_id: string; name: string };

export class RingService {
  readonly app = new Hono();
  constructor(private readonly store: PrivateStore, private readonly agents: AgentService,
    private readonly messages: MessageService, private readonly baseUrl: string) {
    this.app.post("/:id/messages", bodyLimit({ maxSize: 64 * 1024 }), async (c) => {
      const authorization = c.req.header("Authorization");
      if (!authorization?.startsWith("Bearer ")) return c.json({ error: "unauthorized" }, 401);
      const row = store.db.prepare(`select id, owner_id, agent_id, name from ring_pairings where id = ? and token_hash = ? and revoked_at is null`)
        .get(c.req.param("id"), tokenHash(authorization.slice(7))) as Pairing | undefined;
      if (!row) return c.json({ error: "unauthorized" }, 401);
      let input: z.infer<typeof RingInput>;
      try { input = RingInput.parse(await c.req.json()); } catch { return c.json({ error: "invalid_request" }, 400); }
      try {
        const result = messages.ring({ id: row.owner_id, name: "paired ring" }, row.id, row.name, row.agent_id, input.transcript, input.message_id, input.recorded_at);
        return c.json(result, 202);
      } catch (error) {
        if (error instanceof RateLimitError) return c.json({ error: error.code, retryAfterMs: error.retryAfterMs }, 429, { "Retry-After": String(Math.ceil(error.retryAfterMs / 1000)) });
        if (error instanceof ChatError) return c.json({ error: error.code, message: error.message }, error.code === "conflict" ? 409 : 404);
        throw error;
      }
    });
  }

  pair(owner: AgentIdentity, targetAgentId: string, name: string) {
    this.agents.target(owner, targetAgentId);
    if (!name.trim() || name.length > 64) throw new ChatError("invalid", "Ring name must be 1–64 characters");
    const id = `pair_${nanoid(20)}`, ingestToken = `ring_${randomBytes(32).toString("base64url")}`;
    this.store.db.transaction(() => {
      const count = this.store.db.prepare(`select count(*) as n from ring_pairings where owner_id = ? and revoked_at is null`).get(ownerId(owner)) as { n: number };
      if (count.n >= 16) throw new ChatError("conflict", "At most 16 ring pairings per account");
      new ChatRateLimiter(this.store.db).consume(ownerId(owner), "rings_pair");
      this.store.db.prepare(`insert into ring_pairings(id, owner_id, agent_id, name, token_hash, created_at) values (?, ?, ?, ?, ?, ?)`)
        .run(id, ownerId(owner), targetAgentId, name.trim(), tokenHash(ingestToken), new Date().toISOString());
    }).immediate();
    return { pairingId: id, targetAgentId, webhookUrl: `${this.baseUrl}/api/rings/${id}/messages`, ingestToken };
  }

  unpair(owner: AgentIdentity, pairingId: string) {
    const result = this.store.db.prepare(`update ring_pairings set revoked_at = ? where id = ? and owner_id = ? and revoked_at is null`).run(Date.now(), pairingId, ownerId(owner));
    if (!result.changes) throw new ChatError("not_found", "Ring pairing not found");
    return { pairingId, revoked: true };
  }
}
