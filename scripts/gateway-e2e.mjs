// Optional cross-repository E2E: PEBBLE_GATEWAY_SOURCE points to a built checkout.
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { once } from "node:events";
import { serve } from "@hono/node-server";
import { McpTestClient } from "./mcp-client.mjs";

export async function runGatewayScenario(chatBaseUrl, accountToken) {
  const root = process.env.PEBBLE_GATEWAY_SOURCE;
  if (!root) return;
  const { createApp } = await import(pathToFileURL(`${root}/apps/gateway/dist/server.js`));
  const client = new McpTestClient(chatBaseUrl, accountToken);
  const registration = await client.tool("agents_register", { name: "ring-gateway-e2e", description: "Real gateway ingest test receiver" });
  const args = { name: "agents-chat.inbox", arguments: { agentToken: registration.agentToken }, cursor: registration.inbox.cursor };
  const stream = await client.stream(args); await stream.next("notifications/events/active");
  const pairing = await client.tool("rings_pair", { targetAgentId: registration.agent.id, name: "Gateway E2E Ring" });
  let gateway;
  const server = serve({ hostname: "127.0.0.1", port: 0, fetch: (r) => gateway.app.fetch(r) }); await once(server, "listening");
  const gatewayBase = `http://127.0.0.1:${server.address().port}`, oldEnv = { ...process.env };
  Object.assign(process.env, { PUBLIC_BASE_URL: gatewayBase, DATABASE_URL: ":memory:", TOKEN_PEPPER: "e2e-fixture", APP_ENCRYPTION_KEY: "e2e-fixture", SIGNUPS_ENABLED: "true", NTFY_ENABLED: "false" });
  gateway = createApp({ agentsChatHttp: { async post(url, raw, headers, signal) {
    assert.equal(url, `https://agents-chat.fly.dev${new URL(pairing.webhookUrl).pathname}`);
    const response = await fetch(pairing.webhookUrl, { method: "POST", headers, body: raw, signal }); return { status: response.status, body: await response.text() };
  } } });
  process.env = oldEnv;
  try {
    const signup = await fetch(`${gatewayBase}/api/auth/signup`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: "gateway-e2e@example.test", password: "local-fixture-password" }) }); assert.equal(signup.status, 200);
    const cookie = signup.headers.get("set-cookie").split(";")[0];
    const create = async (path, body) => {
      const response = await fetch(`${gatewayBase}${path}`, { method: "POST", headers: { Cookie: cookie, "Content-Type": "application/json" }, body: JSON.stringify(body) }); assert.equal(response.status, 200); return response.json();
    };
    const connector = await create("/api/dashboard/agents", { kind: "codex", name: "Paired Agents Chat", encryption_public_key: "" });
    const ring = await create("/api/dashboard/rings", { name: "Fixture Ring" });
    const paired = await fetch(`${gatewayBase}/api/agent/agents-chat/pair`, { method: "POST", headers: { Authorization: `Bearer ${connector.agent_token}`, "Content-Type": "application/json" }, body: JSON.stringify({ webhookUrl: `https://agents-chat.fly.dev${new URL(pairing.webhookUrl).pathname}`, ingestToken: pairing.ingestToken }) }); assert.equal(paired.status, 200);
    for (const mode of ["json", "multipart"]) {
      const transcript = `Codex, ${mode} ring E2E `.repeat(40).trim(), messageId = `ring-${mode}`;
      const headers = { Authorization: `Bearer ${ring.ingest_token}` }; let body;
      if (mode === "json") { headers["Content-Type"] = "application/json"; body = JSON.stringify({ message_id: messageId, recorded_at: new Date().toISOString(), transcript, metadata: {} }); }
      else { body = new FormData(); body.set("message_id", messageId); body.set("recorded_at", new Date().toISOString()); body.set("transcription", transcript); }
      const response = await fetch(`${gatewayBase}/api/ring/ingest`, { method: "POST", headers, body }); assert.equal(response.status, 202); const receipt = await response.json(); assert.equal(receipt.ok, true);
      // Exercise the background worker as well as a manual wake; both drain the
      // same persisted outbox, never process the transcript inside ingest.
      await gateway.agentsChat.drain();
      const event = await stream.next("notifications/events/event"); assert.equal(event.data.source, "ring"); assert.equal(event.data.message.text, transcript);
      assert.equal(gateway.db.prepare(`select status from agent_deliveries where id = ?`).get(receipt.deliveries[0].delivery_id).status, "acked");
    }
    console.log("PASS full ring JSON/multipart ingest -> encrypted gateway outbox -> paired Agents Chat -> live MCP agent");
  } finally {
    await stream.close(); server.closeAllConnections(); server.close(); await gateway.close();
    await client.tool("agents_unregister", { agentToken: registration.agentToken });
  }
}
