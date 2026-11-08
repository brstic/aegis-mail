"use client";
import { QueryClient, QueryClientProvider, useMutation, useQuery, useQueryClient, type UseQueryOptions } from "@tanstack/react-query";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

export class ApiError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message); this.name = "ApiError"; }
}

/** Preference saves go out one at a time. Otherwise a slow earlier save can land last, and undo what the person just chose. */
let prefSaves: Promise<unknown> = Promise.resolve();
export function api<T = any>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  if (path === "/preferences" && init.method === "PATCH") {
    const run = prefSaves.then(() => send<T>(path, init));
    prefSaves = run.catch(() => undefined);
    return run;
  }
  return send<T>(path, init);
}

async function send<T = any>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`/api/v1${path}`, { method: init.method ?? (init.body !== undefined ? "POST" : "GET"), headers: init.body !== undefined ? { "Content-Type": "application/json" } : undefined, body: init.body !== undefined ? JSON.stringify(init.body) : undefined, credentials: "same-origin" });
  } catch {
    throw new ApiError(0, "offline", "You appear to be offline. Nothing was changed.");
  }
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    // A wrong password when confirming something isn't the same as being signed out, so the person stays where they are.
    const stillSignedIn = ["invalid_credentials", "invalid_mfa", "reauth_required", "mfa_required"].includes(data?.error?.code);
    if (res.status === 401 && !stillSignedIn && typeof window !== "undefined" && !path.startsWith("/auth/") && !path.startsWith("/demo/")) window.location.href = "/sign-in";
    throw new ApiError(res.status, data?.error?.code ?? "unknown", data?.error?.message ?? "Something went wrong.");
  }
  return data as T;
}

export function useApi<T = any>(key: unknown[], path: string | null, opts?: Partial<UseQueryOptions<T, ApiError>>) {
  // A query keeps one function, from whichever observer rendered last, and an invalidation runs it. So a switched-off observer gets its
  // own key: sharing one would have live observers fetch this one's null path, and get a 404 instead of their data.
  return useQuery<T, ApiError>({ queryKey: path === null ? [...key, "off"] : key, queryFn: () => api<T>(path!), enabled: path !== null, retry: (n, e) => e.status === 0 ? false : e.status >= 500 && n < 2, ...opts });
}

export interface ToastItem { id: number; text: string; tone?: "default" | "danger"; action?: { label: string; run: () => void } }
const ToastCtx = createContext<(t: Omit<ToastItem, "id">) => void>(() => {});
export const useToast = () => useContext(ToastCtx);

function Toasts({ items, dismiss }: { items: ToastItem[]; dismiss: (id: number) => void }) {
  return (
    <div className="fixed bottom-4 left-1/2 z-50 flex w-[min(92vw,30rem)] -translate-x-1/2 flex-col gap-2" role="status" aria-live="polite">
      {items.map(t => (
        <div key={t.id} className={`row-enter flex items-center justify-between gap-3 rounded-lg px-4 py-2.5 text-sm shadow-soft ${t.tone === "danger" ? "bg-danger-soft text-danger border border-danger/30" : "bg-ink text-bg"}`}>
          <span>{t.text}</span>
          <span className="flex shrink-0 gap-3">
            {t.action && <button className="font-semibold underline underline-offset-2" onClick={() => { t.action!.run(); dismiss(t.id); }}>{t.action.label}</button>}
            <button aria-label="Dismiss" onClick={() => dismiss(t.id)} className="opacity-70 hover:opacity-100">×</button>
          </span>
        </div>
      ))}
    </div>
  );
}

export function Providers({ children }: { children: ReactNode }) {
  const [qc] = useState(() => new QueryClient({ defaultOptions: { queries: { staleTime: 5_000, refetchOnWindowFocus: true } } }));
  const [items, setItems] = useState<ToastItem[]>([]);
  const seq = useRef(0);
  const dismiss = useCallback((id: number) => setItems(x => x.filter(t => t.id !== id)), []);
  const push = useCallback((t: Omit<ToastItem, "id">) => {
    const id = ++seq.current;
    setItems(x => [...x.slice(-2), { ...t, id }]);
    setTimeout(() => dismiss(id), t.action ? 8000 : 4500);
  }, [dismiss]);
  return <QueryClientProvider client={qc}><ToastCtx.Provider value={push}>{children}<Toasts items={items} dismiss={dismiss} /></ToastCtx.Provider></QueryClientProvider>;
}

export function useOnline() {
  const [online, set] = useState(true);
  useEffect(() => {
    const on = () => set(true), off = () => set(false);
    set(navigator.onLine);
    window.addEventListener("online", on); window.addEventListener("offline", off);
    return () => { window.removeEventListener("online", on); window.removeEventListener("offline", off); };
  }, []);
  return online;
}

/** Refresh everything mail-related after a change. */
export function useRefreshMail() {
  const qc = useQueryClient();
  return useCallback(() => {
    for (const k of ["threads", "focus", "thread", "accounts", "drafts", "tasks", "digest", "labels"]) void qc.invalidateQueries({ queryKey: [k] });
  }, [qc]);
}

export function useAction<V = void, R = any>(fn: (v: V) => Promise<R>, opts: { success?: string | ((r: R) => string); onDone?: (r: R) => void; refresh?: boolean } = {}) {
  const toast = useToast();
  const refresh = useRefreshMail();
  return useMutation<R, ApiError, V>({
    mutationFn: fn,
    onSuccess: r => { if (opts.refresh !== false) refresh(); if (opts.success) toast({ text: typeof opts.success === "function" ? opts.success(r) : opts.success }); opts.onDone?.(r); },
    onError: e => toast({ text: e.message, tone: "danger" }),
  });
}

export function useMe() { return useApi<{ id: string; email: string; name: string; tenantId: string; role: string; workspaces: { id: string; name: string; kind: string; role: string }[]; mfaEnabled: boolean; reauthWithPassword: boolean; demoMode: boolean; emailVerified: boolean; mailAvailable: boolean; suspendedWorkspaces?: { name: string; reason: string }[] }>(["me"], "/me", { staleTime: 60_000 }); }
export function usePrefs() { return useApi<any>(["prefs"], "/preferences", { staleTime: 60_000 }); }
export function useAccounts() { return useApi<Account[]>(["accounts"], "/accounts", { refetchInterval: 20_000 }); }

export interface Capabilities { twoWaySync: boolean; pushNotifications: boolean; latencyBudgetSeconds: number; send: boolean; readOnlyMode: boolean; limitations: string[]; oauth: boolean; revokeSupported: boolean; labels: string; serverSearch: boolean }
export interface Account { id: string; kind: string; email: string; displayName: string; color: string; isPrimary: boolean; status: string; statusDetail?: string; readOnly: boolean; simulated: string | null; unread: number; owned: boolean; canSend: boolean; aliases: { address: string; name?: string }[]; sync: { phase: string; lastSuccessAt: string | null; lastAttemptAt: string | null; lastError: string | null; messagesSynced: number }; capabilities: Capabilities }
export interface ThreadRow { match?: "words" | "meaning" | "both"; id: string; accountId: string; messageId: string; subject: string; snippet: string; from?: { name?: string; address: string }; to: { name?: string; address: string }[]; date: string; isRead: boolean; isStarred: boolean; hasAttachments: boolean; count: number; folder: string; risk: string | null; action: string | null; held: boolean; section: string | null; topics: string[]; intent: string; score: number | null; reasons?: string[]; confidence?: number; needsReply?: boolean; due?: { text: string; iso?: string; uncertain: boolean; evidence: string }; labels: { id: string; name: string; color: string | null }[]; lastFromMe: boolean; failed: boolean; duplicateOf: string | null }

// "g" starts a two-key shortcut, so the key after it mustn't also act on the list: "g then s" goes to Sent, it doesn't star.
// Worked out in the capture phase, because the order of the handlers below changes as they re-register.
let goAt = 0, goChord = false, chordBound = false;
function trackChord(e: KeyboardEvent) {
  if ((e.target as HTMLElement)?.closest?.("input,textarea,select,[contenteditable],[role=dialog],[role=menu]") || e.metaKey || e.ctrlKey || e.altKey || e.key === "Shift") { goChord = false; return; }
  goChord = Date.now() - goAt < 1000;
  goAt = !goChord && e.key === "g" ? Date.now() : 0;
}
/** True while handling the key that follows "g". */
export const isGoChord = () => goChord;

export function useKeyboard(handler: (e: KeyboardEvent) => void, deps: unknown[]) {
  const stable = useMemo(() => handler, deps); // eslint-disable-line
  useEffect(() => {
    if (!chordBound) { window.addEventListener("keydown", trackChord, true); chordBound = true; }
    const on = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t?.closest("input,textarea,select,[contenteditable],[role=dialog],[role=menu]") || e.metaKey || e.ctrlKey || e.altKey) return;
      stable(e);
    };
    window.addEventListener("keydown", on);
    return () => window.removeEventListener("keydown", on);
  }, [stable]);
}

/** True when the event came from something that has its own meaning for Enter and the arrow keys, like a link or a button. */
export function onInteractive(e: KeyboardEvent) {
  return !!(e.target as HTMLElement | null)?.closest?.("a,button,summary,[role=button],[role=switch],[tabindex]");
}

/** Matches a media query after mount. Starts false, so server and first client render agree. */
export function useMediaQuery(query: string) {
  const [match, setMatch] = useState(false);
  useEffect(() => {
    const m = window.matchMedia(query);
    const on = () => setMatch(m.matches);
    on();
    m.addEventListener("change", on);
    return () => m.removeEventListener("change", on);
  }, [query]);
  return match;
}

// One Escape press closes one thing: the most recently opened. Modal and Sheet handle theirs first, in the capture phase.
const escapeStack: { run: { current: () => void }; priority: number }[] = [];
let escapeBound = false;
function onEscape(e: KeyboardEvent) {
  if (e.key !== "Escape" || e.defaultPrevented) return;
  // Highest priority first, then the most recent: a thread that finishes opening mustn't take Esc away from the composer on top of it.
  const top = escapeStack.reduce<(typeof escapeStack)[number] | null>((best, x) => !best || x.priority >= best.priority ? x : best, null);
  if (top) { e.preventDefault(); top.run.current(); }
}
export function useEscape(handler: () => void, active = true, priority = 0) {
  const ref = useRef(handler);
  useEffect(() => { ref.current = handler; });
  useEffect(() => {
    if (!active) return;
    if (!escapeBound) { window.addEventListener("keydown", onEscape); escapeBound = true; }
    const entry = { run: ref, priority };
    escapeStack.push(entry);
    return () => { const i = escapeStack.indexOf(entry); if (i >= 0) escapeStack.splice(i, 1); };
  }, [active, priority]);
}

export function relTime(iso: string, now = Date.now()) {
  const d = new Date(iso), diff = now - d.getTime(), h = diff / 36e5;
  if (h < 1) return `${Math.max(1, Math.round(diff / 6e4))}m`;
  if (h < 24 && d.getDate() === new Date(now).getDate()) return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  if (h < 24 * 6) return d.toLocaleDateString([], { weekday: "short" });
  return d.toLocaleDateString([], { month: "short", day: "numeric" });
}
export function newIdempotencyKey() { return crypto.randomUUID() + crypto.randomUUID(); }
