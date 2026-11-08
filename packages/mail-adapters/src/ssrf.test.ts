import { describe, expect, it, vi } from "vitest";
import { ALLOWED_PORTS, HostBlockedError, createHostGuard, type HostResolver, type MailProtocol } from "./index";

const resolverFor = (...addresses: string[]): HostResolver => async () => addresses.map((address) => ({ address }));
const PUBLIC_V4 = "93.184.216.34";
const PUBLIC_V6 = "2606:2800:220:1:248:1893:25c8:1946";

async function blocked(p: Promise<unknown>) {
  const err = await p.then(() => undefined, (e) => e);
  expect(err).toBeInstanceOf(HostBlockedError);
  return err as HostBlockedError;
}

describe("resolved addresses", () => {
  it.each([
    ["loopback", "127.0.0.1"], ["loopback top", "127.255.255.254"], ["this network", "0.0.0.0"], ["this network 2", "0.1.2.3"],
    ["10/8", "10.0.0.1"], ["172.16/12 low", "172.16.0.1"], ["172.16/12 high", "172.31.255.255"], ["192.168/16", "192.168.1.1"],
    ["link-local", "169.254.1.1"], ["AWS/GCP metadata", "169.254.169.254"], ["Azure platform", "168.63.129.16"],
    ["CGNAT low", "100.64.0.1"], ["CGNAT high / Alibaba metadata", "100.100.100.200"], ["CGNAT top", "100.127.255.255"],
    ["IETF", "192.0.0.1"], ["Oracle metadata", "192.0.0.192"], ["TEST-NET-1", "192.0.2.1"], ["benchmarking", "198.18.0.1"], ["TEST-NET-2", "198.51.100.1"],
    ["TEST-NET-3", "203.0.113.1"], ["multicast", "224.0.0.1"], ["reserved", "240.0.0.1"], ["broadcast", "255.255.255.255"],
    ["v6 unspecified", "::"], ["v6 loopback", "::1"], ["v6 loopback long", "0:0:0:0:0:0:0:1"],
    ["ULA fc", "fc00::1"], ["ULA fd", "fd12:3456::1"], ["AWS IPv6 metadata", "fd00:ec2::254"],
    ["link-local v6", "fe80::1"], ["site-local v6", "fec0::1"], ["multicast v6", "ff02::1"],
    ["documentation v6", "2001:db8::1"], ["IPv4-mapped loopback", "::ffff:127.0.0.1"], ["IPv4-mapped metadata hex", "::ffff:a9fe:a9fe"],
    ["IPv4-mapped public", "::ffff:8.8.8.8"], ["IPv4-mapped uppercase", "::FFFF:7F00:1"], ["IPv4-mapped expanded", "0:0:0:0:0:ffff:7f00:1"],
    ["IPv4-compatible", "::127.0.0.1"], ["NAT64", "64:ff9b::7f00:1"], ["6to4", "2002:7f00:1::"], ["Teredo", "2001:0:4136:e378::1"],
    ["zone id", "fe80::1%en0"], ["not an address", "not-an-ip"], ["empty", ""],
  ])("refuses %s (%s)", async (_name, address) => {
    const guard = createHostGuard({ resolver: resolverFor(address) });
    const err = await blocked(guard.checkHost("mail.example.com", 993, { protocol: "imap" }));
    expect(err.reason).toBe("reserved_address");
  });

  it.each([["v4", PUBLIC_V4], ["v6", PUBLIC_V6], ["just past 172.16/12", "172.32.0.1"], ["just past CGNAT", "100.128.0.1"], ["just below CGNAT", "100.63.255.255"]])(
    "allows public %s", async (_n, address) => {
      const guard = createHostGuard({ resolver: resolverFor(address) });
      await expect(guard.checkHost("mail.example.com", 993, { protocol: "imap" })).resolves.toMatchObject({ ip: address });
    },
  );

  it("refuses when ANY answer is private, whichever order they come in", async () => {
    for (const answers of [[PUBLIC_V4, "10.0.0.1"], ["10.0.0.1", PUBLIC_V4], [PUBLIC_V4, PUBLIC_V6, "::1"]]) {
      const guard = createHostGuard({ resolver: resolverFor(...answers) });
      await blocked(guard.checkHost("mail.example.com", 993, { protocol: "imap" }));
    }
  });

  it("refuses a host with no addresses", async () => {
    const err = await blocked(createHostGuard({ resolver: resolverFor() }).checkHost("mail.example.com", 993, { protocol: "imap" }));
    expect(err.reason).toBe("no_address");
  });

  it("keeps the DNS error code for classification but none of its text", async () => {
    const resolver: HostResolver = async () => { throw Object.assign(new Error("getaddrinfo ENOTFOUND secret.example.com"), { code: "ENOTFOUND" }); };
    const err = await createHostGuard({ resolver }).checkHost("secret.example.com", 993, { protocol: "imap" }).catch((e) => e);
    expect(err).not.toBeInstanceOf(HostBlockedError);
    expect(err.code).toBe("ENOTFOUND");
    expect(err.message).not.toContain("secret");
  });
});

describe("host forms", () => {
  const neverResolve: HostResolver = async () => { throw new Error("must not be resolved"); };
  const guard = createHostGuard({ resolver: neverResolve });

  it.each([
    ["decimal", "2130706433"], ["decimal metadata", "2852039166"], ["hex", "0x7f000001"], ["hex dotted", "0x7f.0.0.1"], ["hex dotted 2", "0x7F.0x0.0x0.0x1"],
    ["octal", "0177.0.0.1"], ["octal full", "0177.0000.0000.0001"], ["leading zero", "127.0.0.01"], ["short", "127.1"], ["short 3", "127.0.1"], ["public short", "8.8.8"],
    ["trailing dot literal", "127.0.0.1."], ["trailing dot public literal", "8.8.8.8."], ["trailing dot name", "mail.example.com."], ["trailing dots", "mail.example.com.."],
    ["fullwidth digits", "１２７.０.０.１"], ["ideographic dot", "127。0。0。1"], ["fullwidth localhost", "ｌｏｃａｌｈｏｓｔ"], ["circled digits", "①②⑦.⓪.⓪.①"],
    ["numeric tld", "mail.example.123"], ["hex tld", "mail.example.0x7f"],
    ["empty", ""], ["space", "mail example.com"], ["leading space", " mail.example.com"], ["newline", "mail.example.com\nX"], ["crlf", "mail.example.com\r\n"],
    ["url", "http://mail.example.com"], ["path", "mail.example.com/x"], ["userinfo", "user@mail.example.com"], ["port", "mail.example.com:993"], ["backslash", "mail.example.com\\x"],
    ["bracketed name", "[mail.example.com]"], ["half bracket", "[::1"], ["empty label", "mail..example.com"], ["leading hyphen", "-mail.example.com"],
    ["too long", `${"a".repeat(250)}.com`],
  ])("refuses %s", async (_name, host) => {
    await blocked(guard.checkHost(host, 993, { protocol: "imap" }));
  });

  it.each([
    ["localhost"], ["LOCALHOST"], ["foo.localhost"], ["mail.local"], ["metadata.google.internal"], ["METADATA.GOOGLE.INTERNAL"], ["foo.internal"],
    ["metadata.goog"], ["router.lan"], ["x.intranet"], ["1.0.0.127.in-addr.arpa"], ["printer.home.arpa"], ["redis"], ["postgres"], ["kubernetes"], ["x.onion"], ["x.invalid"],
  ])("refuses the reserved name %s without resolving it", async (host) => {
    const err = await blocked(guard.checkHost(host, 993, { protocol: "imap" }));
    expect(err.reason).toBe("reserved_name");
  });

  it.each([
    ["127.0.0.1"], ["10.1.2.3"], ["169.254.169.254"], ["0.0.0.0"], ["::1"], ["[::1]"], ["[::ffff:127.0.0.1]"], ["::ffff:7f00:1"], ["::ffff:8.8.8.8"], ["fd00:ec2::254"], ["[fe80::1]"], ["fe80::1%en0"],
  ])("refuses the private literal %s", async (host) => {
    await blocked(guard.checkHost(host, 993, { protocol: "imap" }));
  });

  it("allows a canonical public literal without DNS or an SNI name", async () => {
    const pinned = await guard.checkHost("8.8.8.8", 993, { protocol: "imap" });
    expect(pinned).toEqual({ ip: "8.8.8.8", family: 4, port: 993, hostname: "8.8.8.8" });
    expect(await guard.checkHost(`[${PUBLIC_V6}]`, 993, { protocol: "imap" })).toMatchObject({ ip: PUBLIC_V6, family: 6 });
  });

  it("normalizes the case and punycode of a good name", async () => {
    const g = createHostGuard({ resolver: resolverFor(PUBLIC_V4) });
    expect(await g.checkHost("MAIL.Example.COM", 993, { protocol: "imap" })).toMatchObject({ hostname: "mail.example.com", servername: "mail.example.com" });
    expect(await g.checkHost("mail.bücher.example", 993, { protocol: "imap" })).toMatchObject({ hostname: "mail.xn--bcher-kva.example" });
  });
});

describe("ports", () => {
  const guard = createHostGuard({ resolver: resolverFor(PUBLIC_V4) });

  it("matches the allowlist", () => {
    expect(ALLOWED_PORTS).toEqual({ imap: [143, 993], smtp: [25, 465, 587, 2525], pop3: [110, 995] });
  });

  it.each<[MailProtocol, number]>([
    ["imap", 143], ["imap", 993], ["smtp", 25], ["smtp", 465], ["smtp", 587], ["smtp", 2525], ["pop3", 110], ["pop3", 995],
  ])("allows %s on %i", async (protocol, port) => {
    await expect(guard.checkHost("mail.example.com", port, { protocol })).resolves.toMatchObject({ port });
  });

  it.each<[MailProtocol, number]>([
    ["imap", 22], ["imap", 80], ["imap", 443], ["imap", 587], ["imap", 995], ["imap", 6379], ["imap", 0], ["imap", 993.5], ["imap", -1], ["imap", 65536],
    ["smtp", 993], ["smtp", 143], ["smtp", 5432], ["pop3", 993], ["pop3", 25],
  ])("refuses %s on %d", async (protocol, port) => {
    const err = await blocked(guard.checkHost("mail.example.com", port, { protocol }));
    expect(err.reason).toBe("port_not_allowed");
  });

  it("refuses an unknown protocol", async () => {
    await blocked(guard.checkHost("mail.example.com", 993, { protocol: "ftp" as MailProtocol }));
  });
});

describe("DNS rebinding", () => {
  it("resolves exactly once and returns the vetted IP to connect to, with the hostname for TLS", async () => {
    const answers = [[PUBLIC_V4], ["127.0.0.1"]];
    const resolver = vi.fn<HostResolver>(async () => (answers.shift() ?? []).map((address) => ({ address })));
    const guard = createHostGuard({ resolver });
    const pinned = await guard.checkHost("rebind.example.com", 993, { protocol: "imap" });
    expect(pinned).toEqual({ ip: PUBLIC_V4, family: 4, port: 993, hostname: "rebind.example.com", servername: "rebind.example.com" });
    expect(resolver).toHaveBeenCalledOnce();
    // The attacker's later answer is only seen by a fresh check, which refuses it.
    await blocked(guard.checkHost("rebind.example.com", 993, { protocol: "imap" }));
  });

  it("prefers IPv4 from a mixed public answer", async () => {
    const guard = createHostGuard({ resolver: resolverFor(PUBLIC_V6, PUBLIC_V4) });
    expect((await guard.checkHost("mail.example.com", 993, { protocol: "imap" })).ip).toBe(PUBLIC_V4);
  });
});

describe("safe messages", () => {
  it("don't echo the host or address", async () => {
    const guard = createHostGuard({ resolver: resolverFor("10.20.30.40") });
    const err = await blocked(guard.checkHost("internal-secret.example.com", 993, { protocol: "imap" }));
    expect(err.message).not.toContain("internal-secret");
    expect(err.message).not.toContain("10.20.30.40");
  });
});
