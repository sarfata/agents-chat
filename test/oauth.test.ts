import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";

const fixtures: Array<ReturnType<typeof createApp>> = [];

afterEach(async () => {
  for (const fixture of fixtures.splice(0)) await fixture.close();
  vi.restoreAllMocks();
});

function setup() {
  const github = {
    identify: vi.fn(async () => ({ id: 12345678, login: "octo-agent" }))
  };
  const config = loadConfig({
    PORT: "3000",
    PUBLIC_BASE_URL: "https://chat.example.test",
    DATABASE_URL: ":memory:",
    AGENTS_CHAT_TOKENS_JSON: "{}",
    GITHUB_CLIENT_ID: "github-client-id",
    GITHUB_CLIENT_SECRET: "github-client-secret"
  });
  const fixture = createApp(config, { github });
  fixtures.push(fixture);
  return { ...fixture, github };
}

async function registerClient(fixture: ReturnType<typeof setup>, redirectUri = "http://127.0.0.1:34567/callback") {
  const response = await fixture.app.request("/oauth/register", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_name: "Test MCP client",
      redirect_uris: [redirectUri],
      application_type: "native",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none"
    })
  });
  expect(response.status).toBe(201);
  const body = await response.json() as { client_id: string };
  return { clientId: body.client_id, redirectUri };
}

async function completeAuthorization(
  fixture: ReturnType<typeof setup>,
  scope = "chat:read chat:write events:read offline_access"
) {
  const { clientId, redirectUri } = await registerClient(fixture);
  const verifier = "test-verifier-that-is-definitely-longer-than-forty-three-characters";
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const authorize = new URL("https://chat.example.test/oauth/authorize");
  authorize.searchParams.set("response_type", "code");
  authorize.searchParams.set("client_id", clientId);
  authorize.searchParams.set("redirect_uri", redirectUri);
  authorize.searchParams.set("state", "client-state");
  authorize.searchParams.set("code_challenge", challenge);
  authorize.searchParams.set("code_challenge_method", "S256");
  authorize.searchParams.set("resource", "https://chat.example.test/mcp");
  authorize.searchParams.set("scope", scope);

  const authorizationResponse = await fixture.app.request(`${authorize.pathname}${authorize.search}`);
  expect(authorizationResponse.status).toBe(302);
  const githubLocation = new URL(authorizationResponse.headers.get("location")!);
  expect(githubLocation.origin).toBe("https://github.com");
  expect(githubLocation.pathname).toBe("/login/oauth/authorize");
  expect(githubLocation.searchParams.get("scope")).toBeNull();
  const transactionId = githubLocation.searchParams.get("state")!;

  const callback = await fixture.app.request(`/oauth/github/callback?state=${encodeURIComponent(transactionId)}&code=github-code`);
  expect(callback.status).toBe(200);
  expect(callback.headers.get("content-security-policy")).toContain("form-action 'self' http://127.0.0.1:34567;");
  expect(callback.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
  const consent = await callback.text();
  expect(consent).toContain("Test MCP client");
  expect(consent).toContain("octo-agent");
  expect(consent).toContain("127.0.0.1:34567");
  expect(consent).not.toContain("github-client-secret");
  const approvalToken = hiddenInput(consent, "approval_token");

  const approval = await fixture.app.request("/oauth/approve", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      transaction_id: transactionId,
      approval_token: approvalToken,
      decision: "allow"
    }).toString()
  });
  expect(approval.status).toBe(302);
  const clientCallback = new URL(approval.headers.get("location")!);
  expect(clientCallback.origin + clientCallback.pathname).toBe(redirectUri);
  expect(clientCallback.searchParams.get("state")).toBe("client-state");
  expect(clientCallback.searchParams.get("iss")).toBe("https://chat.example.test");
  return { clientId, redirectUri, verifier, code: clientCallback.searchParams.get("code")! };
}

async function tokenRequest(fixture: ReturnType<typeof setup>, body: Record<string, string>) {
  return fixture.app.request("/oauth/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(body).toString()
  });
}

describe("GitHub-backed MCP OAuth", () => {
  it("shares write limits across clients, refreshes and logins for one GitHub account", async () => {
    const now = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(now);
    const fixture = setup();
    async function login() {
      const authorization = await completeAuthorization(fixture);
      const response = await tokenRequest(fixture, {
        grant_type: "authorization_code", code: authorization.code,
        client_id: authorization.clientId, redirect_uri: authorization.redirectUri,
        code_verifier: authorization.verifier, resource: "https://chat.example.test/mcp"
      });
      expect(response.status).toBe(200);
      return { clientId: authorization.clientId, ...await response.json() as { access_token: string; refresh_token: string } };
    }
    async function tool(token: string, name: string, args: Record<string, unknown> = {}) {
      const response = await fixture.app.request("/mcp", {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, Accept: "application/json, text/event-stream", "Content-Type": "application/json", Host: "chat.example.test" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } })
      });
      expect(response.status).toBe(200);
      const text = await response.text();
      const messages = response.headers.get("content-type")?.includes("text/event-stream")
        ? text.split(/\r?\n/).filter((line) => line.startsWith("data:")).map((line) => JSON.parse(line.slice(5)))
        : [JSON.parse(text)];
      const message = messages.find((item) => item.id === 1);
      expect(message.error).toBeUndefined();
      return message.result;
    }
    const first = await login();
    const second = await login();
    expect(first.clientId).not.toBe(second.clientId);
    expect(first.access_token).not.toBe(second.access_token);
    expect(fixture.db.prepare(`select count(*) as count from users`).get()).toEqual({ count: 1 });
    const created = await tool(first.access_token, "channels_create", { name: "shared-budget" });
    const channelId = created.structuredContent.channel.id;
    const outcomes = await Promise.all(Array.from({ length: 70 }, (_, i) => tool(i % 2 ? first.access_token : second.access_token,
      "messages_post", { channelId, text: `shared-account message ${i}` })));
    expect(outcomes.filter((result) => !result.isError)).toHaveLength(60);
    const limited = outcomes.filter((result) => result.isError);
    expect(limited).toHaveLength(10);
    for (const result of limited) {
      expect(result.structuredContent).toMatchObject({ error: { code: "rate_limited", action: "messages_post", retryAfterMs: 1000 } });
      expect(JSON.parse(result.content[0].text)).toEqual(result.structuredContent);
    }
    expect(fixture.db.prepare(`select count(*) as count from messages`).get()).toEqual({ count: 60 });
    expect(fixture.db.prepare(`select count(*) as count from chat_events`).get()).toEqual({ count: 61 });
    expect((await tool(second.access_token, "channels_list")).isError).not.toBe(true);

    const refreshResponse = await tokenRequest(fixture, {
      grant_type: "refresh_token", refresh_token: first.refresh_token, client_id: first.clientId,
      resource: "https://chat.example.test/mcp"
    });
    expect(refreshResponse.status).toBe(200);
    const refreshed = await refreshResponse.json() as { access_token: string };
    expect((await tool(refreshed.access_token, "messages_post", { channelId, text: "refresh is not a bypass" })).isError).toBe(true);
    fixture.github.identify.mockResolvedValue({ id: 12345678, login: "octo-agent-renamed" });
    const renamed = await login();
    expect((await tool(renamed.access_token, "messages_post", { channelId, text: "rename is not a bypass" })).structuredContent.error.code).toBe("rate_limited");
    expect(fixture.db.prepare(`select count(*) as count from users`).get()).toEqual({ count: 1 });

    // A different numeric GitHub account ID gets its own budget, even when the
    // display login matches an earlier login of the first account.
    fixture.github.identify.mockResolvedValue({ id: 87654321, login: "octo-agent" });
    const other = await login();
    expect((await tool(other.access_token, "channels_join", { channelId })).isError).not.toBe(true);
    expect((await tool(other.access_token, "messages_post", { channelId, text: "independent human budget" })).isError).not.toBe(true);
    expect(fixture.db.prepare(`select count(*) as count from users`).get()).toEqual({ count: 2 });
  });

  it("publishes MCP OAuth discovery metadata", async () => {
    const fixture = setup();
    const resource = await fixture.app.request("/.well-known/oauth-protected-resource/mcp");
    expect(await resource.json()).toMatchObject({
      resource: "https://chat.example.test/mcp",
      authorization_servers: ["https://chat.example.test"]
    });
    const authorization = await fixture.app.request("/.well-known/oauth-authorization-server");
    expect(await authorization.json()).toMatchObject({
      issuer: "https://chat.example.test",
      authorization_endpoint: "https://chat.example.test/oauth/authorize",
      token_endpoint: "https://chat.example.test/oauth/token",
      registration_endpoint: "https://chat.example.test/oauth/register",
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none"]
    });
    const denied = await fixture.app.request("/mcp", {
      method: "POST",
      headers: { Host: "chat.example.test", "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "events/list", params: {} })
    });
    expect(denied.status).toBe(401);
    expect(denied.headers.get("www-authenticate")).toContain(
      'resource_metadata="https://chat.example.test/.well-known/oauth-protected-resource/mcp"'
    );
  });

  it("identifies with GitHub, requires consent and PKCE, and authorizes MCP", async () => {
    const fixture = setup();
    const authorization = await completeAuthorization(fixture);
    expect(fixture.github.identify).toHaveBeenCalledWith("github-code");
    const tokenResponse = await tokenRequest(fixture, {
      grant_type: "authorization_code",
      code: authorization.code,
      client_id: authorization.clientId,
      redirect_uri: authorization.redirectUri,
      code_verifier: authorization.verifier,
      resource: "https://chat.example.test/mcp"
    });
    expect(tokenResponse.status).toBe(200);
    expect(tokenResponse.headers.get("cache-control")).toBe("no-store");
    const tokens = await tokenResponse.json() as { access_token: string; refresh_token: string; expires_in: number };
    expect(tokens.access_token).toMatch(/^ac_/);
    expect(tokens.refresh_token).toMatch(/^rf_/);
    expect(tokens.expires_in).toBe(3600);

    const mcp = await fixture.app.request("/mcp", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${tokens.access_token}`,
        Accept: "application/json, text/event-stream",
        "Content-Type": "application/json",
        Host: "chat.example.test"
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "events/list", params: {} })
    });
    expect(mcp.status).toBe(200);
    expect(await mcp.text()).toContain("agents-chat.activity");
    const replay = await tokenRequest(fixture, {
      grant_type: "authorization_code",
      code: authorization.code,
      client_id: authorization.clientId,
      redirect_uri: authorization.redirectUri,
      code_verifier: authorization.verifier,
      resource: "https://chat.example.test/mcp"
    });
    expect(replay.status).toBe(400);
    expect(await replay.json()).toMatchObject({ error: "invalid_grant" });
    expect(fixture.db.prepare(`select provider, provider_subject, display_name from users`).get()).toEqual({
      provider: "github",
      provider_subject: "12345678",
      display_name: "octo-agent"
    });
  });

  it("rejects a wrong verifier, wrong audience, and unregistered redirects", async () => {
    const fixture = setup();
    const authorization = await completeAuthorization(fixture);
    const wrongVerifier = await tokenRequest(fixture, {
      grant_type: "authorization_code",
      code: authorization.code,
      client_id: authorization.clientId,
      redirect_uri: authorization.redirectUri,
      code_verifier: "wrong-verifier-that-is-still-long-enough-for-this-request",
      resource: "https://chat.example.test/mcp"
    });
    expect(wrongVerifier.status).toBe(400);
    expect(await wrongVerifier.json()).toMatchObject({ error: "invalid_grant" });

    const wrongAudience = await tokenRequest(fixture, {
      grant_type: "authorization_code",
      code: authorization.code,
      client_id: authorization.clientId,
      redirect_uri: authorization.redirectUri,
      code_verifier: authorization.verifier,
      resource: "https://other.example/mcp"
    });
    expect(wrongAudience.status).toBe(400);
    expect(await wrongAudience.json()).toMatchObject({ error: "invalid_grant" });

    const { clientId } = await registerClient(fixture);
    const badAuthorize = await fixture.app.request(
      `/oauth/authorize?response_type=code&client_id=${encodeURIComponent(clientId)}&redirect_uri=${encodeURIComponent("https://evil.example/callback")}&state=x`
    );
    expect(badAuthorize.status).toBe(400);
    expect(await badAuthorize.json()).toMatchObject({ error: "invalid_request" });
  });

  it("enforces granted scopes for MCP methods", async () => {
    const fixture = setup();
    const authorization = await completeAuthorization(fixture, "chat:read");
    const tokenResponse = await tokenRequest(fixture, {
      grant_type: "authorization_code",
      code: authorization.code,
      client_id: authorization.clientId,
      redirect_uri: authorization.redirectUri,
      code_verifier: authorization.verifier,
      resource: "https://chat.example.test/mcp"
    });
    const tokens = await tokenResponse.json() as { access_token: string; scope: string };
    expect(tokens.scope).toBe("chat:read");

    const allowed = await fixture.app.request("/mcp", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${tokens.access_token}`,
        Accept: "application/json, text/event-stream",
        "Content-Type": "application/json",
        Host: "chat.example.test"
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "channels_list", arguments: {} } })
    });
    expect(allowed.status).toBe(200);

    const denied = await fixture.app.request("/mcp", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${tokens.access_token}`,
        Accept: "application/json, text/event-stream",
        "Content-Type": "application/json",
        Host: "chat.example.test"
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "events/list", params: {} })
    });
    expect(denied.status).toBe(403);
    expect(denied.headers.get("www-authenticate")).toContain('error="insufficient_scope"');
    expect(await denied.json()).toEqual({ error: "insufficient_scope", required_scope: "events:read" });
  });

  it("rotates refresh tokens and revokes the family on replay", async () => {
    const fixture = setup();
    const authorization = await completeAuthorization(fixture);
    const initial = await tokenRequest(fixture, {
      grant_type: "authorization_code",
      code: authorization.code,
      client_id: authorization.clientId,
      redirect_uri: authorization.redirectUri,
      code_verifier: authorization.verifier,
      resource: "https://chat.example.test/mcp"
    });
    const first = await initial.json() as { refresh_token: string };
    const refreshed = await tokenRequest(fixture, {
      grant_type: "refresh_token",
      refresh_token: first.refresh_token,
      client_id: authorization.clientId,
      resource: "https://chat.example.test/mcp"
    });
    expect(refreshed.status).toBe(200);
    const second = await refreshed.json() as { refresh_token: string };
    expect(second.refresh_token).not.toBe(first.refresh_token);

    const replay = await tokenRequest(fixture, {
      grant_type: "refresh_token",
      refresh_token: first.refresh_token,
      client_id: authorization.clientId,
      resource: "https://chat.example.test/mcp"
    });
    expect(replay.status).toBe(400);
    expect(await replay.json()).toMatchObject({ error: "invalid_grant" });
    const familyRevoked = await tokenRequest(fixture, {
      grant_type: "refresh_token",
      refresh_token: second.refresh_token,
      client_id: authorization.clientId,
      resource: "https://chat.example.test/mcp"
    });
    expect(familyRevoked.status).toBe(400);
  });

  it("rejects unsafe dynamic client redirect URIs", async () => {
    const fixture = setup();
    for (const redirectUri of [
      "http://evil.example/callback", "https://good.example/callback#fragment", "not-a-url",
      "https://evil.example;script-src/callback", "https://*.example/callback"
    ]) {
      const response = await fixture.app.request("/oauth/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ redirect_uris: [redirectUri], token_endpoint_auth_method: "none" })
      });
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ error: "invalid_redirect_uri" });
    }
  });
});

function hiddenInput(html: string, name: string): string {
  const match = new RegExp(`name="${name}" value="([^"]+)"`).exec(html);
  if (!match) throw new Error(`Missing hidden input ${name}`);
  return match[1];
}
