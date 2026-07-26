import { describe, expect, it } from "vitest";
import {
  detectPackagedNodeReplRuntime,
  nodeReplRuntimeConfigArgs,
} from "../src/codex-runtime.js";

function fakeExists(paths: string[]) {
  const available = new Set(paths);
  return (path: string) => available.has(path);
}

describe("packaged Node REPL runtime discovery", () => {
  it("finds the current ChatGPT.app cua_node layout", () => {
    const root = "/Applications/ChatGPT.app/Contents/Resources";
    const runtime = detectPackagedNodeReplRuntime({
      env: { CMR_CODEX_APP_RESOURCES: root },
      platform: "darwin",
      homeDirectory: "/Users/alice",
      pathExists: fakeExists([
        `${root}/cua_node/bin/node_repl`,
        `${root}/cua_node/bin/node`,
        `${root}/cua_node/lib/node_modules`,
        `${root}/codex`,
      ]),
    });
    expect(runtime).toEqual({
      resourcesDirectory: root,
      nodeRepl: `${root}/cua_node/bin/node_repl`,
      node: `${root}/cua_node/bin/node`,
      nodeModules: `${root}/cua_node/lib/node_modules`,
      codex: `${root}/codex`,
    });
  });

  it("keeps compatibility with the legacy Resources/node_repl layout", () => {
    const root = "/Applications/Codex.app/Contents/Resources";
    const runtime = detectPackagedNodeReplRuntime({
      env: { CMR_CODEX_APP_RESOURCES: root },
      platform: "darwin",
      pathExists: fakeExists([
        `${root}/node_repl`,
        `${root}/node`,
        `${root}/node_modules`,
        `${root}/codex`,
      ]),
    });
    expect(runtime?.nodeRepl).toBe(`${root}/node_repl`);
  });

  it("can be disabled and does not apply macOS paths on other platforms", () => {
    expect(detectPackagedNodeReplRuntime({
      env: { CMR_AUTO_NODE_REPL_RUNTIME: "0" },
      platform: "darwin",
      pathExists: () => true,
    })).toBeNull();
    expect(detectPackagedNodeReplRuntime({
      env: {},
      platform: "win32",
      pathExists: () => true,
    })).toBeNull();
  });

  it("builds Codex CLI config overrides for the discovered runtime", () => {
    const args = nodeReplRuntimeConfigArgs({
      resourcesDirectory: "/Applications/ChatGPT.app/Contents/Resources",
      nodeRepl: "/Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node_repl",
      node: "/Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node",
      nodeModules: "/Applications/ChatGPT.app/Contents/Resources/cua_node/lib/node_modules",
      codex: "/Applications/ChatGPT.app/Contents/Resources/codex",
    }, "/Users/alice/.codex");
    expect(args).toContain('mcp_servers.node_repl.command="/Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node_repl"');
    expect(args).toContain('mcp_servers.node_repl.env.NODE_REPL_NODE_PATH="/Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node"');
    expect(args).toContain('mcp_servers.node_repl.env.NODE_REPL_NODE_MODULE_DIRS="/Applications/ChatGPT.app/Contents/Resources/cua_node/lib/node_modules"');
    expect(args).toContain('mcp_servers.node_repl.env.NODE_REPL_TRUSTED_CODE_PATHS="/Users/alice/.codex"');
  });
});
