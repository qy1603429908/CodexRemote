import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { authenticateUpgrade } from "../src/auth.js";
import type { ServerConfig } from "../src/config.js";

const token = "correct-token-which-is-at-least-32-chars";
const config: ServerConfig = {
  host: "127.0.0.1",
  port: 8787,
  token,
  tokenDigest: createHash("sha256").update(token).digest(),
  allowedOrigins: new Set(["capacitor://localhost"]),
  codexBin: "codex",
  serverId: "test",
};

function request(protocols: string, origin = "capacitor://localhost") {
  return { headers: { "sec-websocket-protocol": protocols, origin } } as never;
}

describe("authenticateUpgrade", () => {
  it("accepts the wire protocol and encoded token", () => {
    const encoded = Buffer.from(token).toString("base64url");
    expect(authenticateUpgrade(request(`codex-mobile-v1, token.${encoded}`), config)).toEqual({ ok: true });
  });

  it("rejects an invalid token", () => {
    const encoded = Buffer.from("wrong-token").toString("base64url");
    expect(authenticateUpgrade(request(`codex-mobile-v1, token.${encoded}`), config)).toEqual({ ok: false, reason: "invalid_token" });
  });

  it("rejects an unapproved origin", () => {
    const encoded = Buffer.from(token).toString("base64url");
    expect(authenticateUpgrade(request(`codex-mobile-v1, token.${encoded}`, "https://evil.invalid"), config)).toEqual({ ok: false, reason: "origin_not_allowed" });
  });
});
