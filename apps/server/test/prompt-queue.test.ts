import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PromptQueueStore } from "../src/prompt-queue.js";

const directories: string[] = [];
afterEach(async () => {
  while (directories.length) await rm(directories.pop()!, { recursive: true, force: true });
});

async function createStore(now = () => 1_000) {
  const directory = await mkdtemp(join(tmpdir(), "cmr-queue-"));
  directories.push(directory);
  const filename = join(directory, "prompt-queue.json");
  return { filename, store: await PromptQueueStore.create(filename, now) };
}

const input = {
  threadId: "thread-1",
  clientUserMessageId: "client-1",
  text: "queued prompt",
  turnParams: { threadId: "thread-1", input: [{ type: "text", text: "queued prompt" }] },
  fileNames: ["note.md"],
  filePaths: ["/tmp/upload/note.md"],
  uploadIds: ["upload-1"],
};

describe("PromptQueueStore", () => {
  it("persists queued prompts and protects their file paths", async () => {
    const { filename, store } = await createStore();
    const item = await store.enqueue(input);
    expect(store.list("thread-1")).toMatchObject([{ id: item.id, status: "queued", text: "queued prompt" }]);
    expect(store.protectedFilePaths()).toEqual(new Set(["/tmp/upload/note.md"]));
    const reloaded = await PromptQueueStore.create(filename, () => 2_000);
    expect(reloaded.get(item.id)).toMatchObject({ uploadIds: ["upload-1"], status: "queued" });
    expect(JSON.parse(await readFile(filename, "utf8"))).toMatchObject({ version: 1 });
  });

  it("marks an in-flight delivery uncertain after a Host restart", async () => {
    const { filename, store } = await createStore();
    const item = await store.enqueue(input);
    await store.claim(item.id);
    const reloaded = await PromptQueueStore.create(filename, () => 2_000);
    expect(reloaded.list()).toMatchObject([{ id: item.id, status: "uncertain" }]);
    expect(reloaded.list()[0]?.error).toContain("结果未知");
  });

  it("coalesces the same queued client id and rejects conflicting content", async () => {
    const { store } = await createStore();
    const first = await store.enqueue(input);
    const duplicate = await store.enqueue(input);
    expect(duplicate.id).toBe(first.id);
    await expect(store.enqueue({ ...input, text: "different" })).rejects.toThrow("idempotency_conflict");
  });
});
