import { parentPort } from "node:worker_threads";
import type { EmbeddingResult, EmbeddingTask, EmbeddingThreadConfig } from "./embeddings";

/**
 * The only place the embedding library is imported. In this library every remote read goes through env.fetch (utils/hub.js,
 * getFile), so that one function decides what can leave: GET requests for this model's own files, during loading, and nothing else.
 * With a model directory, nothing can. Once loaded, env.fetch refuses everything, so text being embedded has no way out through it.
 */
const modelFetches: string[] = [];
const refuse = async (url: string | URL) => { throw new Error(`network refused for ${String(url).slice(0, 80)}`); };

type Extractor = (texts: string[], opts: { pooling: "mean"; normalize: boolean }) => Promise<{ data: Float32Array; dims: number[] }>;
let extractor: Promise<Extractor> | null = null;

async function load(config: EmbeddingThreadConfig): Promise<Extractor> {
  const { env, pipeline } = await import("@huggingface/transformers");
  env.allowLocalModels = true;
  if (config.modelDir) {
    env.localModelPath = config.modelDir;
    env.allowRemoteModels = false;
    env.useFSCache = false;
    env.fetch = refuse as typeof env.fetch;
  } else {
    env.allowRemoteModels = true;
    env.useFSCache = true;
    if (config.cacheDir) env.cacheDir = config.cacheDir;
    // Any revision of this model: the library looks up config.json on main to pick files, even with a revision set. The files it
    // then loads, weights included, come from the pinned one.
    const prefix = `${env.remoteHost}${config.model}/resolve/`;
    const real = globalThis.fetch.bind(globalThis);
    env.fetch = (async (url: string | URL, init?: RequestInit) => {
      if (!String(url).startsWith(prefix) || (init?.method && init.method !== "GET" && init.method !== "HEAD") || init?.body) return refuse(url);
      modelFetches.push(String(url));
      return real(url, init);
    }) as typeof env.fetch;
  }
  const made = await pipeline("feature-extraction", config.model, { dtype: "q8", revision: config.revision, local_files_only: !!config.modelDir, session_options: { intraOpNumThreads: config.threads, interOpNumThreads: 1 } });
  env.allowRemoteModels = false;
  env.fetch = refuse as typeof env.fetch;
  return made as unknown as Extractor;
}

async function handle(t: EmbeddingTask): Promise<EmbeddingResult> {
  const model = await (extractor ??= load(t.config).catch(e => { extractor = null; throw e; }));
  if (t.op === "load") return { ok: true, modelFetches: [...modelFetches] };
  const out = await model(t.texts, { pooling: "mean", normalize: true });
  return { ok: true, data: out.data, dimensions: out.dims[1]!, count: out.dims[0]! };
}

parentPort?.on("message", async (task: EmbeddingTask) => {
  // Only an error's name crosses back. Tokenizer and runtime errors can quote their input.
  try { parentPort!.postMessage(await handle(task)); }
  catch (e) { parentPort!.postMessage({ ok: false, error: e instanceof Error ? e.name : "unknown" } satisfies EmbeddingResult); }
});
