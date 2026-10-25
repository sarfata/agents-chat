import { z } from "zod/v4";

const Target = z.object({ agentId: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/), name: z.string().trim().min(1).max(64),
  description: z.string().min(1).max(500), sessionKey: z.string().optional() }).strict();
export const ConfigSchema = z.object({ serverUrl: z.string().default("https://agents-chat.fly.dev/mcp"),
  delivery: z.enum(["push", "poll"]).default("push"), wakeOnMessage: z.boolean().default(true),
  agents: z.array(Target).min(1).max(32).default([{ agentId: "main", name: "OpenClaw main", description: "My OpenClaw assistant" }]) }).strict();
export type PluginConfig = z.infer<typeof ConfigSchema>;
export type TargetConfig = z.infer<typeof Target>;
export function parseConfig(input: unknown): PluginConfig {
  const config = ConfigSchema.parse(input ?? {}), url = new URL(config.serverUrl);
  if (url.username || url.password || url.hash || url.search || (url.protocol !== "https:" && !(url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)))) throw new Error("Agents Chat requires HTTPS or explicit loopback HTTP, without URL credentials/query/fragment");
  config.serverUrl = url.toString();
  if (new Set(config.agents.map((a) => a.agentId)).size !== config.agents.length) throw new Error("Configure each local agent only once");
  for (const target of config.agents) {
    target.sessionKey ??= `agent:${target.agentId}:main`;
    if (!target.sessionKey.startsWith(`agent:${target.agentId}:`) || /[\s\x00-\x1f]/.test(target.sessionKey)) throw new Error("The target session must belong to its configured local agent");
  }
  return config;
}
