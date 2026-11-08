import { redirect } from "next/navigation";
import { getPrefs, type Ctx } from "@aegis/platform";
import { platform } from "@/server/platform";
import { currentSession } from "@/server/router";

export default async function AppHome() {
  const s = await currentSession();
  if (!s) redirect("/sign-in");
  const ctx: Ctx = { tenantId: s.tenantId, userId: s.userId };
  const prefs = await getPrefs(platform(), ctx);
  redirect(prefs.aiEnabled !== false && prefs.defaultView === "focus" ? "/app/focus" : "/app/inbox");
}
