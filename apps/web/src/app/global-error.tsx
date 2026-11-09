"use client"; // Error boundaries must be Client Components
import { useEffect } from "react";

/** The last resort, for a failure in the root layout itself. It replaces the whole document, so it carries its own styles. */
export default function GlobalError({ error, retry }: { error: unknown; retry: () => void }) {
  useEffect(() => { console.error(error); }, [error]);
  return (
    <html lang="en">
      <body style={{ margin: 0, minHeight: "100vh", display: "grid", placeItems: "center", fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif", background: "Canvas", color: "CanvasText", colorScheme: "light dark" }}>
        <title>Something went wrong · Aegis Mail</title>
        <main style={{ maxWidth: 420, padding: 24, textAlign: "center" }}>
          <h1 style={{ fontSize: 20, fontWeight: 600, margin: "0 0 8px" }}>Aegis Mail didn&apos;t load</h1>
          <p style={{ fontSize: 15, lineHeight: 1.5, opacity: 0.75, margin: "0 0 20px" }}>Something went wrong on this page. Your mail and settings aren&apos;t affected.</p>
          <button onClick={() => retry()} style={{ font: "inherit", fontSize: 15, padding: "8px 16px", borderRadius: 10, border: "1px solid GrayText", background: "transparent", color: "inherit", cursor: "pointer" }}>Try again</button>
        </main>
      </body>
    </html>
  );
}
