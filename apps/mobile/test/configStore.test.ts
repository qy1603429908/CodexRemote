import { describe, expect, it } from "vitest";
import { DEFAULT_SERVER_URL, normalizeServerUrl, toWebSocketUrl } from "../src/lib/configStore";

describe("server URL normalization", () => {
  it("does not ship a maintainer-specific first-run endpoint", () => {
    expect(DEFAULT_SERVER_URL).toBe("");
  });

  it("adds http and strips trailing slashes", () => {
    expect(normalizeServerUrl(" 100.64.0.10:8787/// ")).toBe("http://100.64.0.10:8787");
  });

  it("maps http and https to the websocket endpoint", () => {
    expect(toWebSocketUrl("http://100.64.0.10:8787")).toBe("ws://100.64.0.10:8787/ws");
    expect(toWebSocketUrl("https://remote.example/base?q=1#x")).toBe("wss://remote.example/ws");
  });

  it("rejects unsupported protocols", () => {
    expect(() => toWebSocketUrl("ftp://example.com")).toThrow(/必须使用/);
  });
  it("allows cleartext RFC1918 LAN and Tailscale addresses", () => {
    expect(toWebSocketUrl("http://192.168.1.5:8787")).toBe("ws://192.168.1.5:8787/ws");
    expect(toWebSocketUrl("ws://10.1.2.3:8787")).toBe("ws://10.1.2.3:8787/ws");
    expect(toWebSocketUrl("http://172.16.0.8:8787")).toBe("ws://172.16.0.8:8787/ws");
    expect(toWebSocketUrl("http://172.31.255.254:8787")).toBe("ws://172.31.255.254:8787/ws");
    expect(toWebSocketUrl("http://100.64.0.10:8787")).toBe("ws://100.64.0.10:8787/ws");
  });

  it("rejects cleartext public and non-private addresses", () => {
    expect(() => toWebSocketUrl("http://172.32.0.1:8787")).toThrow(/私有局域网/);
    expect(() => toWebSocketUrl("ws://8.8.8.8:8787")).toThrow(/私有局域网/);
    expect(() => toWebSocketUrl("http://remote.example:8787")).toThrow(/https\/wss/);
  });

});
