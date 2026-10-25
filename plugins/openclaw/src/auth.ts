import { createServer } from "node:http";
import { once } from "node:events";
import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { join } from "node:path";
import { auth, extractWWWAuthenticateParams, type AuthProvider, type OAuthClientProvider, type StoredOAuthTokens, type StoredOAuthClientInformation, type OAuthDiscoveryState } from "@modelcontextprotocol/client";
import { privateDir, readJson, writeJson, withFileLock } from "./files.js";

type Credentials = { serverUrl: string; epoch: string; generation: string; redirect: string; client?: StoredOAuthClientInformation; tokens?: StoredOAuthTokens; discovery?: OAuthDiscoveryState; resource?: string };
const scope = "chat:read chat:write events:read offline_access";

/** The SDK performs discovery, DCR, PKCE and issuer checks. Tokens never enter tool results. */
export class CredentialsProvider implements OAuthClientProvider {
  private verifier?: string;
  private current?: Credentials;
  private generation?: string;
  private readonly stateValue = randomBytes(32).toString("base64url");
  constructor(readonly directory: string, readonly serverUrl: string, private interactive?: { redirect: string; show: (url: string) => void }) {}
  get path() { return join(this.directory, "oauth.json"); }
  get redirectUrl() { return this.interactive?.redirect ?? this.current?.redirect; }
  get clientMetadata() { return { client_name: "Agents Chat for OpenClaw", redirect_uris: this.redirectUrl ? [this.redirectUrl] : [], grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], token_endpoint_auth_method: "none", scope }; }
  state() { return this.stateValue; }
  async load() {
    const value = this.interactive ? this.current : await readJson<Credentials>(this.path);
    if (value && value.serverUrl !== this.serverUrl) throw new Error("Stored authorization belongs to a different MCP resource");
    this.current = value; return value;
  }
  async clientInformation() { return (await this.load())?.client; }
  async saveClientInformation(client: StoredOAuthClientInformation) { await this.update({ client }); }
  async tokens() { const value = await this.load(); this.generation = value?.generation; return value?.tokens; }
  async saveTokens(tokens: StoredOAuthTokens) { await this.update({ tokens, generation: randomUUID() }); }
  async discoveryState() { return (await this.load())?.discovery; }
  async saveDiscoveryState(discovery: OAuthDiscoveryState) { await this.update({ discovery }); }
  async resourceUrl() { return (await this.load())?.resource; }
  async saveResourceUrl(resource: string) {
    if (resource !== this.serverUrl) throw new Error("OAuth discovery returned an unexpected protected resource");
    await this.update({ resource });
  }
  async saveCodeVerifier(value: string) { this.verifier = value; }
  async codeVerifier() { if (!this.verifier) throw new Error("No pending login"); return this.verifier; }
  redirectToAuthorization(url: URL) {
    if (!this.interactive) throw new Error("Login required: run openclaw agents-chat login");
    this.interactive.show(url.toString());
  }
  async invalidateCredentials(kind: string) {
    const value = await this.load(); if (!value) return;
    if (kind === "all" || kind === "tokens") value.tokens = undefined;
    if (kind === "all" || kind === "client") value.client = undefined;
    if (kind === "all" || kind === "discovery") value.discovery = undefined;
    if (kind === "all" || kind === "verifier") this.verifier = undefined;
    await this.update(value);
  }
  async onOAuthUnauthorized(_context: unknown, continueDefault: () => Promise<void>) {
    if (this.interactive) { await continueDefault(); return; }
    await privateDir(this.directory);
    const used = this.generation;
    await withFileLock(join(this.directory, "oauth.lock"), async () => {
      const fresh = await this.load();
      // A sibling connection may already have rotated the refresh token.
      if (fresh?.tokens && fresh.generation !== used) return;
      if (!fresh?.tokens?.refresh_token) throw new Error("Login required: run openclaw agents-chat login");
      await continueDefault();
    });
  }
  transportAuth(): AuthProvider {
    // SDK 2.4's automatic OAuth adapter does not expose a refresh lock. Use its
    // supported minimal auth seam, while retaining the official OAuth flow.
    return {
      token: async () => (await this.tokens())?.access_token,
      onUnauthorized: (context) => this.onOAuthUnauthorized(context, async () => {
        const { resourceMetadataUrl, scope: requestedScope } = extractWWWAuthenticateParams(context.response);
        const result = await auth(this, { serverUrl: context.serverUrl, resourceMetadataUrl, scope: requestedScope, fetchFn: context.fetchFn });
        if (result !== "AUTHORIZED") throw new Error("Run openclaw agents-chat login");
      })
    };
  }
  private async update(patch: Partial<Credentials>) {
    const value = { serverUrl: this.serverUrl, epoch: randomUUID(), generation: randomUUID(), redirect: this.interactive?.redirect ?? "", ...this.current, ...patch };
    this.current = value;
    if (!this.interactive) await writeJson(this.path, value);
  }
  async commitLogin() {
    if (!this.interactive || !this.current?.tokens) throw new Error("Login did not produce credentials");
    await privateDir(this.directory);
    await withFileLock(join(this.directory, "oauth.lock"), () => writeJson(this.path, this.current));
  }
}

/** Explicit operator action only. Listen exclusively on loopback and verify OAuth state. */
export async function login(directory: string, serverUrl: string, show: (url: string) => void) {
  let accept!: (params: URLSearchParams) => void;
  const callback = new Promise<URLSearchParams>((resolve) => { accept = resolve; });
  let expectedState = "", consumed = false;
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const actual = Buffer.from(url.searchParams.get("state") ?? ""), expected = Buffer.from(expectedState);
    if (req.method !== "GET" || url.pathname !== "/callback" || consumed || !expected.length || actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
      res.writeHead(400).end("Invalid OAuth callback"); return;
    }
    consumed = true; res.writeHead(200, { "Content-Type": "text/plain", "Cache-Control": "no-store" }).end("Authorization received. Return to your terminal.");
    accept(url.searchParams);
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const port = (server.address() as { port: number }).port;
  const provider = new CredentialsProvider(directory, serverUrl, { redirect: `http://127.0.0.1:${port}/callback`, show });
  expectedState = provider.state();
  const timeout = AbortSignal.timeout(5 * 60_000);
  let rejectTimeout!: () => void;
  const expired = new Promise<never>((_, reject) => { rejectTimeout = () => reject(new Error("Login timed out; previous credentials were not changed")); timeout.addEventListener("abort", rejectTimeout, { once: true }); });
  try {
    const result = await auth(provider, { serverUrl, scope });
    if (result !== "AUTHORIZED") {
      const params = await Promise.race([callback, expired]);
      if (params.has("error") || !params.get("code")) throw new Error("OAuth authorization was declined or failed");
      await auth(provider, { serverUrl, authorizationCode: params.get("code")!, iss: params.get("iss") ?? undefined, scope });
    }
    await provider.commitLogin();
  } finally { timeout.removeEventListener("abort", rejectTimeout); server.closeAllConnections(); server.close(); }
}

export async function logout(directory: string) {
  await privateDir(directory);
  // Keep registrations/inbox for explicit recovery, but erase OAuth access locally.
  await withFileLock(join(directory, "oauth.lock"), () => writeJson(join(directory, "oauth.json"), null));
}
