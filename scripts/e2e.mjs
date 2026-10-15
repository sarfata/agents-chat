import assert from "node:assert/strict";
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { once } from "node:events";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { createApp } from "../dist/app.js";
import { loadConfig } from "../dist/config.js";
import { runMultiAgentScenario } from "./multi-agent-scenario.mjs";
import { runGatewayScenario } from "./gateway-e2e.mjs";
import { runMcporterSmoke } from "./mcporter-smoke.mjs";

const secret = `whsec_${randomBytes(32).toString("base64")}`, deliveries = [];
const receiver = new Hono().post("/hook", async (c) => {
  const raw = await c.req.text(), id = c.req.header("webhook-id"), timestamp = c.req.header("webhook-timestamp");
  const signature = createHmac("sha256", Buffer.from(secret.slice(6), "base64")).update(`${id}.${timestamp}.${raw}`).digest("base64");
  const expected = Buffer.from(`v1,${signature}`), actual = Buffer.from(c.req.header("webhook-signature") ?? "");
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual) || Math.abs(Date.now() / 1000 - Number(timestamp)) > 300) return c.json({ error: "bad signature" }, 401);
  const body = JSON.parse(raw);
  if (body.type === "verification") return c.json({ challenge: body.challenge });
  deliveries.push(body); return c.json({ ok: true });
});
const receiverServer = serve({ fetch: receiver.fetch, hostname: "127.0.0.1", port: 0 });
await once(receiverServer, "listening");
const receiverUrl = `http://127.0.0.1:${receiverServer.address().port}/hook`;
// The adapter is injected only into this local fixture. Production continues to
// require public HTTPS, DNS pinning, TLS validation and redirect rejection.
let instance;
const server = serve({ hostname: "127.0.0.1", port: 0, fetch: (request) => instance.app.fetch(request) });
await once(server, "listening");
const baseUrl = `http://127.0.0.1:${server.address().port}`;
instance = createApp(loadConfig({ PUBLIC_BASE_URL: baseUrl, DATABASE_URL: ":memory:", GITHUB_CLIENT_ID: "local-fixture", GITHUB_CLIENT_SECRET: "local-only" }), {
  github: { async identify(code) { return code === "other" ? { id: 222222, login: "other-fixture" } : { id: 111111, login: "same-fixture" }; } },
  webhookClient: { async post(url, raw, headers, signal) {
    assert.equal(url, "https://fixture-receiver.example/hook");
    const response = await fetch(receiverUrl, { method: "POST", headers, body: raw, signal }); return { status: response.status, body: await response.text() };
  } }
});

async function authorize(account, clientName) {
  const verifier = randomBytes(32).toString("base64url"), challenge = createHash("sha256").update(verifier).digest("base64url");
  const callback = "http://127.0.0.1:9999/callback";
  const registered = await fetch(`${baseUrl}/oauth/register`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ client_name: clientName, redirect_uris: [callback] }) });
  assert.equal(registered.status, 201); const client = await registered.json();
  const start = await fetch(`${baseUrl}/oauth/authorize?${new URLSearchParams({ client_id: client.client_id, redirect_uri: callback, response_type: "code", code_challenge_method: "S256", code_challenge: challenge, resource: `${baseUrl}/mcp`, scope: "chat:read chat:write events:read offline_access", state: "fixture-state" })}`, { redirect: "manual" });
  const state = new URL(start.headers.get("location")).searchParams.get("state");
  const consent = await fetch(`${baseUrl}/oauth/github/callback?${new URLSearchParams({ state, code: account })}`);
  const approval = /name="approval_token" value="([^"]+)"/.exec(await consent.text())?.[1]; assert(approval);
  const approved = await fetch(`${baseUrl}/oauth/approve`, { method: "POST", headers: { Origin: baseUrl }, redirect: "manual", body: new URLSearchParams({ transaction_id: state, approval_token: approval, decision: "allow" }) });
  const code = new URL(approved.headers.get("location")).searchParams.get("code"); assert(code);
  const response = await fetch(`${baseUrl}/oauth/token`, { method: "POST", body: new URLSearchParams({ grant_type: "authorization_code", code, client_id: client.client_id, redirect_uri: callback, code_verifier: verifier, resource: `${baseUrl}/mcp` }) });
  assert.equal(response.status, 200); return (await response.json()).access_token;
}
try {
  const accountToken = await authorize("same", "alpha-fixture"), secondClientToken = await authorize("same", "beta-fixture"), otherAccountToken = await authorize("other", "foreign-fixture");
  const result = await runMultiAgentScenario({ baseUrl, accountToken, secondClientToken, otherAccountToken, webhook: {
    url: "https://fixture-receiver.example/hook", secret, async next(eventId) {
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) { const event = deliveries.find((d) => d.eventId === eventId); if (event) return event; await new Promise((resolve) => setTimeout(resolve, 20)); }
      throw new Error("Webhook delivery timed out");
    }
  } });
  console.log(JSON.stringify(result));
  await runGatewayScenario(baseUrl, accountToken);
  if (process.env.MCPORTER_SOURCE) await runMcporterSmoke({ baseUrl, token: accountToken, mcporterSource: process.env.MCPORTER_SOURCE });
} finally {
  server.closeAllConnections(); receiverServer.closeAllConnections();
  server.close(); receiverServer.close(); await instance.close();
}
