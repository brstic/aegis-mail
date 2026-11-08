"use client";
import { Moon, Sun } from "lucide-react";
import { useEffect, useState } from "react";

const KEY = "aegis-theme";

/** "light" | "dark" sets the theme; anything else follows the system. Saved on this device, and announced so every toggle agrees. */
export function applyTheme(t: string | undefined) {
  const r = document.documentElement;
  if (t === "dark" || t === "light") r.dataset.theme = t; else delete r.dataset.theme;
  try { localStorage.setItem(KEY, t === "dark" || t === "light" ? t : "system"); } catch { /* storage may be blocked */ }
  window.dispatchEvent(new Event("aegis:theme"));
}

/** The theme chosen on this device, if one was. */
export function savedTheme(): "light" | "dark" | null {
  try { const t = localStorage.getItem(KEY); return t === "light" || t === "dark" ? t : null; } catch { return null; }
}

export function isDarkNow() {
  const t = document.documentElement.dataset.theme;
  return t === "dark" || (t !== "light" && matchMedia("(prefers-color-scheme: dark)").matches);
}

/** One button, on every page: switches between light and dark. "Follow the system" is in Settings. */
export function ThemeToggle({ className = "", onChange }: { className?: string; onChange?: (t: "light" | "dark") => void }) {
  const [dark, setDark] = useState<boolean | null>(null);
  useEffect(() => {
    const read = () => setDark(isDarkNow());
    read();
    const mq = matchMedia("(prefers-color-scheme: dark)");
    mq.addEventListener("change", read);
    window.addEventListener("aegis:theme", read);
    return () => { mq.removeEventListener("change", read); window.removeEventListener("aegis:theme", read); };
  }, []);
  const next = dark ? "light" : "dark";
  return (
    <button
      type="button"
      onClick={() => { applyTheme(next); onChange?.(next); }}
      aria-label={dark ? "Switch to light mode" : "Switch to dark mode"}
      title={dark ? "Light mode" : "Dark mode"}
      data-testid="theme-toggle"
      className={`grid size-9 shrink-0 place-items-center rounded-full transition-colors ${className}`}
    >
      {dark === null ? <span className="size-[18px]" /> : dark ? <Sun className="size-[18px]" aria-hidden /> : <Moon className="size-[18px]" aria-hidden />}
    </button>
  );
}
