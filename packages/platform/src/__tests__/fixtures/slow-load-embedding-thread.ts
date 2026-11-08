import { parentPort } from "node:worker_threads";

/** A model that takes a long time to load, as a first download does. */
parentPort?.on("message", () => { setTimeout(() => parentPort!.postMessage({ ok: true, modelFetches: [] }), 120_000); });
