import { createHash, randomBytes } from "node:crypto";
import { once } from "node:events";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { serve } from "@hono/node-server";
import { test, expect } from "@playwright/test";
import { createApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";

// Exercise the real consent HTML, CSP, redirects, token endpoint and MCP server.
// Only GitHub's identity lookup is stubbed; tests never use production credentials.
for (const decision of ["allow", "deny", "tampered"] as const) {
  test(decision === "tampered" ? "consent cannot submit to an unregistered origin" : `a single ${decision} click reaches the client callback on another origin`, async ({ page }, testInfo) => {
    let fixture: ReturnType<typeof createApp> | undefined;
    let callbackUrl: URL | undefined;
    let callbackMethod: string | undefined;
    const callbackServer = createServer((req, res) => {
      if (new URL(req.url!, "http://127.0.0.1").pathname !== "/callback") {
        res.writeHead(404).end();
        return;
      }
      callbackUrl = new URL(req.url!, "http://127.0.0.1");
      callbackMethod = req.method;
      res.setHeader("Content-Type", "text/html");
      res.end("<!doctype html><h1>Authorization received</h1>");
    });
    callbackServer.listen(0, "127.0.0.1");
    await once(callbackServer, "listening");
    const redirectUri = `http://127.0.0.1:${(callbackServer.address() as AddressInfo).port}/callback`;
    const appServer = serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: (request) => fixture!.app.fetch(request)
    });
    await once(appServer, "listening");
    const baseUrl = `http://127.0.0.1:${(appServer.address() as AddressInfo).port}`;
    fixture = createApp(loadConfig({
      PUBLIC_BASE_URL: baseUrl,
      DATABASE_URL: ":memory:",
      GITHUB_CLIENT_ID: "browser-test-client",
      GITHUB_CLIENT_SECRET: "browser-test-secret"
    }), { github: { identify: async () => ({ id: 1234, login: "browser-test-user" }) } });
    const browserErrors: string[] = [];
    page.on("console", (message) => {
      if (message.type() === "error") browserErrors.push(message.text());
    });

    try {
      const registration = await fetch(`${baseUrl}/oauth/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          client_name: "Browser regression client",
          redirect_uris: [redirectUri],
          token_endpoint_auth_method: "none"
        })
      });
      expect(registration.status).toBe(201);
      const { client_id: clientId } = await registration.json() as { client_id: string };
      const verifier = randomBytes(32).toString("base64url");
      const challenge = createHash("sha256").update(verifier).digest("base64url");
      const state = randomBytes(32).toString("hex");
      const authorize = new URL(`${baseUrl}/oauth/authorize`);
      authorize.search = new URLSearchParams({
        response_type: "code", client_id: clientId, redirect_uri: redirectUri,
        code_challenge: challenge, code_challenge_method: "S256", state,
        resource: `${baseUrl}/mcp`
      }).toString();
      const authorizationResponse = await fetch(authorize, { redirect: "manual" });
      expect(authorizationResponse.status).toBe(302);
      const githubState = new URL(authorizationResponse.headers.get("location")!).searchParams.get("state")!;
      await page.goto(`${baseUrl}/oauth/github/callback?state=${encodeURIComponent(githubState)}&code=test-code`);
      await expect(page.getByRole("heading", { name: "Authorize Browser regression client" })).toBeVisible();
      if (decision === "tampered") {
        const unregisteredUri = redirectUri.replace("127.0.0.1", "localhost");
        await page.locator("form").evaluate((form: HTMLFormElement, uri) => { form.action = uri; }, unregisteredUri);
        await page.getByRole("button", { name: "Authorize", exact: true }).click({ noWaitAfter: true });
        await expect.poll(() => browserErrors.some((error) => error.includes("form-action"))).toBe(true);
        expect(callbackUrl).toBeUndefined();
        expect(fixture.db.prepare("select count(*) as total from oauth_transactions").get()).toEqual({ total: 1 });
        return;
      }
      await page.getByRole("button", { name: decision === "allow" ? "Authorize" : "Cancel", exact: true }).click();
      await expect(page.getByRole("heading", { name: "Authorization received" })).toBeVisible({ timeout: 5000 });
      expect(callbackMethod).toBe("GET");
      expect(callbackUrl!.searchParams.get("state")).toBe(state);
      expect(callbackUrl!.searchParams.get("iss")).toBe(baseUrl);

      if (decision === "deny") {
        expect(callbackUrl!.searchParams.get("error")).toBe("access_denied");
        expect(callbackUrl!.searchParams.has("code")).toBe(false);
        expect(fixture.db.prepare("select count(*) as total from oauth_codes").get()).toEqual({ total: 0 });
        return;
      }
      const tokenResponse = await fetch(`${baseUrl}/oauth/token`, {
        method: "POST",
        body: new URLSearchParams({
          grant_type: "authorization_code", code: callbackUrl!.searchParams.get("code")!,
          client_id: clientId, redirect_uri: redirectUri, code_verifier: verifier,
          resource: `${baseUrl}/mcp`
        })
      });
      expect(tokenResponse.status).toBe(200);
      const tokens = await tokenResponse.json() as { access_token: string };
      const events = await fetch(`${baseUrl}/mcp`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${tokens.access_token}`,
          Accept: "application/json, text/event-stream", "Content-Type": "application/json"
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "events/list", params: {} })
      });
      expect(events.status).toBe(200);
      expect(await events.text()).toContain("agents-chat.activity");
    } finally {
      await testInfo.attach("browser-errors", { body: browserErrors.join("\n"), contentType: "text/plain" });
      await Promise.all([stopServer(appServer as Server), stopServer(callbackServer)]);
      await fixture?.close();
    }
  });
}

async function stopServer(server: Server) {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}
