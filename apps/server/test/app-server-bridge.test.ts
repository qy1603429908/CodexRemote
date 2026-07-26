import { describe, expect, it } from "vitest";
import { codexHomeMatches } from "../src/app-server-bridge.js";

describe("codexHomeMatches", () => {
  it("compares Windows Codex homes case-insensitively with normalized separators", () => {
    expect(codexHomeMatches(
      "C:\\Users\\Alice\\.codex\\",
      "c:/users/alice/.codex",
    )).toBe(true);
  });

  it("compares POSIX Codex homes exactly after normalization", () => {
    expect(codexHomeMatches("/Users/alice/.codex/", "/Users/alice/.codex")).toBe(true);
    expect(codexHomeMatches("/Users/Alice/.codex", "/Users/alice/.codex")).toBe(false);
  });

  it("rejects missing or mismatched Codex homes", () => {
    expect(codexHomeMatches("C:\\Users\\alice\\.codex", undefined)).toBe(false);
    expect(codexHomeMatches("C:\\Users\\alice\\.codex", "C:\\Users\\other\\.codex")).toBe(false);
  });
});
