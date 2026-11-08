import { notFound } from "next/navigation";
import { Suspense } from "react";
import { MailView } from "@/components/workspace/mail-view";
import { ListSkeleton } from "@/components/ui";

const VIEWS = new Set(["focus", "inbox", "important", "awaiting", "sent", "archive", "spam", "trash", "quarantine", "search", "starred"]);
export default async function Page({ params, searchParams }: { params: Promise<{ view: string }>; searchParams: Promise<{ q?: string; concepts?: string; semantic?: string }> }) {
  const { view } = await params;
  if (!VIEWS.has(view)) notFound();
  const { q, concepts, semantic } = await searchParams;
  return <Suspense fallback={<ListSkeleton />}><MailView view={view} query={q} concepts={concepts === "true"} semantic={semantic === "true"} /></Suspense>;
}
