"use client";
import Link from "next/link";
import { useState } from "react";
import { Button } from "@/components/ui";
import { api, ApiError } from "@/lib/client";
import { AuthTitle } from "./auth-frame";

/** Needs a click: mail scanners fetch links, and fetching one mustn't verify an address or spend the link. */
export function VerifyConfirm({ token }: { token: string }) {
  const [state, setState] = useState<"ready" | "busy" | "done" | "dead">("ready");
  const [error, setError] = useState("");
  const confirm = async () => {
    setState("busy"); setError("");
    try { await api("/auth/verify/confirm", { body: { token } }); setState("done"); }
    catch (err) {
      if (err instanceof ApiError && err.code === "token_invalid") setState("dead");
      else { setState("ready"); setError(err instanceof ApiError ? err.message : "Something went wrong. Try again."); }
    }
  };
  if (state === "done") return (
    <>
      <AuthTitle title="Email confirmed"><p>Your address is verified. You can now accept invitations sent to it.</p></AuthTitle>
      <Link href="/app" className="inline-flex h-11 w-full items-center justify-center rounded-lg bg-accent px-4 font-medium text-on-accent transition-colors hover:bg-accent-hover">Go to the app</Link>
    </>
  );
  if (state === "dead") return (
    <>
      <AuthTitle title="This link isn't valid anymore"><p>It may have expired or already been used. Sign in and use the banner at the top of the app to send a new one.</p></AuthTitle>
      <Link href="/app" className="font-medium text-accent underline underline-offset-2">Go to the app</Link>
    </>
  );
  return (
    <>
      <AuthTitle title="Confirm your email"><p>Only confirm if you created this account. If you didn&apos;t, close this page and nothing will change.</p></AuthTitle>
      {error && <p role="alert" className="mb-3 text-sm font-medium text-danger">{error}</p>}
      <Button variant="primary" className="!h-12 w-full !rounded-full !text-[15px]" loading={state === "busy"} onClick={confirm}>Confirm my email</Button>
    </>
  );
}
