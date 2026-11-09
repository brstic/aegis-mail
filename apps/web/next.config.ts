import type { NextConfig } from "next";
import { existsSync } from "node:fs";
import { join } from "node:path";

// The monorepo keeps one .env at the root; Next only auto-loads from this app's directory.
const rootEnv = join(process.cwd(), "../../.env");
// Node's own parser, the same one the worker's --env-file uses: it handles quotes, comments and Windows line endings.
if (existsSync(rootEnv)) process.loadEnvFile(rootEnv);

const config: NextConfig = {
  poweredByHeader: false,
  // Lets the E2E server build beside a running dev server.
  distDir: process.env.NEXT_DIST_DIR ?? ".next",
  reactStrictMode: true,
  transpilePackages: ["@aegis/ai-core", "@aegis/cryptography", "@aegis/db", "@aegis/domain", "@aegis/mail-adapters", "@aegis/mail-parser", "@aegis/platform", "@aegis/security-engine", "@aegis/test-fixtures"],
  serverExternalPackages: ["pg", "mailparser", "imapflow", "nodemailer", "@node-rs/argon2", "sanitize-html", "pngjs", "jsqr", "@simplewebauthn/server", "oauth4webapi", "@node-saml/node-saml"],
};
export default config;
