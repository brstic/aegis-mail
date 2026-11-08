import type { Metadata } from "next";
import { AuthFrame } from "@/components/auth/auth-frame";
import { InviteAccept } from "@/components/auth/invite-accept";

export const metadata: Metadata = { title: "Your invitation", robots: { index: false } };

export default async function InvitePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  return <AuthFrame><InviteAccept token={token} /></AuthFrame>;
}
