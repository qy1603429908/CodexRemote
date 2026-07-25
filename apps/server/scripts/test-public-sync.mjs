import fs from "node:fs";
import WebSocket from "ws";

const target = process.argv[2] ?? "ws://127.0.0.1:8787/ws";
const env = Object.fromEntries(
  fs.readFileSync(new URL("../../../.env", import.meta.url), "utf8")
    .split(/\r?\n/)
    .filter((line) => line && !line.startsWith("#"))
    .map((line) => {
      const split = line.indexOf("=");
      return [line.slice(0, split), line.slice(split + 1)];
    }),
);
if (!env.CMR_TOKEN) throw new Error("CMR_TOKEN is missing from .env");
const tokenProtocol = `token.${Buffer.from(env.CMR_TOKEN).toString("base64url")}`;

function exchange(messages, expectedTypes) {
  return new Promise((resolve, reject) => {
    const frames = [];
    const socket = new WebSocket(target, ["codex-mobile-v1", tokenProtocol]);
    const timer = setTimeout(() => {
      socket.terminate();
      reject(new Error(`Timed out; received ${frames.map((frame) => frame.value.type).join(", ")}`));
    }, 30_000);
    socket.on("error", reject);
    socket.on("message", (data) => {
      const raw = String(data);
      const value = JSON.parse(raw);
      frames.push({ bytes: Buffer.byteLength(raw), value });
      if (value.type === "welcome") {
        for (const message of messages(value)) socket.send(JSON.stringify(message));
      }
      if (expectedTypes.every((type) => frames.some((frame) => frame.value.type === type))) {
        clearTimeout(timer);
        socket.close();
        resolve(frames);
      }
    });
  });
}

const first = await exchange(
  () => [
    { type: "sync.resume", requestId: "first-resume", threadIds: [] },
    { type: "threads.sync", requestId: "first-threads", knownVersion: 0 },
  ],
  ["welcome", "sync.reset", "threads.snapshot"],
);
const firstWelcome = first.find((frame) => frame.value.type === "welcome").value;
const snapshot = first.find((frame) => frame.value.type === "threads.snapshot").value;
const reconnect = await exchange(
  () => [
    {
      type: "sync.resume",
      requestId: "second-resume",
      syncVersion: firstWelcome.syncVersion,
      cursor: firstWelcome.latestCursor ?? 0,
      threadIds: [],
    },
    {
      type: "threads.sync",
      requestId: "second-threads",
      knownVersion: snapshot.version,
    },
  ],
  ["welcome", "sync.replay", "threads.delta"],
);

function summary(frames) {
  return {
    frames: frames.length,
    bytes: frames.reduce((total, frame) => total + frame.bytes, 0),
    types: frames.map((frame) => `${frame.value.type}:${frame.bytes}`),
    threads: frames.find((frame) => frame.value.type === "threads.snapshot")?.value.threads?.length,
    upserts: frames.find((frame) => frame.value.type === "threads.delta")?.value.upserts?.length,
    replayEvents: frames.find((frame) => frame.value.type === "sync.replay")?.value.events?.length,
  };
}
const initial = summary(first);
const resumed = summary(reconnect);
console.log(`PUBLIC_WSS ${target}`);
console.log(`FIRST frames=${initial.frames} bytes=${initial.bytes} threads=${initial.threads} types=${initial.types.join(",")}`);
console.log(`RECONNECT frames=${resumed.frames} bytes=${resumed.bytes} delta_upserts=${resumed.upserts} replay_events=${resumed.replayEvents} types=${resumed.types.join(",")}`);
console.log(`RATIO ${(resumed.bytes / initial.bytes).toFixed(6)} reduction=${(100 * (1 - resumed.bytes / initial.bytes)).toFixed(2)}%`);
