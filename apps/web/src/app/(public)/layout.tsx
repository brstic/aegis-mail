import { SiteFooter } from "@/components/marketing/site-footer";
import { SiteHeader } from "@/components/marketing/site-header";
import { marketingSiteEnabled } from "@/components/marketing/site";
import { connection } from "next/server";

/** Read per request, never at build time: a self-hosted instance shows only its legal pages. */
export default async function PublicLayout({ children }: { children: React.ReactNode }) {
  await connection();
  const marketing = marketingSiteEnabled();
  return (
    <div className="flex min-h-full flex-col text-base">
      <SiteHeader marketing={marketing} />
      <main id="main" tabIndex={-1} className="flex-1 outline-none">{children}</main>
      <SiteFooter marketing={marketing} />
    </div>
  );
}
