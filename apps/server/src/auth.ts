import { createHash, timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { WIRE_PROTOCOL } from "@codex-mobile/protocol";
import type { ServerConfig } from "./config.js";

const TOKEN_PREFIX = "token.";

function decodeBase64Url(value: string): string | null {
  try {
    return Buffer.from(value, "base64url").toString("utf8");
  } catch {
    return null;
  }
}

export function requestedProtocols(request: IncomingMessage): string[] {
  const raw = request.headers["sec-websocket-protocol"];
  if (typeof raw !== "string") return [];
  return raw.split(",").map((value) => value.trim()).filter(Boolean);
}

export function authenticateUpgrade(request: IncomingMessage, config: ServerConfig): { ok: true } | { ok: false; reason: string } {
  const origin = request.headers.origin;
  if (origin && !config.allowedOrigins.has(origin)) {
    return { ok: false, reason: "origin_not_allowed" };
  }

  const protocols = requestedProtocols(request);
  if (!protocols.includes(WIRE_PROTOCOL)) {
    return { ok: false, reason: "protocol_not_supported" };
  }

  const encodedToken = protocols.find((value) => value.startsWith(TOKEN_PREFIX))?.slice(TOKEN_PREFIX.length);
  const token = encodedToken ? decodeBase64Url(encodedToken) : null;
  if (!token) return { ok: false, reason: "missing_token" };

  const digest = createHash("sha256").update(token).digest();
  if (digest.length !== config.tokenDigest.length || !timingSafeEqual(digest, config.tokenDigest)) {
    return { ok: false, reason: "invalid_token" };
  }

  return { ok: true };
}

export function selectedProtocol(protocols: Set<string>): string | false {
  return protocols.has(WIRE_PROTOCOL) ? WIRE_PROTOCOL : false;
}


export function authenticateBearer(authorization: string | undefined, config: ServerConfig): boolean {
  if (!authorization?.startsWith("Bearer ")) return false;
  const token = authorization.slice("Bearer ".length);
  const digest = createHash("sha256").update(token).digest();
  return digest.length === config.tokenDigest.length && timingSafeEqual(digest, config.tokenDigest);
}
