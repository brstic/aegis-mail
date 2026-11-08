/** Test-only. Not exported from the package. */
import { generate } from "selfsigned";
import type { HostGuard, MailProtocol, PinnedHost } from "./ssrf";

export const TEST_HOST = "mail.example.com";

let cached: { key: string; cert: string } | undefined;

/** A certificate for TEST_HOST, also used as its own trust anchor. Rejecting a wrong name is left to real TLS. */
export async function testCert(): Promise<{ key: string; cert: string }> {
  if (!cached) {
    const pems = await generate([{ name: "commonName", value: TEST_HOST }], {
      algorithm: "sha256",
      keySize: 2048,
      extensions: [
        { name: "basicConstraints", cA: true, critical: true },
        { name: "subjectAltName", altNames: [{ type: 2, value: TEST_HOST }] },
      ],
    } as never);
    cached = { key: pems.private, cert: pems.cert };
  }
  return cached;
}

/**
 * Approves the host and pins it to loopback on the server's real port, standing in for the strict
 * guard so a local server can be reached. Records every check, so tests can see what was vetted.
 */
export function loopbackGuard(serverPort: number, opts: { hostname?: string } = {}): HostGuard & { checks: Array<[string, number, MailProtocol]> } {
  const checks: Array<[string, number, MailProtocol]> = [];
  return {
    checks,
    async checkHost(host, port, { protocol }): Promise<PinnedHost> {
      checks.push([host, port, protocol]);
      const hostname = opts.hostname ?? host;
      return { ip: "127.0.0.1", family: 4, port: serverPort, hostname, servername: hostname };
    },
  };
}
