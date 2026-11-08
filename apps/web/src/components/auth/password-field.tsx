"use client";
import { useState, type InputHTMLAttributes } from "react";

/** A password input with a Show button, so a typo can be seen before it costs a failed sign-in. */
export function PasswordInput({ className = "", ...props }: InputHTMLAttributes<HTMLInputElement>) {
  const [shown, setShown] = useState(false);
  return (
    <div className="relative">
      <input {...props} type={shown ? "text" : "password"} className={`${className} !pr-16`} />
      <button type="button" aria-pressed={shown} onClick={() => setShown(v => !v)} className="absolute inset-y-0 right-2 my-auto h-8 rounded-full px-3 text-[13px] font-medium text-accent hover:bg-surface-2">{shown ? "Hide" : "Show"}</button>
    </div>
  );
}
