import type { Metadata } from "next";
import { safeNext } from "@/components/auth/auth-frame";
import { SignUpForm } from "@/components/auth/sign-up-form";

export const metadata: Metadata = { title: "Create your account" };

export default async function SignUpPage({ searchParams }: { searchParams: Promise<{ next?: string | string[] }> }) {
  const { next } = await searchParams;
  return <SignUpForm next={safeNext(next)} />;
}
