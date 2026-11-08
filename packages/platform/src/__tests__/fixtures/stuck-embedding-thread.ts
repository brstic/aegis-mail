import { parentPort } from "node:worker_threads";

/** A model that loads fine and then never comes back. A busy loop, so only terminating the thread can stop it. */
parentPort?.on("message", (task: { op: string }) => {
  if (task.op === "load") { parentPort!.postMessage({ ok: true, modelFetches: [] }); return; }
  for (;;) { /* stuck */ }
});
