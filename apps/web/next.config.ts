import type { NextConfig } from "next";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

// The monorepo keeps one .env at the root; Next only auto-loads from this app's directory.
const rootEnv = join(process.cwd(), "../../.env");
if (existsSync(rootEnv)) for (const l of readFileSync(rootEnv, "utf8").split("\n")) { const m = l.match(/^([A-Z_0-9]+)=(.*)$/); if (m && process.env[m[1]!] === undefined) process.env[m[1]!] = m[2]; }

const config: NextConfig = {
  poweredByHeader: false,
  // Lets the E2E server build beside a running dev server.
  distDir: process.env.NEXT_DIST_DIR ?? ".next",
  reactStrictMode: true,
  transpilePackages: ["@aegis/ai-core", "@aegis/cryptography", "@aegis/db", "@aegis/domain", "@aegis/mail-adapters", "@aegis/mail-parser", "@aegis/platform", "@aegis/security-engine", "@aegis/test-fixtures"],
  serverExternalPackages: ["pg", "mailparser", "imapflow", "nodemailer", "@node-rs/argon2", "sanitize-html", "pngjs", "jsqr", "@simplewebauthn/server", "oauth4webapi", "@node-saml/node-saml"],
};
export default config;
