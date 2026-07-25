import { execFile } from "node:child_process";
import { realpath, stat } from "node:fs/promises";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const MAX_DIFF_BYTES = 2 * 1024 * 1024;
const MAX_UNTRACKED_FILES = 40;
const MAX_UNTRACKED_FILE_BYTES = 256 * 1024;

export interface GitDiffSnapshot {
  threadId: string;
  cwd: string;
  repositoryRoot: string;
  diff: string;
  files: number;
  additions: number;
  deletions: number;
  truncated: boolean;
  generatedAt: number;
  error?: string;
}

export class GitDiffError extends Error {
  constructor(readonly code: "cwd_unavailable" | "not_git_repository" | "git_failed", message: string) {
    super(message);
    this.name = "GitDiffError";
  }
}

export async function readGitDiff(threadId: string, cwdOrCandidates: string | string[]): Promise<GitDiffSnapshot> {
  const requestedCandidates = Array.isArray(cwdOrCandidates) ? cwdOrCandidates : [cwdOrCandidates];
  const canonicalCandidates: string[] = [];
  for (const candidate of requestedCandidates) {
    try {
      const canonical = await realpath(candidate);
      if ((await stat(canonical)).isDirectory() && !canonicalCandidates.includes(canonical)) canonicalCandidates.push(canonical);
    } catch {
      // Ignore stale tool-call cwd hints and continue with the remaining candidates.
    }
  }
  if (canonicalCandidates.length === 0) throw new GitDiffError("cwd_unavailable", "任务工作目录不存在或不可访问。");
  const canonicalCwd = canonicalCandidates[0]!;
  const environment = { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_PAGER: "cat", LC_ALL: "C" };
  const repositoryRoot = await chooseRepositoryRoot(canonicalCandidates, environment);

  const chunks: string[] = [];
  try {
    try {
      chunks.push(await runGit(repositoryRoot, ["diff", "--no-ext-diff", "--no-color", "--find-renames", "HEAD", "--"], environment));
    } catch (error) {
      if (!/unknown revision|bad revision|ambiguous argument|does not have any commits/i.test(String(error))) throw error;
      chunks.push(await runGit(repositoryRoot, ["diff", "--cached", "--no-ext-diff", "--no-color", "--find-renames", "--"], environment));
      chunks.push(await runGit(repositoryRoot, ["diff", "--no-ext-diff", "--no-color", "--find-renames", "--"], environment));
    }

    const untrackedRaw = await runGit(repositoryRoot, ["ls-files", "--others", "--exclude-standard", "-z"], environment);
    const untracked = untrackedRaw.split("\0").filter(Boolean).slice(0, MAX_UNTRACKED_FILES);
    for (const path of untracked) {
      const metadata = await stat(`${repositoryRoot}/${path}`).catch(() => null);
      if (!metadata?.isFile()) continue;
      if (metadata.size > MAX_UNTRACKED_FILE_BYTES) {
        chunks.push(omittedUntrackedPatch(path, metadata.size));
        continue;
      }
      try {
        chunks.push(await runGit(repositoryRoot, ["diff", "--no-index", "--no-ext-diff", "--no-color", "--", "/dev/null", path], environment, [0, 1]));
      } catch {
        chunks.push(omittedUntrackedPatch(path, metadata.size));
      }
    }
    if (untrackedRaw.split("\0").filter(Boolean).length > MAX_UNTRACKED_FILES) {
      chunks.push(`\n# Diff truncated: more than ${MAX_UNTRACKED_FILES} untracked files.\n`);
    }
  } catch (error) {
    throw new GitDiffError("git_failed", `读取 Git Diff 失败：${error instanceof Error ? error.message : String(error)}`);
  }

  let diff = chunks.filter(Boolean).join("\n").replace(/\n{3,}/g, "\n\n");
  let truncated = false;
  if (Buffer.byteLength(diff, "utf8") > MAX_DIFF_BYTES) {
    diff = Buffer.from(diff, "utf8").subarray(0, MAX_DIFF_BYTES).toString("utf8");
    diff += "\n\n# Diff truncated at 2 MiB.\n";
    truncated = true;
  }
  const stats = diffStats(diff);
  return {
    threadId,
    cwd: canonicalCwd,
    repositoryRoot,
    diff,
    ...stats,
    truncated: truncated || /# Diff truncated:/.test(diff),
    generatedAt: Date.now(),
  };
}

async function chooseRepositoryRoot(candidates: string[], env: NodeJS.ProcessEnv): Promise<string> {
  // The task cwd is the sole source of truth. `git -C <cwd> rev-parse` may
  // resolve an ancestor worktree, but we never scan child directories or use
  // tool-call cwd hints because those can belong to unrelated repositories.
  const taskCwd = candidates[0];
  if (!taskCwd) throw new GitDiffError("cwd_unavailable", "任务工作目录不存在或不可访问。");
  try {
    return await realpath((await runGit(taskCwd, ["rev-parse", "--show-toplevel"], env)).trim());
  } catch {
    throw new GitDiffError("not_git_repository", "任务工作目录不在 Git worktree 中。");
  }
}

async function runGit(
  cwd: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  acceptedExitCodes: number[] = [0],
): Promise<string> {
  try {
    const { stdout } = await execFileAsync("git", ["-C", cwd, ...args], {
      env,
      encoding: "utf8",
      timeout: 15_000,
      maxBuffer: MAX_DIFF_BYTES + 512 * 1024,
    });
    return stdout;
  } catch (error) {
    const candidate = error as Error & { code?: number | string; stdout?: string; stderr?: string };
    if (typeof candidate.code === "number" && acceptedExitCodes.includes(candidate.code)) return candidate.stdout ?? "";
    throw new Error(candidate.stderr?.trim() || candidate.message);
  }
}

function omittedUntrackedPatch(path: string, size: number): string {
  return [
    `diff --git a/${path} b/${path}`,
    "new file mode 100644",
    "--- /dev/null",
    `+++ b/${path}`,
    "@@ -0,0 +1 @@",
    `+[未展开的新文件：${size} bytes]`,
  ].join("\n");
}

export function diffStats(diff: string): { files: number; additions: number; deletions: number } {
  const files = new Set<string>();
  let additions = 0;
  let deletions = 0;
  for (const line of diff.split(/\r?\n/)) {
    const header = line.match(/^diff --git a\/(.+?) b\/(.+)$/);
    if (header) files.add(header[2] ?? header[1]!);
    else if (line.startsWith("+") && !line.startsWith("+++")) additions += 1;
    else if (line.startsWith("-") && !line.startsWith("---")) deletions += 1;
  }
  return { files: files.size, additions, deletions };
}
