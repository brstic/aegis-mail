import { createRequire } from "node:module";
import { join } from "node:path";
import { vi } from "vitest";
import type { Platform } from "../index";

/**
 * Runs real route modules through the real dispatcher, without a Next server. Only next/headers is replaced, since cookies() needs a
 * live request. Everything after it (origin checks, session lookup, status codes, response bodies) is the production code.
 * Paths are built at runtime so this package's typecheck doesn't pull in the web app's.
 */
const WEB_SERVER = join(__dirname, "../../../../apps/web/src/server");
const webRequire = createRequire(join(WEB_SERVER, "router.ts"));
export const ORIGIN = "http://localhost:3000";

export interface WebClient {
  call(method: string, path: string, opts?: { token?: string | null; body?: unknown; rawBody?: string; headers?: Record<string, string>; origin?: string | null }): Promise<{ status: number; json: any; text: string }>;
  /** The response itself, for checking redirects. */
  raw(method: string, path: string, opts?: { token?: string | null }): Promise<Response>;
  routes: Record<string, { m: string; p: string; auth?: boolean }[]>;
}

// One per test file: the mocked next/headers is only taken up by the first import of the router, so later clients have to share what it reads.
const state: { token: string | null } = { token: null };

export async function webClient(p: Platform, moduleNames: string[]): Promise<WebClient> {
  vi.doMock(webRequire.resolve("next/headers"), () => ({
    cookies: async () => ({ get: () => (state.token ? { value: state.token } : undefined), set: () => {}, delete: () => {} }),
    headers: async () => new Headers({ host: "localhost:3000" }),
  }));
  (globalThis as unknown as { __aegis?: Platform }).__aegis = p;
  const routerPath = join(WEB_SERVER, "router.ts");
  const { dispatcher } = await import(/* @vite-ignore */ routerPath);
  const routes: WebClient["routes"] = {};
  const all: any[] = [];
  for (const name of moduleNames) {
    const mod = await import(/* @vite-ignore */ join(WEB_SERVER, "routes", `${name}.ts`));
    const list = (mod[`${name}Routes`] ?? mod[`${name.replace(/s$/, "")}Routes`]) as any[];
    routes[name] = list;
    all.push(...list);
  }
  const handle = dispatcher(all);
  return {
    routes,
    raw(method, path, opts = {}) {
      state.token = opts.token ?? null;
      return handle(new Request(`${ORIGIN}/api/v1${path}`, { method, headers: method === "GET" ? {} : { origin: ORIGIN } }), { params: Promise.resolve({ path: path.split("?")[0]!.split("/").filter(Boolean) }) });
    },
    async call(method, path, opts = {}) {
      state.token = opts.token ?? null;
      const url = `${ORIGIN}/api/v1${path}`;
      const headers = new Headers(opts.headers);
      if (opts.origin !== null && method !== "GET") headers.set("origin", opts.origin ?? ORIGIN);
      const body = opts.rawBody ?? (opts.body !== undefined ? JSON.stringify(opts.body) : undefined);
      const req = new Request(url, { method, headers, body });
      const segments = path.split("?")[0]!.split("/").filter(Boolean);
      const res: Response = await handle(req, { params: Promise.resolve({ path: segments }) });
      const text = await res.text();
      let json: any = null;
      try { json = JSON.parse(text); } catch { /* Not JSON. */ }
      return { status: res.status, json, text };
    },
  };
}
