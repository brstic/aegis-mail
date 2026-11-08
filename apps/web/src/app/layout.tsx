import type { Metadata, Viewport } from "next";
import { Inter } from "next/font/google";
import { headers } from "next/headers";
import "./globals.css";

// Apple devices use their system font, and this is for everyone else.
const ui = Inter({ subsets: ["latin"], variable: "--font-ui", display: "swap" });

export const metadata: Metadata = { title: { default: "Aegis Mail", template: "%s · Aegis Mail" }, description: "The smart inbox that stops threats: its AI opens every link, script and PDF before you do. For Gmail, Outlook, iCloud and IMAP. Free and open source, on your own server." };
export const viewport: Viewport = { width: "device-width", initialScale: 1, themeColor: [{ media: "(prefers-color-scheme: light)", color: "#f5f5f7" }, { media: "(prefers-color-scheme: dark)", color: "#000000" }] };

// Applies the saved theme before paint, so a dark-mode user doesn't get a white flash.
const THEME = `try{var t=localStorage.getItem('aegis-theme');if(t==='dark'||t==='light')document.documentElement.dataset.theme=t}catch(e){}`;

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const nonce = (await headers()).get("x-nonce") ?? undefined;
  return (
    <html lang="en" className={ui.variable} data-density="comfortable" suppressHydrationWarning>
      <head><script nonce={nonce} dangerouslySetInnerHTML={{ __html: THEME }} /></head>
      <body>{children}</body>
    </html>
  );
}
