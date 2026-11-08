import type { Metadata } from "next";
import { AuthFrame } from "@/components/auth/auth-frame";
import { ForgotForm } from "@/components/auth/forgot-form";

export const metadata: Metadata = { title: "Reset your password", robots: { index: false } };
export default function ForgotPasswordPage() { return <AuthFrame><ForgotForm /></AuthFrame>; }
