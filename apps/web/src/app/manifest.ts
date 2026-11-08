import type { MetadataRoute } from "next";

/** Installable as an app from the browser. There's no offline mail cache or service worker: it needs a connection. */
export default function manifest(): MetadataRoute.Manifest {
  return { name: "Aegis Mail", short_name: "Aegis", description: "One workspace for all your mailboxes.", start_url: "/app", display: "standalone", background_color: "#f6f4ef", theme_color: "#1f5f4f", icons: [{ src: "/icon.svg", sizes: "any", type: "image/svg+xml" }] };
}
