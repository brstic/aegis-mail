import { parentPort } from "node:worker_threads";
// Stand-ins for a parser or regex gone wrong. Each can only be stopped from outside.
parentPort.on("message", t => {
  if (t.op === "hang") for (;;) {}
  if (t.op === "oom") { const a = []; for (;;) a.push(new Array(1e6).fill(t.op)); }
  if (t.op === "throw") setImmediate(() => { throw new Error("boom"); });
  if (t.op === "echo") parentPort.postMessage({ ok: true, v: t.v });
});
