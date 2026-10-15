import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { z } from "zod/v4";

/** Exercise the real Events-enabled MCPorter runtime + official client SDK.
 * Supply an already-authorized token; this never initiates OAuth grants. */
export async function runMcporterSmoke({ baseUrl, token, mcporterSource, webhook }) {
  const { createRuntime } = await import(pathToFileURL(`${mcporterSource}/dist/index.js`));
  const definition = { name: "private-smoke", command: { kind: "http", url: new URL(`${baseUrl}/mcp`), headers: { Authorization: `Bearer ${token}` } } };
  const runtimes = await Promise.all([0, 1].map(() => createRuntime({ servers: [definition] })));
  const registrations = [], abort = new AbortController(), controllers = [];
  let streaming;
  try {
    const connections = await Promise.all(runtimes.map((r) => r.connect("private-smoke", { disableOAuth: true })));
    const [a, b] = connections.map((c) => c.client);
    const anyObject = z.record(z.string(), z.unknown());
    const tool = async (client, name, args) => { const result = await client.callTool({ name, arguments: args }); assert(!result.isError, `${name} failed`); return result.structuredContent; };
    for (const [index, client] of [a, b].entries()) {
      const reg = await tool(client, "agents_register", { name: `mcporter-${index}-${randomUUID().slice(0, 8)}`, description: "Production MCPorter smoke test agent" }); registrations.push([client, reg]);
    }
    const ra = registrations[0][1], rb = registrations[1][1];
    const list = await a.request({ method: "events/list", params: {} }, z.object({ events: z.array(anyObject) }));
    assert.equal(list.events.length, 3);
    const occurrences = [], received = deferred(), active = deferred(); controllers.push(received, active);
    b.setNotificationHandler("notifications/events/active", { params: anyObject }, () => active.resolve());
    b.setNotificationHandler("notifications/events/event", { params: anyObject }, (params) => { occurrences.push(params); received.resolve(params); });
    streaming = b.request({ method: "events/stream", params: { name: "agents-chat.inbox", arguments: { agentToken: rb.agentToken }, cursor: rb.inbox.cursor } }, anyObject, { signal: abort.signal, timeout: 60_000 });
    streaming.catch((error) => { if (!abort.signal.aborted) { active.reject(error); received.reject(error); } });
    await active.promise;
    const sent = await tool(a, "messages_send", { agentToken: ra.agentToken, targetAgentId: rb.agent.id, text: "MCPorter alpha says hello", idempotencyKey: randomUUID() });
    const event = await received.promise; assert.equal(event.eventId, sent.eventId); assert.equal(event.data.sender.id, ra.agent.id);
    await tool(b, "messages_send", { agentToken: rb.agentToken, targetAgentId: ra.agent.id, text: "MCPorter beta replies", idempotencyKey: randomUUID(), inReplyTo: sent.id });
    const polled = await a.request({ method: "events/poll", params: { name: "agents-chat.inbox", arguments: { agentToken: ra.agentToken }, cursor: ra.inbox.cursor } }, anyObject);
    assert.equal(polled.events[0].data.message.inReplyTo, sent.id);
    console.log("PASS production: two MCPorter agents exchange live push/poll messages");
    if (webhook) {
      const delivery = { mode: "webhook", url: webhook.url, secret: webhook.secret };
      const hookArgs = { name: "agents-chat.inbox", arguments: { agentToken: rb.agentToken }, cursor: event.cursor, delivery, ttlMs: 60_000 };
      const sub = await b.request({ method: "events/subscribe", params: hookArgs }, anyObject);
      const receipt = await tool(a, "messages_send", { agentToken: ra.agentToken, targetAgentId: rb.agent.id, text: "Production signed webhook", idempotencyKey: randomUUID() });
      const delivered = await webhook.next(receipt.eventId); assert.equal(delivered.data.message.text, "Production signed webhook");
      const refresh = await b.request({ method: "events/subscribe", params: { ...hookArgs, cursor: delivered.cursor } }, anyObject); assert.equal(refresh.id, sub.id);
      await b.request({ method: "events/unsubscribe", params: { name: hookArgs.name, arguments: hookArgs.arguments, delivery: { url: delivery.url } } }, anyObject);
      console.log("PASS production: signed HTTPS webhook through ngrok, including refresh/unsubscribe");
    }
    const pair = await tool(a, "rings_pair", { targetAgentId: rb.agent.id, name: "Production test ring" });
    const transcript = "Ring production test ".repeat(20).trim();
    const response = await fetch(pair.webhookUrl, { method: "POST", headers: { Authorization: `Bearer ${pair.ingestToken}`, "Content-Type": "application/json" }, body: JSON.stringify({ message_id: randomUUID(), recorded_at: new Date().toISOString(), transcript }), signal: AbortSignal.timeout(10_000) }); assert.equal(response.status, 202);
    const receipt = await response.json();
    const deadline = Date.now() + 10_000;
    while (!occurrences.some((e) => e.eventId === receipt.eventId) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 25));
    const ring = occurrences.find((e) => e.eventId === receipt.eventId); assert(ring); assert.equal(ring.data.source, "ring"); assert.equal(ring.data.message.text, transcript);
    await tool(a, "rings_unpair", { pairingId: pair.pairingId });
    console.log("PASS production: paired ring message arrives live in MCPorter without truncation");
    return { ok: true, clients: "MCPorter + official MCP client SDK", agents: 2, modes: webhook ? ["poll", "push", "webhook"] : ["poll", "push"] };
  } finally {
    abort.abort(); await streaming?.catch(() => {});
    for (const d of controllers) d.clear();
    for (const [client, reg] of registrations) await client.callTool({ name: "agents_unregister", arguments: { agentToken: reg.agentToken } }).catch(() => {});
    for (const r of runtimes) await r.close();
  }
}
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  const timer = setTimeout(() => reject(new Error("MCPorter event timed out")), 10_000);
  // Avoid an unhandled rejection if connection establishment fails first.
  promise.catch(() => {});
  return { promise, resolve: (value) => { clearTimeout(timer); resolve(value); }, reject: (value) => { clearTimeout(timer); reject(value); }, clear: () => clearTimeout(timer) };
}
