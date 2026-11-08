import type { Metadata } from "next";
import { AuthFrame, safeNext } from "@/components/auth/auth-frame";
import { SignInForm } from "@/components/auth/sign-in-form";
import { ssoErrorMessage } from "@aegis/platform";

export const metadata: Metadata = { title: "Sign in" };

export default async function SignInPage({ searchParams }: { searchParams: Promise<{ next?: string | string[]; error?: string | string[]; mfa_ticket?: string | string[] }> }) {
  const { next, error, mfa_ticket } = await searchParams;
  return <AuthFrame><SignInForm next={safeNext(next)} initialError={typeof error === "string" ? ssoErrorMessage(error) : null} mfaTicket={typeof mfa_ticket === "string" ? mfa_ticket : null} /></AuthFrame>;
}
