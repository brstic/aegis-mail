import { operatorGate } from "@aegis/platform";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { AdminShell } from "@/components/admin/shell";
import { Providers } from "@/lib/client";
import { platform } from "@/server/platform";
import { currentSession } from "@/server/router";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: { default: "Operator console", template: "%s · Operator console" }, robots: { index: false, follow: false } };

/**
 * The first check. Anyone who isn't an operator gets the ordinary 404. Every API route under /operator checks again on its own, and
 * every database function behind those routes checks a third time, so nothing here depends on this layout having run.
 */
export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const gate = await operatorGate(platform(), await currentSession());
  if (gate.state === "none") notFound();
  return <Providers><AdminShell needsMfa={gate.state === "needs_mfa"} demo={platform().config.demoMode}>{children}</AdminShell></Providers>;
}
