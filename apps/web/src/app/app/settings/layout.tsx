"use client";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { SubNav } from "@/components/settings/common";

export default function SettingsLayout({ children }: { children: ReactNode }) {
  // The tabs are on every settings page, Overview included, so the title never moves when you switch between them.
  const path = usePathname();
  return (
    <div className="scroll-thin h-full overflow-auto">
      <div className="mx-auto max-w-4xl p-4 sm:p-6">
        <SubNav label="Settings sections" items={[
          { href: "/app/settings", label: "Overview", exact: true },
          { href: "/app/settings/accounts", label: "Accounts" },
          { href: "/app/settings/personalization", label: "Appearance and AI" },
          { href: "/app/settings/identity", label: "Signatures" },
          { href: "/app/settings/security", label: "Sign-in and security" },
          { href: "/app/settings/people", label: "People" },
          { href: "/app/settings/topics", label: "Topics" },
          { href: "/app/settings/search", label: "Search" },
        ]} />
        {children}
      </div>
    </div>
  );
}
