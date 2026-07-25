import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("setup controls", () => {
  it("keeps credentials while exposing an explicit destructive refresh action", () => {
    const source = readFileSync(new URL("../src/components/SetupScreen.tsx", import.meta.url), "utf8");
    expect(source).toContain("清空缓存并全量刷新");
    expect(source).toContain("连接地址和配对令牌会保留");
    expect(source).toContain("删除所有版本的本地任务缓存");
  });

  it("uses a neutral example endpoint instead of a maintainer deployment", () => {
    const source = readFileSync(new URL("../src/components/SetupScreen.tsx", import.meta.url), "utf8");
    expect(source).toContain('placeholder="https://codex.example.com"');
    expect(source).not.toContain("qinmouren");
  });
});
