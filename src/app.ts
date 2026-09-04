import { Hono } from "hono";
import type { Config } from "./config.js";
import { openDb } from "./db.js";
import { EventHub } from "./hub.js";
import { ChatService } from "./chat.js";
import { EventsService } from "./events.js";
import { createMcpEndpoint } from "./mcp.js";

export function createApp(config: Config) {
  const db = openDb(config.databaseUrl);
  const hub = new EventHub();
  const chat = new ChatService(db, hub);
  const events = new EventsService(db, hub);
  const mcp = createMcpEndpoint(config, chat, events);
  const app = new Hono()
    .get("/health", (c) => c.json({ ok: true }))
    .route("/mcp", mcp.app);
  return {
    app,
    db,
    async close() {
      await mcp.close();
      db.close();
    }
  };
}
