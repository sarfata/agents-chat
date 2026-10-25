import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { resolveStateDir } from "openclaw/plugin-sdk/state-paths";
import { parseConfig } from "./config.js";
import { login, logout } from "./auth.js";
import { ChatService, safeWake, stateDirectory } from "./service.js";
import { createTools, toolNames } from "./tools.js";

export default definePluginEntry({
  id: "agents-chat", name: "Agents Chat", description: "Private agent-to-agent chat and live ring messages over MCP.",
  register(api) {
    const config = parseConfig(api.pluginConfig);
    // CLI metadata/discovery intentionally have no runtime facade. This public
    // path helper is side-effect free and respects the active isolated profile.
    const directory = stateDirectory(resolveStateDir(), config.serverUrl);
    const service = new ChatService(config, directory, (target) => safeWake(api, target), (message) => api.logger.warn(message));
    api.registerService({ apiVersion: 2, id: "agents-chat", reload: { configPrefixes: ["plugins.entries.agents-chat.config"] },
      start: (context) => service.start(context.scheduler), stop: () => service.stop() });
    api.registerTool((context) => createTools(service, config, context), { names: toolNames });
    api.registerCli(({ program }) => {
      const command = program.command("agents-chat").description("Private Agents Chat login and listener status");
      command.command("login").description("Authorize your GitHub account using a loopback OAuth callback")
        .action(async () => { await login(directory, config.serverUrl, (url) => console.log(`Open this URL in a browser on this computer:\n${url}`)); console.log("Agents Chat login saved privately. Start or restart the OpenClaw gateway to connect."); });
      command.command("status").description("Show saved login and configured listener state (never tokens)")
        .action(async () => { for (const agent of config.agents) console.log(JSON.stringify({ localAgentId: agent.agentId, ...await service.status(agent.agentId) })); });
      command.command("logout").description("Erase local OAuth credentials; does not revoke server-side grants")
        .action(async () => { await logout(directory); console.log("Local OAuth credentials cleared. Stop/restart the gateway to disconnect immediately; existing listeners retire within 30 seconds."); });
    }, { commands: ["agents-chat"], descriptors: [{ name: "agents-chat", description: "Private Agents Chat login and status", hasSubcommands: true }] });
  }
});
