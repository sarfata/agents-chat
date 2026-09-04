import { afterEach, describe, expect, it } from "vitest";
import type { Hono } from "hono";
import { createApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { CHAT_ACTIVITY_EVENT } from "../src/events.js";

type RpcMessage = {
  jsonrpc: "2.0";
  id?: string | number | null;
  method?: string;
  params?: Record<string, any>;
  result?: Record<string, any>;
  error?: { code: number; message: string };
};

const tokens = {
  alice: "alice-token-012345678901234567890123",
  bob: "bob-token-01234567890123456789012345",
  charlie: "charlie-token-012345678901234567890"
};

type Fixture = ReturnType<typeof setup>;
const fixtures: Fixture[] = [];

afterEach(async () => {
  for (const fixture of fixtures.splice(0)) await fixture.close();
});

function setup() {
  const config = loadConfig({
    PORT: "3000",
    PUBLIC_BASE_URL: "http://chat.example.test",
    DATABASE_URL: ":memory:",
    AGENTS_CHAT_TOKENS_JSON: JSON.stringify({
      [tokens.alice]: "alice",
      [tokens.bob]: "bob",
      [tokens.charlie]: "charlie"
    })
  });
  const fixture = createApp(config);
  fixtures.push(fixture);
  return fixture;
}

async function rpc(app: Hono, token: string, method: string, params: Record<string, unknown> = {}, id: string | number = 1) {
  const response = await app.request("/mcp", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json, text/event-stream",
      "Content-Type": "application/json",
      Host: "chat.example.test"
    },
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params })
  });
  expect(response.status).toBe(200);
  const messages = await responseMessages(response);
  const message = messages.find((item) => item.id === id);
  if (!message) throw new Error(`Missing response for ${String(id)}`);
  if (message.error) throw new Error(`MCP error ${message.error.code}: ${message.error.message}`);
  return message;
}

async function callTool(app: Hono, token: string, name: string, args: Record<string, unknown> = {}) {
  const response = await rpc(app, token, "tools/call", { name, arguments: args });
  return response.result as { isError?: boolean; structuredContent?: Record<string, any>; content: Array<{ text: string }> };
}

async function responseMessages(response: Response): Promise<RpcMessage[]> {
  const text = await response.text();
  if (response.headers.get("content-type")?.includes("text/event-stream")) return parseSse(text);
  const value = JSON.parse(text) as RpcMessage | RpcMessage[];
  return Array.isArray(value) ? value : [value];
}

function parseSse(text: string): RpcMessage[] {
  return text.split(/\r?\n/).filter((line) => line.startsWith("data:"))
    .map((line) => JSON.parse(line.slice(5).trim()) as RpcMessage);
}

async function readSseUntil(reader: ReadableStreamDefaultReader<Uint8Array>, predicate: (message: RpcMessage) => boolean) {
  const decoder = new TextDecoder();
  let pending = "";
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    const chunk = await Promise.race([
      reader.read(),
      new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error("Timed out waiting for SSE")), deadline - Date.now()))
    ]);
    if (chunk.done) throw new Error("SSE ended unexpectedly");
    pending += decoder.decode(chunk.value, { stream: true });
    const frames = pending.split(/\r?\n\r?\n/);
    pending = frames.pop() ?? "";
    for (const frame of frames) {
      for (const message of parseSse(frame)) if (predicate(message)) return message;
    }
  }
  throw new Error("Timed out waiting for SSE");
}

describe("Agents Chat MCP server", () => {
  it("requires a configured agent bearer token", async () => {
    const fixture = setup();
    const response = await fixture.app.request("/mcp", {
      method: "POST",
      headers: { Accept: "application/json, text/event-stream", "Content-Type": "application/json", Host: "chat.example.test" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} })
    });
    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toBe("Bearer");
  });

  it("advertises the tools and experimental Events capability", async () => {
    const fixture = setup();
    const initialized = await rpc(fixture.app, tokens.alice, "initialize", {
      protocolVersion: "2025-11-25",
      capabilities: {},
      clientInfo: { name: "agents-chat-test", version: "1.0.0" }
    });
    expect(initialized.result?.capabilities.events).toEqual({ listChanged: false });
    expect(initialized.result?.capabilities.extensions["io.modelcontextprotocol/events"]).toEqual({ listChanged: false });
    const tools = await rpc(fixture.app, tokens.alice, "tools/list");
    expect(tools.result?.tools.map((tool: { name: string }) => tool.name).sort()).toEqual([
      "channels_create", "channels_join", "channels_list", "messages_post"
    ]);
    const events = await rpc(fixture.app, tokens.alice, "events/list");
    expect(events.result?.events[0]).toMatchObject({ name: CHAT_ACTIVITY_EVENT, delivery: ["poll", "push"] });
  });

  it("creates, lists, joins, posts, and isolates event history by membership", async () => {
    const fixture = setup();
    const charlieStart = await rpc(fixture.app, tokens.charlie, "events/poll", { name: CHAT_ACTIVITY_EVENT, cursor: null });
    expect(charlieStart.result?.cursor).toBe("chat-event:0");

    const created = await callTool(fixture.app, tokens.alice, "channels_create", { name: "General" });
    const channel = created.structuredContent?.channel;
    expect(channel).toMatchObject({ name: "general", joined: true });
    const bobList = await callTool(fixture.app, tokens.bob, "channels_list");
    expect(bobList.structuredContent?.channels[0]).toMatchObject({ id: channel.id, joined: false, memberCount: 1 });

    const bobStart = await rpc(fixture.app, tokens.bob, "events/poll", { name: CHAT_ACTIVITY_EVENT, cursor: null });
    expect(bobStart.result?.cursor).toBe("chat-event:1");
    await callTool(fixture.app, tokens.bob, "channels_join", { channelId: channel.id });
    await callTool(fixture.app, tokens.alice, "messages_post", { channelId: channel.id, text: "hello agents" });

    const bobEvents = await rpc(fixture.app, tokens.bob, "events/poll", {
      name: CHAT_ACTIVITY_EVENT,
      cursor: bobStart.result?.cursor
    });
    expect(bobEvents.result?.events.map((event: any) => event.data.kind)).toEqual(["member.joined", "message.posted"]);
    expect(bobEvents.result?.events[1].data).toMatchObject({
      channel: { id: channel.id, name: "general" },
      message: { text: "hello agents" },
      sender: { name: "alice" }
    });

    const charlieEvents = await rpc(fixture.app, tokens.charlie, "events/poll", {
      name: CHAT_ACTIVITY_EVENT,
      cursor: charlieStart.result?.cursor
    });
    expect(charlieEvents.result?.events).toEqual([]);
    expect(charlieEvents.result?.cursor).toBe("chat-event:3");
    const rejected = await callTool(fixture.app, tokens.charlie, "messages_post", { channelId: channel.id, text: "nope" });
    expect(rejected.isError).toBe(true);
  });

  it("enforces the 200-character limit", async () => {
    const fixture = setup();
    const created = await callTool(fixture.app, tokens.alice, "channels_create", { name: "limits" });
    const channelId = created.structuredContent?.channel.id;
    const accepted = await callTool(fixture.app, tokens.alice, "messages_post", { channelId, text: "😀".repeat(200) });
    expect(accepted.isError).not.toBe(true);
    const rejected = await callTool(fixture.app, tokens.alice, "messages_post", { channelId, text: "x".repeat(201) });
    expect(rejected.isError).toBe(true);
  });

  it("pushes new messages on an events/stream subscription", async () => {
    const fixture = setup();
    const created = await callTool(fixture.app, tokens.alice, "channels_create", { name: "live" });
    const channelId = created.structuredContent?.channel.id;
    await callTool(fixture.app, tokens.bob, "channels_join", { channelId });
    const abort = new AbortController();
    const response = await fixture.app.request("/mcp", {
      method: "POST",
      signal: abort.signal,
      headers: {
        Authorization: `Bearer ${tokens.bob}`,
        Accept: "application/json, text/event-stream",
        "Content-Type": "application/json",
        Host: "chat.example.test"
      },
      body: JSON.stringify({
        jsonrpc: "2.0", id: "stream-1", method: "events/stream",
        params: { name: CHAT_ACTIVITY_EVENT, cursor: null }
      })
    });
    expect(response.status).toBe(200);
    const reader = response.body!.getReader();
    const active = await readSseUntil(reader, (message) => message.method === "notifications/events/active");
    expect(active.params?._meta).toEqual({ "io.modelcontextprotocol/subscriptionId": "stream-1" });
    await callTool(fixture.app, tokens.alice, "messages_post", { channelId, text: "live delivery" });
    const event = await readSseUntil(reader, (message) => message.method === "notifications/events/event");
    expect(event.params).toMatchObject({
      name: CHAT_ACTIVITY_EVENT,
      data: { kind: "message.posted", message: { text: "live delivery" } }
    });
    abort.abort();
    await reader.cancel();
  });
});
