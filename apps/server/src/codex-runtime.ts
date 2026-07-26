import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join } from "node:path";

export interface PackagedNodeReplRuntime {
  resourcesDirectory: string;
  nodeRepl: string;
  node: string;
  nodeModules: string;
  codex: string;
}

interface DetectRuntimeOptions {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  homeDirectory?: string;
  pathExists?: (path: string) => boolean;
}

/**
 * Locate the Node REPL runtime bundled with the desktop Codex/ChatGPT app.
 *
 * The desktop bundle name and resource layout have both changed over time:
 * older installs used Codex.app/Contents/Resources/node_repl, while current
 * macOS installs use ChatGPT.app/Contents/Resources/cua_node/bin/node_repl.
 * Keeping this discovery in the Host prevents a stale global config path from
 * silently removing Computer Use and Browser/Chrome tools from mobile-created
 * app-server tasks.
 */
export function detectPackagedNodeReplRuntime(
  options: DetectRuntimeOptions = {},
): PackagedNodeReplRuntime | null {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  if (platform !== "darwin" || env.CMR_AUTO_NODE_REPL_RUNTIME === "0") return null;

  const pathExists = options.pathExists ?? existsSync;
  const homeDirectory = options.homeDirectory ?? homedir();
  const candidates: string[] = [];
  const append = (value: string | undefined) => {
    const normalized = value?.trim();
    if (normalized && !candidates.includes(normalized)) candidates.push(normalized);
  };

  append(env.CMR_CODEX_APP_RESOURCES);
  const configuredCodex = env.CODEX_BIN?.trim();
  if (configuredCodex && isAbsolute(configuredCodex) && basename(configuredCodex) === "codex")
    append(dirname(configuredCodex));
  append("/Applications/ChatGPT.app/Contents/Resources");
  append("/Applications/Codex.app/Contents/Resources");
  append(join(homeDirectory, "Applications", "ChatGPT.app", "Contents", "Resources"));
  append(join(homeDirectory, "Applications", "Codex.app", "Contents", "Resources"));

  for (const resourcesDirectory of candidates) {
    const layouts = [
      {
        nodeRepl: join(resourcesDirectory, "cua_node", "bin", "node_repl"),
        node: join(resourcesDirectory, "cua_node", "bin", "node"),
        nodeModules: join(resourcesDirectory, "cua_node", "lib", "node_modules"),
      },
      {
        nodeRepl: join(resourcesDirectory, "node_repl"),
        node: join(resourcesDirectory, "node"),
        nodeModules: join(resourcesDirectory, "node_modules"),
      },
    ];
    const codex = join(resourcesDirectory, "codex");
    for (const layout of layouts) {
      if (
        pathExists(layout.nodeRepl) &&
        pathExists(layout.node) &&
        pathExists(layout.nodeModules) &&
        pathExists(codex)
      )
        return { resourcesDirectory, ...layout, codex };
    }
  }
  return null;
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}

/** CLI overrides are placed before `app-server`, matching Codex CLI syntax. */
export function nodeReplRuntimeConfigArgs(
  runtime: PackagedNodeReplRuntime | null,
  codexHome: string,
): string[] {
  if (!runtime) return [];
  const overrides = [
    ["mcp_servers.node_repl.command", runtime.nodeRepl],
    ["mcp_servers.node_repl.env.NODE_REPL_NODE_PATH", runtime.node],
    ["mcp_servers.node_repl.env.NODE_REPL_NODE_MODULE_DIRS", runtime.nodeModules],
    ["mcp_servers.node_repl.env.CODEX_CLI_PATH", runtime.codex],
    ["mcp_servers.node_repl.env.CODEX_HOME", codexHome],
    ["mcp_servers.node_repl.env.NODE_REPL_TRUSTED_CODE_PATHS", codexHome],
  ] as const;
  return overrides.flatMap(([key, value]) => ["-c", `${key}=${tomlString(value)}`]);
}
