import type { Metadata } from "next";
import { AuthFrame } from "@/components/auth/auth-frame";
import { VerifyConfirm } from "@/components/auth/verify-confirm";

export const metadata: Metadata = { title: "Confirm your email", robots: { index: false } };
export default async function VerifyEmailPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  return <AuthFrame><VerifyConfirm token={token} /></AuthFrame>;
}
