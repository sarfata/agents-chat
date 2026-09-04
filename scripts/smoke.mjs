const baseUrl = (process.env.AGENTS_CHAT_URL ?? "http://localhost:3000").replace(/\/$/, "");
const token = process.env.AGENTS_CHAT_TOKEN;
if (!token) throw new Error("AGENTS_CHAT_TOKEN is required");
let requestId = 0;

async function rpc(method, params = {}) {
  const id = ++requestId;
  const response = await fetch(`${baseUrl}/mcp`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json, text/event-stream",
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params })
  });
  if (!response.ok) throw new Error(`${method} returned HTTP ${response.status}`);
  const text = await response.text();
  const messages = response.headers.get("content-type")?.includes("text/event-stream")
    ? text.split(/\r?\n/).filter((line) => line.startsWith("data:")).map((line) => JSON.parse(line.slice(5)))
    : [JSON.parse(text)];
  const message = messages.find((candidate) => candidate.id === id);
  if (!message) throw new Error(`${method} returned no matching JSON-RPC response`);
  if (message.error) throw new Error(`${method} failed: ${message.error.message}`);
  return message.result;
}

await rpc("initialize", {
  protocolVersion: "2025-11-25",
  capabilities: {},
  clientInfo: { name: "agents-chat-smoke", version: "1.0.0" }
});
const suffix = Date.now().toString(36);
const created = await rpc("tools/call", {
  name: "channels_create",
  arguments: { name: `smoke-${suffix}` }
});
if (created.isError) throw new Error(created.content?.[0]?.text ?? "channels_create failed");
const channelId = created.structuredContent?.channel?.id;
if (!channelId) throw new Error("channels_create did not return a channel ID");
const started = await rpc("events/poll", { name: "agents-chat.activity", cursor: null });
const posted = await rpc("tools/call", {
  name: "messages_post",
  arguments: { channelId, text: "production smoke test" }
});
if (posted.isError) throw new Error(posted.content?.[0]?.text ?? "messages_post failed");
const events = await rpc("events/poll", {
  name: "agents-chat.activity",
  cursor: started.cursor
});
const delivered = events.events?.some(
  (event) => event.data?.kind === "message.posted" && event.data?.message?.text === "production smoke test"
);
if (!delivered) throw new Error("The posted message was not delivered by events/poll");
console.log(JSON.stringify({ ok: true, channelId, cursor: events.cursor }));
