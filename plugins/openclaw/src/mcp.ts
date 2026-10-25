import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import type { CredentialsProvider } from "./auth.js";
import { z } from "zod/v4";
export const object = z.record(z.string(), z.unknown());
export class RemoteToolError extends Error { constructor(readonly code: string) { super(`Agents Chat rejected the operation (${code})`); } }
export class ChatClient {
  readonly sdk = new Client({ name: "agents-chat-openclaw", version: "0.1.0" }, { capabilities: {}, versionNegotiation: { mode: "auto" } });
  constructor(private url: string, private provider: CredentialsProvider) {}
  async connect() { await this.sdk.connect(new StreamableHTTPClientTransport(new URL(this.url), { authProvider: this.provider.transportAuth() })); }
  async close() { await this.sdk.close(); }
  async tool<T = Record<string, unknown>>(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<T> {
    const result = await this.sdk.callTool({ name, arguments: args }, { signal, timeout: 30_000 });
    if (result.isError) throw new RemoteToolError(String(((result.structuredContent as Record<string, unknown> | undefined)?.error as { code?: string } | undefined)?.code ?? "tool_error"));
    return result.structuredContent as T;
  }
  request(method: string, params: Record<string, unknown>, signal?: AbortSignal, timeout = 30_000) { return this.sdk.request({ method, params }, object, { signal, timeout }); }
}
