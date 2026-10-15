// Small protocol-level test client. It deliberately has no model dependency.
export class McpTestClient {
  #id = 0;
  constructor(baseUrl, token) { this.baseUrl = baseUrl.replace(/\/$/, ""); this.token = token; }
  headers() { return { Authorization: `Bearer ${this.token}`, Accept: "application/json, text/event-stream", "Content-Type": "application/json" }; }
  async rpc(method, params = {}, { allowError = false } = {}) {
    const id = ++this.#id;
    const response = await fetch(`${this.baseUrl}/mcp`, { method: "POST", headers: this.headers(), signal: AbortSignal.timeout(10_000), body: JSON.stringify({ jsonrpc: "2.0", id, method, params }) });
    if (!response.ok) throw new Error(`${method}: HTTP ${response.status}`);
    const text = await response.text();
    const messages = response.headers.get("content-type")?.includes("text/event-stream") ? parseFrames(text) : [JSON.parse(text)];
    const message = messages.find((v) => v.id === id);
    if (!message) throw new Error(`${method}: missing response`);
    if (message.error && !allowError) throw new Error(`${method}: JSON-RPC ${message.error.code}`);
    return message.error ? { error: message.error } : message.result;
  }
  async tool(name, args = {}, options) {
    const result = await this.rpc("tools/call", { name, arguments: args });
    if (result.isError) {
      if (options?.allowError) return result;
      throw new Error(`${name}: ${result.structuredContent?.error?.code ?? "tool error"}`);
    }
    return result.structuredContent;
  }
  async initialize() { return this.rpc("initialize", { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "private-network-e2e", version: "1.0.0" } }); }
  async stream(params) {
    const abort = new AbortController(), id = `stream-${++this.#id}`;
    const response = await fetch(`${this.baseUrl}/mcp`, { method: "POST", headers: this.headers(), signal: abort.signal, body: JSON.stringify({ jsonrpc: "2.0", id, method: "events/stream", params }) });
    if (!response.ok) { abort.abort(); throw new Error(`events/stream: HTTP ${response.status}`); }
    const reader = response.body.getReader(), decoder = new TextDecoder(), messages = [];
    let pending = "", error, wake = () => {};
    const pump = (async () => {
      try {
        for (;;) {
          const chunk = await reader.read();
          if (chunk.done) break;
          pending += decoder.decode(chunk.value, { stream: true });
          const frames = pending.split(/\r?\n\r?\n/); pending = frames.pop() ?? "";
          for (const frame of frames) messages.push(...parseFrames(frame));
          wake();
        }
      } catch (caught) { if (!abort.signal.aborted) error = caught; }
      finally { wake(); }
    })();
    return {
      messages,
      async next(method, timeoutMs = 5000) {
        const deadline = Date.now() + timeoutMs;
        for (;;) {
          const index = messages.findIndex((m) => m.method === method);
          if (index >= 0) return messages.splice(index, 1)[0].params;
          if (error) throw error;
          if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${method}`);
          await new Promise((resolve) => { const timer = setTimeout(resolve, Math.min(50, deadline - Date.now())); wake = () => { clearTimeout(timer); resolve(); }; });
        }
      },
      async close() { abort.abort(); await reader.cancel().catch(() => {}); await pump; }
    };
  }
}
function parseFrames(text) { return text.split(/\r?\n/).filter((v) => v.startsWith("data:")).map((v) => JSON.parse(v.slice(5))); }
