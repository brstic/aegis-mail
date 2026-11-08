import { redirect } from "next/navigation";
import { Suspense } from "react";
import { Shell } from "@/components/workspace/shell";
import { Providers } from "@/lib/client";
import { currentSession } from "@/server/router";

export const dynamic = "force-dynamic";
export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const s = await currentSession();
  if (!s) redirect("/sign-in");
  return <Providers><Suspense><Shell>{children}</Shell></Suspense></Providers>;
}
