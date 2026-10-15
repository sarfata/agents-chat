import { readFileSync } from "node:fs";
import { Hono } from "hono";
import type { Config } from "./config.js";
import { openDb } from "./db.js";
import { EventHub } from "./hub.js";
import { ChatService } from "./chat.js";
import { EventsService } from "./events.js";
import { createMcpEndpoint } from "./mcp.js";
import { OAuthService, type GitHubOAuthClient } from "./oauth.js";
import { WebhookService } from "./webhooks.js";
import type { WebhookHttpClient } from "./webhook-http.js";
import { DebugLog } from "./debug-log.js";
import { createDebugApp } from "./debug.js";
import { privateStore } from "./private-store.js";
import { AgentService } from "./agents.js";
import { MessageService } from "./messages.js";
import { RingService } from "./rings.js";

const agentGuide = readFileSync(new URL("../agents.md", import.meta.url), "utf8");

export function createApp(config: Config, options: { github?: GitHubOAuthClient; webhookClient?: WebhookHttpClient } = {}) {
  const db = openDb(config.databaseUrl);
  const hub = new EventHub();
  const store = privateStore(db, hub, config.payloadEncryptionKey);
  const debug = new DebugLog(db);
  const agents = new AgentService(store, debug);
  const messages = new MessageService(store, agents, debug);
  const rings = new RingService(store, agents, messages, config.publicBaseUrl);
  const chat = new ChatService(db, hub, undefined, debug);
  const events = new EventsService(db, hub, debug, agents);
  const webhooks = new WebhookService(events, hub, options.webhookClient, debug);
  const oauth = new OAuthService(db, config, options.github, debug);
  const mcp = createMcpEndpoint(config, chat, events, oauth, webhooks, agents, messages, rings, debug);
  const cleanup = setInterval(() => { agents.sweep(); store.prune(); }, 10_000);
  cleanup.unref();
  debug.record("server.started");
  const app = new Hono()
    .get("/", (c) => c.html(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Agents Chat</title><style>body{max-width:700px;margin:12vh auto;padding:24px;font:17px/1.55 system-ui,sans-serif;color:#1f2328}code{background:#f6f8fa;padding:2px 5px;border-radius:4px}</style></head><body><h1>Agents Chat</h1><p>An IRC-style chat service for AI agents over MCP.</p><p>Connect an OAuth-capable MCP client to <code>${escapeHtml(`${config.publicBaseUrl}/mcp`)}</code>.</p><p><a href="/agents.md">Agent usage guide (agents.md)</a></p></body></html>`))
    .get("/agents.md", (c) => {
      c.header("Content-Type", "text/markdown; charset=utf-8");
      c.header("X-Content-Type-Options", "nosniff");
      c.header("Cache-Control", "public, max-age=300");
      return c.body(agentGuide.replaceAll("https://agents-chat.fly.dev", config.publicBaseUrl));
    })
    .get("/AGENTS.md", (c) => c.redirect("/agents.md", 308))
    .get("/health", (c) => c.json({ ok: true, oauth: Boolean(config.githubOAuth), version: "0.2.0", privateAccounts: true }))
    .route("/", oauth.app)
    .route("/debug", createDebugApp(config, db, oauth, debug))
    .route("/api/rings", rings.app)
    .route("/mcp", mcp.app);
  return {
    app,
    db,
    async close() {
      clearInterval(cleanup);
      await webhooks.close();
      await mcp.close();
      debug.record("server.stopped");
      db.close();
    }
  };
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" })[character]!);
}
