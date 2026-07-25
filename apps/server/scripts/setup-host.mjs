import { access, chmod, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

const envPath = resolve(process.cwd(), ".env");
try {
  await access(envPath, constants.F_OK);
  console.error(`Refusing to overwrite existing ${envPath}`);
  process.exit(1);
} catch {}

const token = randomBytes(32).toString("base64url");
const body = [
  "# Bind to a Tailscale IP or a trusted LAN IP for phone access.",
  "# Keep 127.0.0.1 when using a local reverse proxy such as Tailscale Serve.",
  "CMR_HOST=127.0.0.1",
  "CMR_PORT=8787",
  `CMR_TOKEN=${token}`,
  "# CMR_ALLOWED_ORIGINS=capacitor://localhost,http://localhost",
  "# CODEX_BIN=/opt/homebrew/bin/codex",
  `CODEX_HOME=${process.env.CODEX_HOME?.trim() || join(homedir(), ".codex")}`,
  "# Download allowlist, comma-separated. When unset, only the private upload directory is allowed.",
  "# CMR_FILE_ROOTS=/path/to/allowed/root,/another/allowed/root",
  "# CMR_UPLOAD_DIRECTORY=/path/to/private/uploads",
  "",
].join("\n");
await writeFile(envPath, body, { encoding: "utf8", mode: 0o600 });
await chmod(envPath, 0o600);
console.log(`Created ${envPath} with mode 0600.`);
console.log(`Pairing token: ${token}`);
console.log("Edit CMR_HOST before connecting from a phone, or expose 127.0.0.1 through Tailscale Serve.");
