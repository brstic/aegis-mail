"use client";
import { useEffect, useState } from "react";
import { AuthShield } from "@/film/mini/hosts";

/** The shield reacts to the form: it pulses while signing in. The form announces that with an event, so the two stay separate. */
export function AuthShieldSlot() {
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    const on = (e: Event) => setBusy((e as CustomEvent<boolean>).detail);
    window.addEventListener("aegis:auth-busy", on);
    return () => window.removeEventListener("aegis:auth-busy", on);
  }, []);
  return <AuthShield busy={busy} className="absolute inset-0" />;
}
