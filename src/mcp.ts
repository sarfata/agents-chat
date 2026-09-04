import { createMcpHonoApp } from "@modelcontextprotocol/hono";
import { createMcpHandler, McpServer, type ServerCapabilities } from "@modelcontextprotocol/server";
import type { Context, Hono } from "hono";
import { z } from "zod/v4";
import { authenticate, type AgentIdentity, type Config } from "./config.js";
import { ChatError, ChatService } from "./chat.js";
import { CHAT_ACTIVITY_EVENT, EventsService } from "./events.js";

const EmptyArgumentsSchema = z.record(z.string(), z.unknown()).optional().default({});
const EventRequestSchema = z.object({
  name: z.string(),
  arguments: EmptyArgumentsSchema,
  cursor: z.string().nullable().optional(),
  maxAgeMs: z.number().int().nonnegative().optional()
});
const PollRequestSchema = EventRequestSchema.extend({ maxEvents: z.number().int().positive().optional() });
const ListRequestSchema = z.object({ cursor: z.string().optional() }).optional().default({});
const EventOccurrenceSchema = z.object({
  eventId: z.string(),
  name: z.string(),
  timestamp: z.string(),
  data: z.record(z.string(), z.unknown()),
  cursor: z.string().optional()
});
const ListResultSchema = z.object({ events: z.array(z.unknown()), nextCursor: z.string().optional() });
const PollResultSchema = z.object({
  events: z.array(EventOccurrenceSchema),
  cursor: z.string(),
  truncated: z.boolean(),
  hasMore: z.boolean(),
  nextPollMs: z.number().int()
});
const EmptyResultSchema = z.object({ _meta: z.record(z.string(), z.unknown()).optional() });

const ChannelNameSchema = z.string().trim().min(1).max(40)
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/, "Use letters, numbers, underscores, or hyphens");
const MessageSchema = z.string().refine((value) => [...value].length >= 1 && [...value].length <= 200, {
  message: "Messages must contain 1-200 characters"
});

export type McpEndpoint = { app: Hono; close(): Promise<void> };

export function createMcpEndpoint(config: Config, chat: ChatService, events: EventsService): McpEndpoint {
  const publicHostname = new URL(config.publicBaseUrl).hostname;
  const allowedHosts = Array.from(new Set([publicHostname, "localhost", "127.0.0.1", "[::1]"]));
  const app = createMcpHonoApp({ host: "0.0.0.0", allowedHosts, allowedOrigins: allowedHosts });
  const handler = createMcpHandler((context) => {
    const agent = context.authInfo?.extra?.agent as AgentIdentity | undefined;
    if (!agent) throw new Error("Authenticated agent context is required");
    return createAgentServer(chat, events, agent);
  }, {
    responseMode: "auto",
    onerror: (error) => console.error("MCP request failed", error)
  });

  app.all("/", async (c: Context) => {
    const agent = authenticate(config, c.req.header("Authorization"));
    if (!agent) {
      return new Response(JSON.stringify({ error: "unauthorized" }), {
        status: 401,
        headers: { "Content-Type": "application/json", "WWW-Authenticate": "Bearer" }
      });
    }
    return handler.fetch(c.req.raw, {
      parsedBody: c.get("parsedBody"),
      authInfo: {
        token: c.req.header("Authorization")!.slice("Bearer ".length),
        clientId: agent.id,
        scopes: ["chat", "events:read"],
        extra: { agent }
      }
    });
  });
  return { app, close: () => handler.close() };
}

function createAgentServer(chat: ChatService, events: EventsService, agent: AgentIdentity): McpServer {
  const capabilities = {
    events: { listChanged: false },
    extensions: { "io.modelcontextprotocol/events": { listChanged: false } }
  } as ServerCapabilities;
  const server = new McpServer({ name: "agents-chat", version: "0.1.0" }, {
    capabilities,
    instructions: `You are authenticated as ${agent.name}. Join channels before posting. Subscribe to ${CHAT_ACTIVITY_EVENT} to receive activity from joined channels.`
  });

  server.registerTool("channels_list", {
    title: "List channels",
    description: "List chat channels and show which ones this agent has joined.",
    inputSchema: z.object({ joinedOnly: z.boolean().optional().default(false) })
  }, async ({ joinedOnly }) => toolResult({ channels: chat.listChannels(agent, joinedOnly) }));

  server.registerTool("channels_create", {
    title: "Create channel",
    description: "Create a channel. The creating agent joins it automatically.",
    inputSchema: z.object({ name: ChannelNameSchema })
  }, async ({ name }) => guardedTool(() => ({ channel: chat.createChannel(agent, name) })));

  server.registerTool("channels_join", {
    title: "Join channel",
    description: "Join a channel and become eligible for its future events.",
    inputSchema: z.object({ channelId: z.string().min(1) })
  }, async ({ channelId }) => guardedTool(() => chat.joinChannel(agent, channelId)));

  server.registerTool("messages_post", {
    title: "Post message",
    description: "Post a message of at most 200 characters to a joined channel.",
    inputSchema: z.object({ channelId: z.string().min(1), text: MessageSchema })
  }, async ({ channelId, text }) => guardedTool(() => ({ message: chat.postMessage(agent, channelId, text) })));

  server.server.setRequestHandler("events/list", { params: ListRequestSchema, result: ListResultSchema }, async () => events.list());
  server.server.setRequestHandler("events/poll", { params: PollRequestSchema, result: PollResultSchema }, async (params) => events.poll(agent, params));
  server.server.setRequestHandler("events/stream", { params: EventRequestSchema, result: EmptyResultSchema }, async (params, ctx) => events.stream(agent, params, ctx));
  return server;
}

function guardedTool(action: () => unknown) {
  try {
    return toolResult(action());
  } catch (error) {
    if (error instanceof ChatError) {
      return { isError: true as const, content: [{ type: "text" as const, text: error.message }] };
    }
    throw error;
  }
}

function toolResult(value: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value) }],
    structuredContent: value as Record<string, unknown>
  };
}
