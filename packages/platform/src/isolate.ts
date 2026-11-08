import { Worker, type ResourceLimits } from "node:worker_threads";

export class IsolationTimeoutError extends Error { override name = "IsolationTimeoutError"; }
export class IsolationCrashError extends Error { override name = "IsolationCrashError"; }

interface Pending { resolve: (v: any) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }
interface Slot { worker: Worker; pending: Pending | null; busy: boolean }

/**
 * Runs hostile-input work on threads that can be killed. A regex or parser stuck on crafted mail can't be interrupted from
 * inside its own thread, and it would stall every tenant on this worker, so the only real timeout is terminating the thread.
 * Heap limits mean a memory bomb kills the thread rather than the process.
 */
export class IsolatedPool {
  private slots: Slot[] = [];
  private waiting: ((s: Slot) => void)[] = [];
  private closed = false;
  constructor(private script: URL, private opts: { size?: number; timeoutMs?: number; resourceLimits?: ResourceLimits; env?: NodeJS.Dict<string> } = {}) {}

  private spawn(): Slot {
    const worker = new Worker(this.script, {
      // Sources are TypeScript in every deployment, so the thread needs the same loader as its parent.
      execArgv: ["--import", "tsx"],
      resourceLimits: this.opts.resourceLimits ?? { maxOldGenerationSizeMb: 512 },
      // A thread that doesn't need secrets can be started without a copy of them.
      ...(this.opts.env ? { env: this.opts.env } : {}),
    });
    worker.unref();
    const slot: Slot = { worker, pending: null, busy: false };
    worker.on("message", msg => {
      const p = slot.pending;
      if (!p) return;
      clearTimeout(p.timer);
      slot.pending = null;
      this.release(slot);
      p.resolve(msg);
    });
    const fail = (e: Error) => {
      const p = slot.pending;
      slot.pending = null;
      this.slots = this.slots.filter(s => s !== slot);
      if (p) { clearTimeout(p.timer); p.reject(e); }
      this.pump();
    };
    worker.on("error", () => fail(new IsolationCrashError("analysis thread crashed")));
    worker.on("exit", () => fail(new IsolationCrashError("analysis thread exited")));
    this.slots.push(slot);
    return slot;
  }

  private release(slot: Slot) {
    const next = this.waiting.shift();
    if (next) next(slot); // Stays busy: handed straight to the next task.
    else slot.busy = false;
  }
  private pump() {
    if (!this.waiting.length || this.closed) return;
    if (this.slots.length < (this.opts.size ?? 4)) { const s = this.spawn(); s.busy = true; this.waiting.shift()!(s); }
  }
  private acquire(): Promise<Slot> {
    // Claimed synchronously, so two concurrent tasks can't land on one thread.
    const free = this.slots.find(s => !s.busy);
    if (free) { free.busy = true; return Promise.resolve(free); }
    if (this.slots.length < (this.opts.size ?? 4)) { const s = this.spawn(); s.busy = true; return Promise.resolve(s); }
    return new Promise(res => this.waiting.push(res));
  }

  async run<T>(task: unknown, timeoutMs?: number): Promise<T> {
    if (this.closed) throw new IsolationCrashError("pool closed");
    const slot = await this.acquire();
    return new Promise<T>((resolve, reject) => {
      const limit = timeoutMs ?? this.opts.timeoutMs ?? 30_000;
      const timer = setTimeout(() => {
        // The only way to stop it. A fresh thread takes its place on the next task.
        const p = slot.pending;
        slot.pending = null;
        this.slots = this.slots.filter(s => s !== slot);
        void slot.worker.terminate();
        p?.reject(new IsolationTimeoutError("analysis exceeded its time limit"));
        this.pump();
      }, limit);
      slot.pending = { resolve, reject, timer };
      slot.worker.ref();
      slot.worker.postMessage(task);
    }).finally(() => { if (!slot.busy) slot.worker.unref(); });
  }

  async close() {
    this.closed = true;
    await Promise.all(this.slots.map(s => s.worker.terminate()));
    this.slots = [];
  }
}
