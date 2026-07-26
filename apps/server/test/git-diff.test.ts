import { execFile } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { diffStats, readGitDiff } from "../src/git-diff.js";

const exec = promisify(execFile);
const directories: string[] = [];
afterEach(async () => {
  while (directories.length) await rm(directories.pop()!, { recursive: true, force: true });
});

async function git(cwd: string, ...args: string[]) {
  await exec("git", ["-C", cwd, ...args]);
}

describe("Git diff snapshots", () => {
  it("reads tracked and untracked changes with file and line statistics", async () => {
    const repository = await mkdtemp(join(tmpdir(), "cmr-git-"));
    directories.push(repository);
    await git(repository, "init", "-q");
    await git(repository, "config", "user.email", "test@example.com");
    await git(repository, "config", "user.name", "Test");
    await writeFile(join(repository, "tracked.txt"), "one\ntwo\n");
    await git(repository, "add", "tracked.txt");
    await git(repository, "commit", "-qm", "initial");
    await writeFile(join(repository, "tracked.txt"), "one\nchanged\nthree\n");
    await writeFile(join(repository, "new.txt"), "new\n");

    const snapshot = await readGitDiff("thread-1", repository);
    expect(snapshot.repositoryRoot).toBe(await realpath(repository));
    expect(snapshot.diff).toContain("tracked.txt");
    expect(snapshot.diff).toContain("new.txt");
    expect(snapshot.files).toBe(2);
    expect(snapshot.additions).toBeGreaterThanOrEqual(3);
    expect(snapshot.deletions).toBe(1);
  });

  it("does not discover an unrelated repository below a non-Git task directory", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "cmr-workspace-"));
    directories.push(workspace);
    const repository = join(workspace, "project");
    await mkdir(repository, { recursive: true });
    await git(repository, "init", "-q");
    await writeFile(join(repository, "new.md"), "hello\n");
    await expect(readGitDiff("thread-2", workspace)).rejects.toMatchObject({ code: "not_git_repository" });
  });

  it("uses an ancestor worktree when the task cwd is inside that repository", async () => {
    const repository = await mkdtemp(join(tmpdir(), "cmr-nested-git-"));
    directories.push(repository);
    await git(repository, "init", "-q");
    const nested = join(repository, "packages", "mobile");
    await mkdir(nested, { recursive: true });
    await writeFile(join(nested, "new.md"), "hello\n");
    const snapshot = await readGitDiff("thread-3", nested);
    expect(snapshot.repositoryRoot).toBe(await realpath(repository));
    expect(snapshot.files).toBe(1);
  });

  it("counts diff metadata without treating headers as changes", () => {
    expect(diffStats("diff --git a/a b/a\n--- a/a\n+++ b/a\n-old\n+new\n")).toEqual({ files: 1, additions: 1, deletions: 1 });
  });
});
