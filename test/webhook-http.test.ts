import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ lookup: vi.fn(), request: vi.fn() }));
vi.mock("node:dns/promises", () => ({ lookup: mocks.lookup }));
vi.mock("node:https", () => ({ request: mocks.request }));
import { SafeWebhookHttpClient, UnsafeWebhookAddressError, classifyWebhookError, isGloballyRoutableIp } from "../src/webhook-http.js";

beforeEach(() => { vi.resetAllMocks(); });

describe("webhook HTTP security", () => {
  it.each([
    "127.0.0.1", "0.0.0.0", "10.5.6.7", "172.31.2.3", "192.168.1.1", "169.254.169.254",
    "100.64.0.1", "192.0.0.1", "192.0.2.1", "192.88.99.1", "198.18.0.1", "198.51.100.1",
    "203.0.113.1", "224.0.0.1", "255.255.255.255", "::", "::1", "0:0:0:0:0:0:0:1",
    "::ffff:127.0.0.1", "0:0:0:0:0:ffff:7f00:1", "fc00::1", "fd12::1", "fe80::1", "ff02::1",
    "64:ff9b::7f00:1", "2001:db8::1", "2001:0::1", "2002:7f00:1::", "3fff::1", "not-an-ip"
  ])("blocks non-public address %s", (address) => { expect(isGloballyRoutableIp(address)).toBe(false); });

  it.each(["1.1.1.1", "8.8.8.8", "172.32.0.1", "2606:4700:4700::1111", "2001:4860:4860::8888"])("allows public address %s", (address) => {
    expect(isGloballyRoutableIp(address)).toBe(true);
  });

  it("rejects mixed DNS answers before creating a socket", async () => {
    mocks.lookup.mockResolvedValue([{ address: "8.8.8.8", family: 4 }, { address: "127.0.0.1", family: 4 }]);
    await expect(new SafeWebhookHttpClient().post("https://receiver.example/hooks", "{}", {}, new AbortController().signal))
      .rejects.toBeInstanceOf(UnsafeWebhookAddressError);
    expect(mocks.request).not.toHaveBeenCalled();
  });

  it("pins validated DNS into each socket, retains SNI/Host, and never follows redirects", async () => {
    mocks.lookup.mockResolvedValueOnce([{ address: "8.8.8.8", family: 4 }])
      .mockResolvedValueOnce([{ address: "127.0.0.1", family: 4 }]);
    mocks.request.mockImplementation((options, callback) => {
      expect(options).toMatchObject({ hostname: "receiver.example", servername: "receiver.example", agent: false, path: "/hooks?q=1", method: "POST" });
      const single = vi.fn();
      options.lookup("receiver.example", {}, single);
      expect(single).toHaveBeenCalledWith(null, "8.8.8.8", 4);
      const all = vi.fn();
      options.lookup("receiver.example", { all: true }, all);
      expect(all).toHaveBeenCalledWith(null, [{ address: "8.8.8.8", family: 4 }]);
      const request = new EventEmitter() as any;
      request.end = () => {
        const response = new EventEmitter() as any;
        response.statusCode = 302;
        response.headers = { location: "http://169.254.169.254/latest/meta-data" };
        callback(response);
        response.emit("end");
      };
      return request;
    });
    const client = new SafeWebhookHttpClient();
    const response = await client.post("https://receiver.example/hooks?q=1", "{}", {}, new AbortController().signal);
    expect(response.status).toBe(302);
    expect(mocks.request).toHaveBeenCalledTimes(1);
    await expect(client.post("https://receiver.example/hooks?q=1", "{}", {}, new AbortController().signal)).rejects.toBeInstanceOf(UnsafeWebhookAddressError);
    expect(mocks.lookup).toHaveBeenCalledTimes(2);
    expect(mocks.request).toHaveBeenCalledTimes(1);
  });

  it("rejects private IP literals and alternate numeric URL encodings without DNS", async () => {
    const client = new SafeWebhookHttpClient();
    for (const host of ["127.0.0.1", "2130706433", "0x7f000001", "[::1]", "[::ffff:127.0.0.1]"]) {
      await expect(client.post(`https://${host}/hooks`, "{}", {}, new AbortController().signal)).rejects.toBeInstanceOf(UnsafeWebhookAddressError);
    }
    expect(mocks.lookup).not.toHaveBeenCalled();
    expect(mocks.request).not.toHaveBeenCalled();
  });

  it("bounds DNS resolution with the whole-request deadline", async () => {
    vi.useFakeTimers();
    try {
      mocks.lookup.mockReturnValue(new Promise(() => {}));
      const pending = new SafeWebhookHttpClient().post("https://receiver.example/hooks", "{}", {}, new AbortController().signal);
      const result = expect(pending).rejects.toMatchObject({ name: "TimeoutError" });
      await vi.advanceTimersByTimeAsync(5000);
      await result;
      expect(mocks.request).not.toHaveBeenCalled();
    } finally { vi.useRealTimers(); }
  });

  it("cancels before delivery and sanitizes TLS/timeout errors", async () => {
    const abort = new AbortController();
    abort.abort();
    await expect(new SafeWebhookHttpClient().post("https://receiver.example/hooks", "{}", {}, abort.signal)).rejects.toMatchObject({ name: "AbortError" });
    expect(mocks.lookup).not.toHaveBeenCalled();
    expect(classifyWebhookError({ code: "ERR_TLS_CERT_ALTNAME_INVALID", message: "sensitive endpoint error" })).toBe("tls_error");
    expect(classifyWebhookError({ code: "ETIMEDOUT" })).toBe("timeout");
    expect(classifyWebhookError({ code: "ECONNREFUSED" })).toBe("connection_refused");
  });
});
