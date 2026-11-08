"use client";
import { useEffect, useState } from "react";
import { api, ApiError } from "@/lib/client";

/** Renders only when the deployment is in demo mode. */
export function DemoPanel({ onSignedIn }: { onSignedIn: () => void }) {
  const [demo, setDemo] = useState(false);
  const [busy, setBusy] = useState<"member" | "admin" | "operator" | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    let live = true;
    api<{ demoMode: boolean }>("/public/config").then(c => { if (live) setDemo(c.demoMode === true); }).catch(() => { /* No panel if config can't load. */ });
    return () => { live = false; };
  }, []);

  if (!demo) return null;

  const enter = async (as: "member" | "admin" | "operator") => {
    setBusy(as); setError("");
    try {
      await api("/demo/signin", { body: { as } });
      // The operator console is a separate area, not a view of the app.
      if (as === "operator") window.location.assign("/admin");
      else onSignedIn();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "The demo didn't start. Try again.");
      setBusy(null);
    }
  };

  const link = "font-medium text-accent hover:underline disabled:opacity-50";
  return (
    <section aria-label="Demo" className="mt-6 border-t border-line pt-6 text-center">
      <button type="button" disabled={busy !== null} onClick={() => enter("member")} className="inline-flex h-12 w-full items-center justify-center gap-2 rounded-full border border-line-strong bg-surface text-[15px] font-medium hover:bg-surface-2 disabled:opacity-50">{busy === "member" ? "Opening the demo…" : "Try the demo"}</button>
      <p className="mt-2 text-xs text-muted">
        Synthetic mail, nothing is really sent. Also try it <button type="button" className={link} disabled={busy !== null} onClick={() => enter("admin")}>{busy === "admin" ? "Opening…" : "as a workspace admin"}</button>.
      </p>
      {/* The people who run the service have their own console. It's part of the demo, kept quiet because almost nobody needs it. */}
      <p className="mt-1 text-xs text-muted">
        <button type="button" className={`inline-flex min-h-6 items-center ${link}`} disabled={busy !== null} onClick={() => enter("operator")}>{busy === "operator" ? "Opening…" : "Or see the platform operator console"}<span className="sr-only"> (demo for the people who run the service)</span></button>
      </p>
      {error && <p role="alert" className="mt-2 text-sm font-medium text-danger">{error}</p>}
    </section>
  );
}
