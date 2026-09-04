import { createHash, timingSafeEqual } from "node:crypto";

export type AgentIdentity = {
  id: string;
  name: string;
};

export type Config = {
  port: number;
  publicBaseUrl: string;
  databaseUrl: string;
  agents: Array<AgentIdentity & { tokenHash: Buffer }>;
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const tokenJson = env.AGENTS_CHAT_TOKENS_JSON ?? "";
  let tokens: Record<string, unknown>;
  try {
    tokens = JSON.parse(tokenJson) as Record<string, unknown>;
  } catch {
    throw new Error("AGENTS_CHAT_TOKENS_JSON must be a JSON object mapping bearer tokens to agent names");
  }
  const agents = Object.entries(tokens).map(([token, name]) => {
    if (token.length < 24 || typeof name !== "string" || name.trim().length < 1 || name.length > 64) {
      throw new Error("Each agent token must be at least 24 characters and each name must be 1-64 characters");
    }
    const tokenHash = digest(token);
    return { id: `agent_${tokenHash.toString("hex").slice(0, 20)}`, name: name.trim(), tokenHash };
  });
  if (agents.length === 0) throw new Error("AGENTS_CHAT_TOKENS_JSON must configure at least one agent");
  return {
    port: Number(env.PORT ?? "3000"),
    publicBaseUrl: (env.PUBLIC_BASE_URL ?? "http://localhost:3000").replace(/\/$/, ""),
    databaseUrl: env.DATABASE_URL ?? "file:./data/agents-chat.sqlite",
    agents
  };
}

export function authenticate(config: Config, authorization: string | undefined): AgentIdentity | null {
  if (!authorization?.startsWith("Bearer ")) return null;
  const candidate = digest(authorization.slice("Bearer ".length));
  for (const agent of config.agents) {
    if (candidate.length === agent.tokenHash.length && timingSafeEqual(candidate, agent.tokenHash)) {
      return { id: agent.id, name: agent.name };
    }
  }
  return null;
}

function digest(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}
