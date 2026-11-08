import type { Metadata } from "next";
import { DesignSystem } from "@/components/design-system/design-system";

export const metadata: Metadata = { title: "Design system", description: "The tokens, components and states Aegis Mail is built from, running live.", robots: { index: false } };

export default function DesignSystemPage() { return <DesignSystem />; }
