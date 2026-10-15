import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { McpTestClient } from "./mcp-client.mjs";

/** Independent clients over real HTTP. No access to server internals. */
export async function runMultiAgentScenario({ baseUrl, accountToken, secondClientToken = accountToken, otherAccountToken, webhook, report = console.log }) {
  const a = new McpTestClient(baseUrl, accountToken), b = new McpTestClient(baseUrl, secondClientToken), c = new McpTestClient(baseUrl, otherAccountToken);
  const registrations = [], streams = [], suffix = randomUUID().slice(0, 8);
  const register = async (client, name) => { const reg = await client.tool("agents_register", { name: `${name}-${suffix}`, description: `Deterministic E2E ${name} client` }); registrations.push([client, reg]); return reg; };
  const checks = [];
  const checked = (name) => { checks.push(name); report(`PASS ${name}`); };
  try {
    for (const client of [a, b, c]) {
      const init = await client.initialize(); assert.match(init.instructions, /private to this GitHub account/);
      const tools = (await client.rpc("tools/list")).tools;
      for (const tool of tools) for (const hint of ["readOnlyHint", "destructiveHint", "openWorldHint"]) assert.equal(typeof tool.annotations[hint], "boolean");
      assert.equal(tools.length, 11);
      const events = (await client.rpc("events/list")).events;
      for (const name of ["agents-chat.activity", "agents-chat.inbox", "agents-chat.presence"]) assert.deepEqual(events.find((e) => e.name === name).delivery, ["poll", "push", "webhook"]);
    }
    checked("initialization, event discovery, and explicit tool hints");
    const ra = await register(a, "alpha"), rb = await register(b, "beta"), rc = await register(c, "foreign");
    assert.notEqual(ra.agent.id, rb.agent.id);
    const inbox = (reg, cursor = reg.inbox.cursor) => ({ name: "agents-chat.inbox", arguments: { agentToken: reg.agentToken }, cursor });
    await a.rpc("events/poll", inbox(ra)); await c.rpc("events/poll", inbox(rc));
    const bs = await b.stream(inbox(rb)); streams.push(bs); await bs.next("notifications/events/active");
    const own = (await a.tool("agents_list")).agents;
    assert(own.some((v) => v.id === ra.agent.id)); assert(own.some((v) => v.id === rb.agent.id)); assert(!own.some((v) => v.id === rc.agent.id));
    assert(!(await c.tool("agents_list")).agents.some((v) => v.id === ra.agent.id || v.id === rb.agent.id));
    checked("distinct agents and account-private listening directory");

    const outgoing = { agentToken: ra.agentToken, targetAgentId: rb.agent.id, text: "ping from alpha", idempotencyKey: randomUUID() };
    const receipt = await a.tool("messages_send", outgoing);
    const delivered = await bs.next("notifications/events/event");
    assert.equal(delivered.eventId, receipt.eventId); assert.equal(delivered.data.sender.id, ra.agent.id); assert.equal(delivered.data.message.text, outgoing.text);
    const duplicate = await a.tool("messages_send", outgoing); assert.equal(duplicate.duplicate, true); assert.equal(duplicate.eventId, receipt.eventId);
    const conflict = await a.tool("messages_send", { ...outgoing, text: "different" }, { allowError: true }); assert.equal(conflict.structuredContent.error.code, "conflict");
    const reply = await b.tool("messages_send", { agentToken: rb.agentToken, targetAgentId: ra.agent.id, text: "pong from beta", inReplyTo: receipt.id, idempotencyKey: randomUUID() });
    const polled = await a.rpc("events/poll", inbox(ra)); assert.equal(polled.events.find((e) => e.eventId === reply.eventId).data.message.inReplyTo, receipt.id);
    checked("real-time push, agent reply by polling, and idempotent delivery");

    for (const [name, args] of [
      ["messages_send", { agentToken: rc.agentToken, targetAgentId: ra.agent.id, text: "forbidden", idempotencyKey: randomUUID() }],
      ["agents_renew", { agentToken: ra.agentToken }], ["agents_unregister", { agentToken: ra.agentToken }],
      ["rings_pair", { targetAgentId: ra.agent.id, name: "foreign" }]
    ]) assert.equal((await c.tool(name, args, { allowError: true })).isError, true);
    assert((await c.rpc("events/poll", inbox(ra), { allowError: true })).error);
    const forged = await a.tool("messages_send", { ...outgoing, agentToken: rb.agent.id, idempotencyKey: randomUUID() }, { allowError: true }); assert.equal(forged.isError, true);
    checked("foreign account and forged agent credential rejection");

    const channel = (await a.tool("channels_create", { name: `e2e-${suffix}`, agentToken: ra.agentToken })).channel;
    assert(!(await c.tool("channels_list")).channels.some((v) => v.id === channel.id));
    for (const [name, args] of [["channels_join", { channelId: channel.id }], ["messages_post", { channelId: channel.id, text: "foreign" }]]) assert.equal((await c.tool(name, args, { allowError: true })).isError, true);
    const start = await b.rpc("events/poll", { name: "agents-chat.activity", arguments: { agentToken: rb.agentToken } });
    await b.tool("channels_join", { channelId: channel.id, agentToken: rb.agentToken });
    await a.tool("messages_post", { channelId: channel.id, agentToken: ra.agentToken, text: "private channel" });
    const activity = await b.rpc("events/poll", { name: "agents-chat.activity", arguments: { agentToken: rb.agentToken }, cursor: start.cursor });
    assert.deepEqual(activity.events.map((v) => v.data.kind), ["member.joined", "message.posted"]);
    checked("private channels and per-agent membership events");

    await bs.close();
    const offline = await a.tool("messages_send", { ...outgoing, text: "while disconnected", idempotencyKey: randomUUID() });
    const reconnect = await b.stream(inbox(rb, delivered.cursor)); streams.push(reconnect); await reconnect.next("notifications/events/active");
    const replay = await reconnect.next("notifications/events/event"); assert.equal(replay.eventId, offline.eventId);
    await reconnect.close();
    checked("stream cancellation and cursor replay after reconnect");

    if (webhook) {
      const delivery = { mode: "webhook", url: webhook.url, secret: webhook.secret };
      const initial = await b.rpc("events/poll", inbox(rb, null));
      const sub = await b.rpc("events/subscribe", { ...inbox(rb, initial.cursor), ttlMs: 60_000, delivery });
      const sent = await a.tool("messages_send", { ...outgoing, text: "signed webhook", idempotencyKey: randomUUID() });
      const hook = await webhook.next(sent.eventId); assert.equal(hook.data.message.text, "signed webhook");
      const refreshed = await b.rpc("events/subscribe", { ...inbox(rb, hook.cursor), ttlMs: 60_000, delivery }); assert.equal(refreshed.id, sub.id);
      const foreign = await c.rpc("events/unsubscribe", { ...inbox(rb), delivery: { url: delivery.url } }, { allowError: true }); assert(foreign.error);
      await b.rpc("events/unsubscribe", { ...inbox(rb), delivery: { url: delivery.url } });
      checked("signed HTTP webhook verification, delivery, refresh, and unsubscribe isolation");
    }

    const pairing = await a.tool("rings_pair", { targetAgentId: ra.agent.id, name: "e2e paired ring" });
    const ringBody = { message_id: randomUUID(), recorded_at: new Date().toISOString(), transcript: "ring transcript ".repeat(50) };
    const ringRequest = (token, body = ringBody) => fetch(pairing.webhookUrl, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(10_000) });
    assert.equal((await ringRequest("wrong")).status, 401);
    const accepted = await ringRequest(pairing.ingestToken); assert.equal(accepted.status, 202); const ringReceipt = await accepted.json();
    assert.equal((await (await ringRequest(pairing.ingestToken)).json()).duplicate, true);
    const ringEvents = await a.rpc("events/poll", inbox(ra, polled.cursor));
    const ringEvent = ringEvents.events.find((e) => e.eventId === ringReceipt.eventId); assert.equal(ringEvent.data.source, "ring"); assert.equal(ringEvent.data.message.text, ringBody.transcript);
    const revoked = await c.tool("rings_unpair", { pairingId: pairing.pairingId }, { allowError: true }); assert.equal(revoked.isError, true);
    await a.tool("rings_unpair", { pairingId: pairing.pairingId }); assert.equal((await ringRequest(pairing.ingestToken)).status, 401);
    checked("paired ring ingest, long transcript, deduplication, and revocation");
    await a.tool("agents_renew", { agentToken: ra.agentToken });
    return { ok: true, checks, agents: 3, accounts: 2, deliveryModes: webhook ? ["poll", "push", "webhook"] : ["poll", "push"] };
  } finally {
    for (const stream of streams) await stream.close().catch(() => {});
    for (const [client, reg] of registrations) await client.tool("agents_unregister", { agentToken: reg.agentToken }, { allowError: true }).catch(() => {});
  }
}
