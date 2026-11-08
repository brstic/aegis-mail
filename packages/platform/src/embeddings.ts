import { existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { isMainThread } from "node:worker_threads";
import { IsolatedPool, IsolationTimeoutError } from "./isolate";

/** Turns text into unit-length vectors. Implementations must never send the text anywhere. */
export interface EmbeddingProvider {
  /** Stored beside each vector. Vectors from different models can't be compared, so a change here means a re-embed. */
  readonly id: string;
  readonly dimensions: number;
  /** timeoutMs bounds the whole call, however long the model takes to load. Without it, the provider's own limits apply. */
  embed(texts: string[], opts?: { timeoutMs?: number }): Promise<Float32Array[]>;
  close?(): Promise<void>;
}

export const LOCAL_EMBEDDING_MODEL = "Xenova/all-MiniLM-L6-v2";
/** Pinned, so a change upstream can't swap the model file under a running deployment. */
export const LOCAL_EMBEDDING_REVISION = "751bff37182d3f1213fa05d7196b954e230abad9";
const DIMENSIONS = 384;
/** Roughly the 256 tokens this model reads. It truncates anyway, so longer text would only cost time. */
export const MAX_EMBEDDING_CHARS = 1500;

export interface EmbeddingThreadConfig { model: string; revision: string; modelDir?: string; cacheDir?: string; threads: number }
export type EmbeddingTask = { op: "load"; config: EmbeddingThreadConfig } | { op: "embed"; config: EmbeddingThreadConfig; texts: string[] };
export interface EmbeddingResult { ok: boolean; error?: string; dimensions?: number; data?: Float32Array; count?: number; modelFetches?: string[] }

export class EmbeddingUnavailableError extends Error { override name = "EmbeddingUnavailableError"; }

/** Walks up from the working directory, as the dev key does: this code gets bundled into the web process, which has no stable import.meta.url. */
function repoRoot() {
  let dir = process.cwd();
  for (let i = 0; i < 6 && !existsSync(join(/*turbopackIgnore: true*/ dir, "pnpm-workspace.yaml")); i++) dir = join(/*turbopackIgnore: true*/ dir, "..");
  return dir;
}

/**
 * Runs the model on a thread IsolatedPool can kill, so a stuck model costs its own timeout and nothing else. The library is only
 * ever imported on that thread, which also keeps it and its native addon out of the web bundle.
 */
export class LocalEmbeddingProvider implements EmbeddingProvider {
  readonly id = `${LOCAL_EMBEDDING_MODEL}@${LOCAL_EMBEDDING_REVISION.slice(0, 12)}:q8`;
  readonly dimensions = DIMENSIONS;
  private pool: IsolatedPool | null = null;
  private loading: Promise<EmbeddingResult> | null = null;
  private readonly config: EmbeddingThreadConfig;
  private readonly loadTimeoutMs: number;
  private readonly embedTimeoutMs: number;
  private readonly script: URL;

  constructor(opts: { modelDir?: string; cacheDir?: string; threads?: number; embedTimeoutMs?: number; loadTimeoutMs?: number; script?: URL } = {}) {
    // ONNX Runtime ships Microsoft telemetry that phones home unless this is in the real environment when its addon loads. The library sets
    // it too, but on a worker thread process.env is only a copy that native code can't see, so telemetry ran until this was added.
    // Only the main thread can set the real environment, so anywhere else this refuses rather than run with it on.
    if (!isMainThread) throw new EmbeddingUnavailableError("embedding provider must be created on the main thread");
    process.env.ORT_DISABLE_TELEMETRY = "1";
    const root = repoRoot();
    this.config = {
      model: LOCAL_EMBEDDING_MODEL, revision: LOCAL_EMBEDDING_REVISION, modelDir: opts.modelDir,
      cacheDir: opts.modelDir ? undefined : opts.cacheDir ?? join(/*turbopackIgnore: true*/ root, ".cache", "embeddings"), threads: opts.threads ?? 2,
    };
    this.embedTimeoutMs = opts.embedTimeoutMs ?? 30_000;
    // A first run may be downloading about 23 MB of model.
    this.loadTimeoutMs = opts.loadTimeoutMs ?? 5 * 60_000;
    this.script = opts.script ?? pathToFileURL(join(/*turbopackIgnore: true*/ root, "packages", "platform", "src", "embedding-thread.ts"));
  }

  /** One thread: the model has its own intra-op threads, and a second thread would load a second copy. */
  private threadPool() {
    return (this.pool ??= new IsolatedPool(this.script, { size: 1, timeoutMs: this.embedTimeoutMs, resourceLimits: { maxOldGenerationSizeMb: 512 }, env: {} }));
  }

  /** Loads the model, downloading it first if it's allowed to and has to. What it fetched comes back, for tests to check. */
  async load(): Promise<EmbeddingResult> {
    this.loading ??= this.threadPool().run<EmbeddingResult>({ op: "load", config: this.config } satisfies EmbeddingTask, this.loadTimeoutMs).finally(() => { this.loading = null; });
    const r = await this.loading;
    if (!r.ok) throw new EmbeddingUnavailableError(r.error ?? "model_load_failed");
    return r;
  }

  private async embedNow(texts: string[], timeoutMs?: number) {
    await this.load();
    const r = await this.threadPool().run<EmbeddingResult>({ op: "embed", config: this.config, texts: texts.map(t => t.slice(0, MAX_EMBEDDING_CHARS)) } satisfies EmbeddingTask, timeoutMs ?? this.embedTimeoutMs);
    if (!r.ok || !r.data || !r.dimensions) throw new EmbeddingUnavailableError(r.error ?? "embedding_failed");
    return texts.map((_, i) => r.data!.slice(i * r.dimensions!, (i + 1) * r.dimensions!));
  }

  async embed(texts: string[], opts: { timeoutMs?: number } = {}): Promise<Float32Array[]> {
    if (!texts.length) return [];
    const work = this.embedNow(texts, opts.timeoutMs);
    if (!opts.timeoutMs) return work;
    // A search can't wait for a model to load, or to download. It goes on loading, so the next search finds it ready.
    work.catch(() => {});
    let timer: NodeJS.Timeout;
    const late = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new IsolationTimeoutError("embedding exceeded its time limit")), opts.timeoutMs); });
    return Promise.race([work, late]).finally(() => clearTimeout(timer));
  }

  async close() { await this.pool?.close(); this.pool = null; }
}

/** Off unless a deployment asks for it. Only ever started on first use, so setting it costs nothing until mail arrives. */
export function embeddingsFromEnv(env: NodeJS.ProcessEnv): EmbeddingProvider | null {
  if (env.AEGIS_EMBEDDINGS !== "local") return null;
  return new LocalEmbeddingProvider({ modelDir: env.AEGIS_EMBEDDINGS_MODEL_DIR || undefined, cacheDir: env.AEGIS_EMBEDDINGS_CACHE_DIR || undefined, threads: Number(env.AEGIS_EMBEDDINGS_THREADS || 2) });
}
