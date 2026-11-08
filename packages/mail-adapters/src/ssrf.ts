import { lookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";
import { domainToASCII } from "node:url";

export type MailProtocol = "imap" | "smtp" | "pop3";

export type HostBlockReason = "invalid_host" | "reserved_name" | "reserved_address" | "port_not_allowed" | "no_address";

/** The destination was refused. The message never names the host or the addresses it resolved to. */
export class HostBlockedError extends Error {
  override name = "HostBlockedError";
  constructor(readonly reason: HostBlockReason) {
    super(`Mail server address is not allowed (${reason})`);
  }
}

/** A vetted destination. Connect to `ip`; verify TLS against `servername`; never resolve `hostname` again. */
export interface PinnedHost {
  ip: string;
  family: 4 | 6;
  port: number;
  hostname: string;
  /** Absent when the configured host is itself an IP literal, which has no SNI name. */
  servername?: string;
}

export interface HostGuard {
  checkHost(host: string, port: number, opts: { protocol: MailProtocol }): Promise<PinnedHost>;
}

export type HostResolver = (host: string) => Promise<Array<{ address: string; family?: number }>>;

export const ALLOWED_PORTS: Record<MailProtocol, readonly number[]> = {
  imap: [143, 993],
  smtp: [25, 465, 587, 2525],
  pop3: [110, 995],
};

// Separate lists: BlockList matches an IPv4 address against IPv4-mapped IPv6 rules, so a single
// list holding ::ffff:0:0/96 would block every IPv4 address.
const blockedV4 = new BlockList();
const blockedV6 = new BlockList();
for (const [net, prefix] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16], ["172.16.0.0", 12],
  ["192.0.0.0", 24], ["192.0.2.0", 24], ["192.88.99.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15],
  ["198.51.100.0", 24], ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4],
] as const) blockedV4.addSubnet(net, prefix, "ipv4");
// Azure's platform metadata/DNS address is publicly routable, so no range above covers it.
blockedV4.addAddress("168.63.129.16", "ipv4");
for (const [net, prefix] of [
  // Every prefix that embeds an IPv4 address is refused outright: unspecified/loopback/compatible,
  // IPv4-mapped, translated, NAT64, Teredo and 6to4.
  ["::", 96], ["::ffff:0:0", 96], ["::ffff:0:0:0", 96], ["64:ff9b::", 96], ["64:ff9b:1::", 48],
  ["100::", 64], ["2001::", 23], ["2001:db8::", 32], ["2002::", 16], ["3fff::", 20],
  ["fc00::", 7], ["fe80::", 10], ["fec0::", 10], ["ff00::", 8],
] as const) blockedV6.addSubnet(net, prefix, "ipv6");

// Special-use and conventionally internal names that must never be looked up.
const RESERVED_SUFFIXES = [
  "localhost", "localdomain", "local", "internal", "intranet", "lan", "home", "corp", "arpa", "invalid", "test", "onion", "goog",
];

function isBlockedAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 0 || address.includes("%")) return true;
  return family === 4 ? blockedV4.check(address, "ipv4") : blockedV6.check(address, "ipv6");
}

function pin(ip: string, port: number, hostname: string, literal: boolean): PinnedHost {
  return { ip, family: isIP(ip) as 4 | 6, port, hostname, ...(literal ? {} : { servername: hostname }) };
}

/**
 * Normalizes a configured host. Returns an IP when it is a canonical literal and a DNS name otherwise.
 * Anything a resolver or URL parser could reinterpret as an address (decimal, octal, hex, short forms,
 * fullwidth digits, trailing dots) is refused rather than normalized into something connectable.
 */
function parseHost(raw: string): { ip?: string; name?: string } {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > 253) throw new HostBlockedError("invalid_host");
  const unbracketed = /^\[.*\]$/.test(raw) ? raw.slice(1, -1) : raw;
  if (isIP(unbracketed)) return { ip: unbracketed };
  if (unbracketed !== raw) throw new HostBlockedError("invalid_host");
  if (raw.endsWith(".")) throw new HostBlockedError("invalid_host");
  // Checked on the raw string: domainToASCII silently drops tabs and newlines and accepts URL syntax.
  if (/[\x00-\x20\x7f/\\:@?#[\]%]/.test(raw)) throw new HostBlockedError("invalid_host");

  const name = domainToASCII(raw).toLowerCase();
  if (!name || isIP(name)) throw new HostBlockedError("invalid_host");
  const labels = name.split(".");
  const validLabels = labels.every((l) => /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/.test(l));
  if (!validLabels) throw new HostBlockedError("invalid_host");
  const last = labels[labels.length - 1] as string;
  // WHATWG treats a host whose last label is numeric or hex as an IPv4 address.
  if (/^\d+$/.test(last) || /^0x[0-9a-f]*$/.test(last)) throw new HostBlockedError("invalid_host");
  // A single label can only be an internal name (redis, postgres, kubernetes...).
  if (labels.length < 2) throw new HostBlockedError("reserved_name");
  if (RESERVED_SUFFIXES.includes(last)) throw new HostBlockedError("reserved_name");
  return { name };
}

const DNS_TIMEOUT_MS = 5_000;

async function defaultResolver(host: string): Promise<Array<{ address: string; family?: number }>> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(Object.assign(new Error("DNS lookup timed out"), { code: "ETIMEDOUT" })), DNS_TIMEOUT_MS);
  });
  try {
    return await Promise.race([lookup(host, { all: true, verbatim: true }), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/** The strict guard. Resolves once and refuses the host if any answer is non-public. */
export function createHostGuard(opts: { resolver?: HostResolver } = {}): HostGuard {
  const resolver = opts.resolver ?? defaultResolver;
  return {
    async checkHost(host, port, { protocol }) {
      if (!ALLOWED_PORTS[protocol]?.includes(port)) throw new HostBlockedError("port_not_allowed");
      const parsed = parseHost(host);
      if (parsed.ip) {
        if (isBlockedAddress(parsed.ip)) throw new HostBlockedError("reserved_address");
        return pin(parsed.ip, port, parsed.ip, true);
      }
      const name = parsed.name as string;
      let answers: Array<{ address: string }>;
      try {
        answers = await resolver(name);
      } catch (err) {
        // Keep the code for classification; resolver messages can repeat the host.
        const code = (err as { code?: unknown })?.code;
        throw Object.assign(new Error("DNS lookup failed"), { code: typeof code === "string" ? code : "ENOTFOUND" });
      }
      if (!Array.isArray(answers) || answers.length === 0) throw new HostBlockedError("no_address");
      if (answers.some((a) => isBlockedAddress(a.address))) throw new HostBlockedError("reserved_address");
      const chosen = answers.find((a) => isIP(a.address) === 4) ?? answers[0];
      return pin((chosen as { address: string }).address, port, name, false);
    },
  };
}

/**
 * The same address rules for HTTPS, for identity provider URLs that a tenant admin types in. Resolves once and pins, like
 * the mail guard, so a name that later rebinds to an internal address is never connected to.
 */
export async function checkHttpsHost(host: string, port: number, opts: { resolver?: HostResolver } = {}): Promise<PinnedHost> {
  if (port !== 443 && port !== 8443) throw new HostBlockedError("port_not_allowed");
  const parsed = parseHost(host);
  if (parsed.ip) {
    if (isBlockedAddress(parsed.ip)) throw new HostBlockedError("reserved_address");
    return pin(parsed.ip, port, parsed.ip, true);
  }
  const name = parsed.name as string;
  const answers = await (opts.resolver ?? defaultResolver)(name).catch(() => [] as Array<{ address: string }>);
  if (answers.length === 0) throw new HostBlockedError("no_address");
  if (answers.some((a) => isBlockedAddress(a.address))) throw new HostBlockedError("reserved_address");
  const chosen = answers.find((a) => isIP(a.address) === 4) ?? answers[0];
  return pin((chosen as { address: string }).address, port, name, false);
}
