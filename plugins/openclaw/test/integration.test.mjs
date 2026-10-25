import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { login, CredentialsProvider } from "../dist/auth.js";
import { readJson, writeJson } from "../dist/files.js";
import { ChatClient } from "../dist/mcp.js";
import { parseConfig } from "../dist/config.js";
import { ChatService } from "../dist/service.js";
import { createTools } from "../dist/tools.js";

function scheduler() {
  const abort = new AbortController(), jobs = new Set();
  const api = { signal: abort.signal, version: 1, now: Date.now, schedule({ delayMs = 0, everyMs, run }) {
    let timer, active = Promise.resolve(), closed = false;
    const dispatch = () => { if (closed || abort.signal.aborted) return; active = Promise.resolve().then(run).finally(() => { if (!closed && !abort.signal.aborted && everyMs !== undefined) timer = setTimeout(dispatch, everyMs); }); active.catch(() => {}); };
    timer = setTimeout(dispatch, delayMs);
    const job = { cancel() { closed = true; clearTimeout(timer); }, async stop() { job.cancel(); await active; } }; jobs.add(job); return job;
  }, scope() { return api; }, beginClose() { abort.abort(); for (const job of jobs) job.cancel(); }, async stop() { api.beginClose(); await Promise.all([...jobs].map((j) => j.stop())); } };
  return api;
}
async function waitFor(predicate, message = "condition") {
  const deadline = Date.now() + 12_000;
  while (Date.now() < deadline) { const result = await predicate(); if (result) return result; await new Promise((r) => setTimeout(r, 25)); }
  throw new Error(`Timed out: ${message}`);
}
async function fixture() {
  const { serve } = await import("@hono/node-server");
  const { createApp } = await import("../../../dist/app.js"), { loadConfig } = await import("../../../dist/config.js");
  let instance;
  const server = serve({ hostname: "127.0.0.1", port: 0, fetch: (request) => instance.app.fetch(request) }); await once(server, "listening");
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  instance = createApp(loadConfig({ PUBLIC_BASE_URL: baseUrl, DATABASE_URL: ":memory:", GITHUB_CLIENT_ID: "fixture", GITHUB_CLIENT_SECRET: "local-only" }), {
    github: { async identify(code) { return code === "other" ? { id: 222222, login: "other" } : { id: 111111, login: "owner" }; } }
  });
  return { baseUrl, async close() { server.closeAllConnections(); server.close(); await instance.close(); } };
}
async function authorize(directory, baseUrl, account = "same") {
  let approval;
  const completed = login(directory, `${baseUrl}/mcp`, (url) => {
    approval = (async () => {
      const redirect = new URL(url).searchParams.get("redirect_uri");
      assert.equal((await fetch(`${redirect}?state=wrong&code=wrong`)).status, 400);
      const start = await fetch(url, { redirect: "manual" });
      const state = new URL(start.headers.get("location")).searchParams.get("state");
      const consent = await fetch(`${baseUrl}/oauth/github/callback?${new URLSearchParams({ state, code: account })}`);
      const approvalToken = /name="approval_token" value="([^"]+)"/.exec(await consent.text())?.[1]; assert(approvalToken);
      const approved = await fetch(`${baseUrl}/oauth/approve`, { method: "POST", headers: { Origin: baseUrl }, redirect: "manual", body: new URLSearchParams({ transaction_id: state, approval_token: approvalToken, decision: "allow" }) });
      assert.equal((await fetch(approved.headers.get("location"))).status, 200);
    })(); approval.catch(() => {});
  });
  await completed; await approval;
}

for (const delivery of ["push", "poll"]) test(`real MCP/OAuth: two local agents, isolated account, channel, ring and restart (${delivery})`, { timeout: 45_000 }, async () => {
  const server = await fixture(), schedules = [], services = [], wakes = [];
  const directory = await mkdtemp(join(tmpdir(), "agents-chat-plugin-e2e-"));
  const foreignDirectory = await mkdtemp(join(tmpdir(), "agents-chat-plugin-foreign-"));
  const config = parseConfig({ serverUrl: `${server.baseUrl}/mcp`, delivery, agents: [
    { agentId: "main", name: "Alpha", description: "Coordinator" }, { agentId: "researcher", name: "Beta", description: "Researcher" }
  ] });
  const start = async (cfg, dir) => {
    const clock = scheduler(), service = new ChatService(cfg, dir, (target) => wakes.push(target.agentId), () => {});
    schedules.push(clock); services.push(service); await service.start(clock);
    await waitFor(() => service.live.size === cfg.agents.length, "live agents"); return { service, clock };
  };
  try {
    await authorize(directory, server.baseUrl); await authorize(foreignDirectory, server.baseUrl, "other");
    // Force both owner connections through a real 401/refresh-token rotation.
    const oauthPath = join(directory, "oauth.json"), oauth = await readJson(oauthPath);
    oauth.tokens.access_token = "expired-fixture-access-token"; await writeJson(oauthPath, oauth);
    let { service, clock } = await start(config, directory);
    const foreign = (await start(parseConfig({ serverUrl: config.serverUrl, delivery, agents: [{ agentId: "main", name: "Foreign", description: "Other account" }] }), foreignDirectory)).service;
    const makeCall = (localId) => {
      const tools = createTools(service, config, { agentId: localId });
      return async (name, args = {}) => (await tools.find((t) => t.name === name).execute("fixture-call", args)).details;
    };
    let a = makeCall("main"), b = makeCall("researcher");
    const beta = service.live.get("researcher").registration.agent.id;
    await waitFor(async () => (await a("agents_chat_list")).agents.find((agent) => agent.id === beta)?.deliveryModes.includes(delivery), "active subscription");
    const sent = await a("agents_chat_send", { targetAgentId: beta, text: "Alpha says hello", idempotencyKey: "same-send" });
    const retry = await a("agents_chat_send", { targetAgentId: beta, text: "Alpha says hello", idempotencyKey: "same-send" }); assert.equal(sent.id, retry.id);
    await waitFor(async () => (await b("agents_chat_inbox")).events.some((e) => e.eventId === sent.eventId), "direct message");
    assert.equal((await b("agents_chat_inbox")).events.filter((e) => e.eventId === sent.eventId).length, 1);
    assert(wakes.includes("researcher"));
    const list = await foreign.tool("main", "agents_list", {}); assert.equal(list.agents.length, 1);
    await assert.rejects(foreign.tool("main", "messages_send", { targetAgentId: beta, text: "cross account", idempotencyKey: "foreign" }), /not_found/);
    const { channel } = await a("agents_chat_channels_create", { name: "plugin-e2e" });
    await a("agents_chat_channels_join", { channelId: channel.id }); await b("agents_chat_channels_join", { channelId: channel.id });
    await a("agents_chat_messages_post", { channelId: channel.id, text: "Channel hello" });
    await waitFor(async () => (await b("agents_chat_inbox")).events.some((e) => e.data.message?.text === "Channel hello"), "channel message");
    const pair = await service.live.get("main").client.tool("rings_pair", { targetAgentId: beta, name: "Fixture ring" });
    const ringResponse = await fetch(pair.webhookUrl, { method: "POST", headers: { Authorization: `Bearer ${pair.ingestToken}`, "Content-Type": "application/json" }, body: JSON.stringify({ message_id: "ring-fixture", recorded_at: new Date().toISOString(), transcript: "Ring transcript, longer than a normal agent message. ".repeat(8) }) });
    assert.equal(ringResponse.status, 202);
    await waitFor(async () => (await b("agents_chat_inbox")).events.some((e) => e.data.source === "ring"), "ring event");
    const pending = await b("agents_chat_inbox"); assert(!JSON.stringify(pending).includes("agentToken"));
    await b("agents_chat_ack", { eventIds: pending.events.map((e) => e.eventId) }); assert.equal((await b("agents_chat_inbox")).events.length, 0);
    const alphaToken = service.live.get("main").registration.agentToken;
    clock.beginClose(); await service.stop(); await clock.stop();
    const offline = new ChatClient(config.serverUrl, new CredentialsProvider(directory, config.serverUrl));
    try { await offline.connect(); await offline.tool("messages_send", { agentToken: alphaToken, targetAgentId: beta, text: "While offline", idempotencyKey: "offline-send" }); }
    finally { await offline.close(); }
    const otherClient = foreign.live.get("main").client;
    // The owner's server-side registration survives a client restart, with a renewed lease.
    const { service: restarted, clock: newClock } = await start(config, directory); service = restarted; clock = newClock; a = makeCall("main"); b = makeCall("researcher");
    assert.equal(service.live.get("researcher").registration.agent.id, beta);
    await waitFor(async () => (await b("agents_chat_inbox")).events.some((e) => e.data.message?.text === "While offline"), "offline replay");
    await a("agents_chat_send", { targetAgentId: beta, text: "After reconnect", idempotencyKey: "restart-send" });
    await waitFor(async () => (await b("agents_chat_inbox")).events.some((e) => e.data.message?.text === "After reconnect"), "reconnected delivery");
    assert.equal((await b("agents_chat_inbox")).events.filter((e) => e.data.message?.text === "After reconnect").length, 1);
    assert(otherClient);
  } finally {
    for (const clock of schedules) clock.beginClose();
    await Promise.all(services.map((s) => s.stop())); await Promise.all(schedules.map((s) => s.stop())); await server.close();
  }
});
