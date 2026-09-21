import { once } from "node:events";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { serve } from "@hono/node-server";
import { test, expect } from "@playwright/test";
import { createApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";

const testToken = "browser-debug-test-token-not-a-real-credential";
for (const administrator of [true, false]) {
  test(administrator ? "debug sign-in, live activity, filters, pause and logout" : "a non-administrator cannot view debug activity", async ({ page, context }, testInfo) => {
    let fixture: ReturnType<typeof createApp>;
    const server = serve({ hostname: "127.0.0.1", port: 0, fetch: (request) => fixture.app.fetch(request) });
    await once(server, "listening");
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    fixture = createApp(loadConfig({ PUBLIC_BASE_URL: base, DATABASE_URL: ":memory:",
      GITHUB_CLIENT_ID: "test-client", GITHUB_CLIENT_SECRET: "test-secret", AGENTS_CHAT_DEBUG_GITHUB_IDS: "1234",
      AGENTS_CHAT_TOKENS_JSON: JSON.stringify({ [testToken]: "Scout" })
    }), { github: { identify: async () => ({ id: administrator ? 1234 : 5678, login: "browser-owner" }) },
      webhookClient: { post: async (_url, raw) => ({ status: 200, body: JSON.stringify({ challenge: JSON.parse(raw).challenge }) }) } });
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    // Only the GitHub identity exchange is stubbed. Consent, PKCE, cookies,
    // redirects, CSP, activity endpoints and MCP calls are the real app.
    await page.route(`${base}/debug/login`, async (route) => {
      const login = await route.fetch({ maxRedirects: 0 });
      const authorization = await context.request.get(login.headers().location, { maxRedirects: 0 });
      const github = new URL(authorization.headers().location);
      expect(github.origin).toBe("https://github.com");
      const state = github.searchParams.get("state");
      return route.fulfill({ response: login, headers: { ...login.headers(), location: `${base}/oauth/github/callback?state=${state}&code=test-code` } });
    });
    async function rpc(method: string, params: unknown) {
      const response = await fetch(`${base}/mcp`, { method: "POST", headers: { Authorization: `Bearer ${testToken}`,
        "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
      expect(response.status).toBe(200);
      const raw = await response.text();
      const messages = response.headers.get("content-type")?.includes("text/event-stream")
        ? raw.split(/\r?\n/).filter((line) => line.startsWith("data:")).map((line) => JSON.parse(line.slice(5))) : [JSON.parse(raw)];
      const result = messages.find((message) => message.id === 1);
      expect(result.error).toBeUndefined();
      return result.result;
    }
    try {
      await page.goto(`${base}/debug`);
      await expect(page.getByRole("heading", { name: "Administrator access" })).toBeVisible();
      await page.getByRole("link", { name: "Sign in with GitHub" }).click();
      await expect(page.getByRole("button", { name: "Authorize", exact: true })).toBeVisible();
      await page.getByRole("button", { name: "Authorize", exact: true }).click();
      if (!administrator) {
        await expect(page.getByText("This debug view is restricted to the server administrator.")).toBeVisible();
        expect((await context.request.get(`${base}/debug/api/events`)).status()).toBe(401);
        return;
      }
      await expect(page).toHaveURL(`${base}/debug`);
      await expect(page.locator("#connection")).toContainText("Live · browser-owner");
      const session = (await context.cookies()).find((cookie) => cookie.name === "agents_chat_debug")!;
      expect(session.httpOnly).toBe(true);
      expect(session.sameSite).toBe("Lax");
      expect(await page.evaluate(() => document.cookie)).not.toContain(session.value);
      expect(await page.evaluate(() => localStorage.length + sessionStorage.length)).toBe(0);
      const created = await rpc("tools/call", { name: "channels_create", arguments: { name: "welcome" } });
      const channelId = created.structuredContent.channel.id;
      await rpc("events/subscribe", { name: "agents-chat.activity", ttlMs: 60000,
        delivery: { mode: "webhook", url: "https://receiver.example/private-path", secret: `whsec_${Buffer.alloc(32, 1).toString("base64")}` } });
      const message = '<img src=x onerror="window.injected=true"> Hello from orbit!';
      await rpc("tools/call", { name: "messages_post", arguments: { channelId, text: message } });
      await expect(page.locator(".message", { hasText: message })).toBeVisible();
      await expect(page.locator(".tag", { hasText: "delivery.sent" })).toBeVisible();
      expect(await page.evaluate(() => (window as any).injected)).toBeUndefined();
      expect(await page.locator("#feed img").count()).toBe(0);
      expect(await page.locator("#feed").textContent()).not.toContain("private-path");
      const messageRow = page.locator("details.event").filter({ has: page.locator(".message", { hasText: message }) });
      await messageRow.locator("summary").click();
      await expect(messageRow).toHaveAttribute("open", "");
      await page.getByRole("button", { name: "Pause", exact: true }).click();
      await rpc("tools/call", { name: "messages_post", arguments: { channelId, text: "A visitor arrived while paused" } });
      await page.waitForTimeout(2200);
      await expect(page.locator(".message", { hasText: "A visitor arrived while paused" })).toHaveCount(0);
      await page.getByRole("button", { name: "Resume", exact: true }).click();
      await expect(page.locator(".message", { hasText: "A visitor arrived while paused" })).toBeVisible();
      await expect(messageRow).toHaveAttribute("open", "");
      await page.getByRole("searchbox", { name: "Search activity" }).fill("visitor arrived");
      await expect(page.locator("details.event")).toHaveCount(1);
      await page.getByRole("searchbox", { name: "Search activity" }).fill("");
      await page.getByLabel("Delivery mode", { exact: true }).selectOption("webhook");
      await expect(page.locator(".message")).toHaveCount(0);
      await expect(page.locator(".mode").first()).toHaveText("webhook");
      await page.getByLabel("Delivery mode", { exact: true }).selectOption("all");
      await page.getByLabel("Event category", { exact: true }).selectOption("chat");
      await expect(page.locator('details.event:not([data-category="chat"])')).toHaveCount(0);
      await page.getByLabel("Event category", { exact: true }).selectOption("all");
      await page.setViewportSize({ width: 1440, height: 1050 });
      await page.screenshot({ path: testInfo.outputPath("debug-desktop.png"), fullPage: true });
      await page.setViewportSize({ width: 390, height: 844 });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      await page.screenshot({ path: testInfo.outputPath("debug-mobile.png"), fullPage: true });
      await page.getByRole("button", { name: "Sign out", exact: true }).click();
      await expect(page.getByRole("heading", { name: "Administrator access" })).toBeVisible();
      expect((await context.request.get(`${base}/debug/api/events`)).status()).toBe(401);
      expect(errors).toEqual([]);
    } finally {
      await fixture.close();
      (server as Server).closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
}
