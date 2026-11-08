import { createPlatform, kmsFromEnv, startWorker } from "@aegis/platform";

// Only with an explicit collector. Attributes are allowlisted before they ever reach a span: see telemetry.ts.
if (process.env.OTEL_EXPORTER_OTLP_ENDPOINT) {
  const { NodeTracerProvider, BatchSpanProcessor } = await import("@opentelemetry/sdk-trace-node");
  const { OTLPTraceExporter } = await import("@opentelemetry/exporter-trace-otlp-http");
  new NodeTracerProvider({ spanProcessors: [new BatchSpanProcessor(new OTLPTraceExporter())] }).register();
}

const p = createPlatform({ processRole: "worker", kms: await kmsFromEnv() });
const w = startWorker(p, { concurrency: Number(process.env.WORKER_CONCURRENCY ?? 4) });
p.log.info("worker.started", { status: p.config.demoMode ? "demo" : "live" });
// Production can't get here without one. Anywhere else, say so: a restore of this database wouldn't re-apply anything.
if (!p.deletionSink) p.log.warn("deletion_log.not_configured");
const stop = async () => { await w.stop(); await p.db.close(); process.exit(0); };
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
