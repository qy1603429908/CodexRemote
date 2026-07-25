import { homedir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildCodexEnvironment, loadConfig } from "../src/config.js";

describe("loadConfig", () => {
  it("requires a sufficiently long token", () => {
    expect(() => loadConfig({ CMR_TOKEN: "short" })).toThrow(/at least 32/);
  });

  it("loads safe defaults", () => {
    const config = loadConfig({ CMR_TOKEN: "a".repeat(32) });
    expect(config.host).toBe("127.0.0.1");
    expect(config.port).toBe(8787);
    expect(config.allowedOrigins.has("capacitor://localhost")).toBe(true);
    expect(config.fileRoots).toEqual([config.uploadDirectory]);
    expect(config.codexHome).toBe(join(homedir(), ".codex"));
  });

  it("only opts explicit file roots into host downloads", () => {
    const config = loadConfig({ CMR_TOKEN: "a".repeat(32), CMR_FILE_ROOTS: "/safe/project,/safe/output" });
    expect(config.fileRoots).toEqual(["/safe/project", "/safe/output"]);
  });

  it("honors an explicit Codex home and forces it into the app-server environment", () => {
    const config = loadConfig({
      CMR_TOKEN: "a".repeat(32),
      CODEX_HOME: "C:\\Users\\alice\\.codex-custom",
    });
    expect(config.codexHome).toBe("C:\\Users\\alice\\.codex-custom");
    expect(buildCodexEnvironment(config.codexHome, { CODEX_HOME: "wrong", KEEP: "yes" })).toMatchObject({
      CODEX_HOME: "C:\\Users\\alice\\.codex-custom",
      KEEP: "yes",
    });
  });

});
