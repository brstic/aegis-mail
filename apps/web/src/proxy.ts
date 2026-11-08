import { NextResponse, type NextRequest } from "next/server";
import { MARKETING_ONLY_PATHS, marketingSiteEnabled } from "@/components/marketing/site";

/** The session cookie's name, as set by src/server/router.ts. Only its presence is read here: the app checks the session itself. */
const SESSION_COOKIE = "aegis_session";

/**
 * On a self-hosted instance (AEGIS_MARKETING_SITE isn't "true"), the home page and the marketing-only pages lead into the app:
 * to /app with a session cookie, which redirects to sign-in if the session has ended, and to /sign-in without one.
 */
function instanceRedirect(req: NextRequest): URL | null {
  if (marketingSiteEnabled()) return null;
  const path = req.nextUrl.pathname;
  const marketing = path === "/" || MARKETING_ONLY_PATHS.some(p => path === p || path.startsWith(`${p}/`));
  if (!marketing) return null;
  return new URL(req.cookies.has(SESSION_COOKIE) ? "/app" : "/sign-in", req.url);
}

/**
 * Per-request CSP nonce. Scripts must carry it, so injected markup can't run even if something escapes sanitization.
 * Message HTML never reaches this document: it renders in a sandboxed srcdoc iframe with its own stricter CSP.
 */
export function proxy(req: NextRequest) {
  const nonce = btoa(crypto.randomUUID());
  const dev = process.env.NODE_ENV !== "production";
  const csp = [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${dev ? " 'unsafe-eval'" : ""}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "font-src 'self'",
    `connect-src 'self'${dev ? " ws:" : ""}`,
    "frame-src 'self' about:",
    "frame-ancestors 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "object-src 'none'",
  ].join("; ");
  const headers = new Headers(req.headers);
  headers.set("x-nonce", nonce);
  headers.set("content-security-policy", csp);
  const to = instanceRedirect(req);
  const res = to ? NextResponse.redirect(to) : NextResponse.next({ request: { headers } });
  res.headers.set("Content-Security-Policy", csp);
  res.headers.set("X-Frame-Options", "DENY");
  res.headers.set("X-Content-Type-Options", "nosniff");
  res.headers.set("Referrer-Policy", "no-referrer");
  res.headers.set("Permissions-Policy", "camera=(), microphone=(), geolocation=(), interest-cohort=()");
  if (!dev) res.headers.set("Strict-Transport-Security", "max-age=63072000; includeSubDomains; preload");
  return res;
}
export const config = { matcher: [{ source: "/((?!_next/static|_next/image|favicon.ico).*)" }] };
