/**
 * Structured, content-free logging. Only allowlisted fields are ever emitted, so a careless call site can't leak
 * subjects, bodies, tokens or prompts. Anything else is dropped and counted.
 */
const ALLOWED = new Set(["event", "level", "at", "traceId", "tenantId", "accountId", "messageId", "threadId", "jobId", "jobKind", "attempt", "errorCode", "errorName", "latencyMs", "count", "provider", "status", "route", "droppedFields", "chainSeq", "chainHash"]);

export type LogFields = Record<string, unknown>;
export interface Logger { info(event: string, fields?: LogFields): void; warn(event: string, fields?: LogFields): void; error(event: string, fields?: LogFields): void }

export function scrub(fields: LogFields): LogFields {
  const out: LogFields = {};
  let dropped = 0;
  for (const [k, v] of Object.entries(fields)) {
    if (ALLOWED.has(k) && (typeof v === "string" || typeof v === "number" || typeof v === "boolean" || v == null)) {
      // Long strings in allowed fields are suspicious: IDs and codes are short.
      out[k] = typeof v === "string" ? v.slice(0, 128) : v;
    } else dropped++;
  }
  if (dropped) out.droppedFields = dropped;
  return out;
}

export function makeLogger(sink: (line: string) => void = l => process.stdout.write(`${l}\n`)): Logger {
  const emit = (level: string, event: string, fields: LogFields = {}) => sink(JSON.stringify({ at: new Date().toISOString(), level, event, ...scrub(fields) }));
  return { info: (e, f) => emit("info", e, f), warn: (e, f) => emit("warn", e, f), error: (e, f) => emit("error", e, f) };
}

/** Error names and our own coded messages only. Provider errors can embed tokens or bodies. */
export function errorCode(e: unknown): string {
  // Mail adapters classify what went wrong (auth_failed, timeout, tls_failed...) and carry it as `problem`.
  if (e && typeof e === "object" && "problem" in e && typeof (e as { problem: unknown }).problem === "string") return (e as { problem: string }).problem.slice(0, 64);
  if (e && typeof e === "object" && "code" in e && typeof (e as { code: unknown }).code === "string") return (e as { code: string }).code.slice(0, 64);
  if (e instanceof Error) return e.name.slice(0, 64);
  return "unknown";
}
