import { trace, SpanStatusCode, type Span } from "@opentelemetry/api";
import type { Db } from "@aegis/db";
import { scrub } from "./log";

/**
 * Traces without content. Span attributes go through the same allowlist as logs, so an instrumented call site can't leak a
 * subject or token. With no SDK registered these calls are no-ops. Set OTEL_EXPORTER_OTLP_ENDPOINT in the worker to export.
 */
const tracer = trace.getTracer("aegis");

export async function traced<T>(name: string, attrs: Record<string, unknown>, fn: (s: Span) => Promise<T>): Promise<T> {
  return tracer.startActiveSpan(name, async span => {
    for (const [k, v] of Object.entries(scrub(attrs))) if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") span.setAttribute(k, v);
    try {
      return await fn(span);
    } catch (e) {
      // The name only. Exception messages can embed tokens or mail content, so recordException isn't used.
      span.setStatus({ code: SpanStatusCode.ERROR, message: e instanceof Error ? e.name : "error" });
      throw e;
    } finally {
      span.end();
    }
  });
}

/** Queue and sync health for scraping. Counts by kind and state: IDs and error codes only, no tenant names. */
export async function metricsText(db: Db): Promise<string> {
  const rows = await db.withSystem(t => t.query<any>("SELECT kind, state, count(*)::int c FROM jobs WHERE state IN ('queued','running','dead') GROUP BY kind, state"));
  const age = await db.withSystem(t => t.one<any>("SELECT COALESCE(extract(epoch FROM now() - min(run_at)),0)::int a FROM jobs WHERE state='queued' AND run_at <= now()"));
  const safe = (s: string) => s.replace(/[^a-z_.]/g, "");
  return [
    "# TYPE aegis_jobs gauge",
    ...rows.map((r: any) => `aegis_jobs{kind="${safe(r.kind)}",state="${safe(r.state)}"} ${r.c}`),
    "# TYPE aegis_queue_oldest_seconds gauge",
    `aegis_queue_oldest_seconds ${age?.a ?? 0}`,
    "",
  ].join("\n");
}
