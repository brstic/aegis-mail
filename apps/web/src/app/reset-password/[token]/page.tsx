import type { Metadata } from "next";
import { AuthFrame } from "@/components/auth/auth-frame";
import { ResetForm } from "@/components/auth/reset-form";

export const metadata: Metadata = { title: "Choose a new password", robots: { index: false } };
export default async function ResetPasswordPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  return <AuthFrame><ResetForm token={token} /></AuthFrame>;
}
