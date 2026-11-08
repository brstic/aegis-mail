"use client";
import type { ReactNode } from "react";
import { ROLE_LABEL, SubNav } from "@/components/settings/common";
import { Banner } from "@/components/ui";
import { useMe } from "@/lib/client";

export default function OrgLayout({ children }: { children: ReactNode }) {
  const { data: me } = useMe();
  const kind = me?.workspaces.find(w => w.id === me.tenantId);
  return (
    <div className="scroll-thin h-full overflow-auto">
      <div className="mx-auto max-w-4xl p-4 sm:p-6">
        <SubNav label="Organization sections" items={[
          { href: "/app/org", label: "Members", exact: true },
          { href: "/app/org/blocked", label: "Blocked mail" },
          { href: "/app/org/policies", label: "Policies" },
          { href: "/app/org/domains", label: "Domains" },
          { href: "/app/org/incidents", label: "Incidents" },
          { href: "/app/org/audit", label: "Audit log" },
          { href: "/app/org/sso", label: "SSO" },
        ]} aside={me && <>{kind?.name ?? "This workspace"} · {ROLE_LABEL[me.role] ?? me.role}</>} />
        {kind?.kind === "personal" && <div className="mb-4"><Banner tone="neutral">This is a personal workspace. Team features only apply once you're in an organization workspace.</Banner></div>}
        {children}
      </div>
    </div>
  );
}
