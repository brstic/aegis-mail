import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import { inflateRawSync } from "node:zlib";
import { generate } from "selfsigned";
import { SignedXml } from "xml-crypto";

const iso = (ms: number) => new Date(Date.now() + ms).toISOString();
export const IDP = "https://idp.corp.example/entity";

export async function keypair(name: string) {
  const g = await generate([{ name: "commonName", value: name }], { algorithm: "sha256", keySize: 2048 });
  return { key: g.private, cert: g.cert };
}

export interface A { id?: string; nameId?: string; audience?: string; recipient?: string; notAfter?: number; issuer?: string; inResponseTo?: string; emailVerified?: string | null; displayName?: string; subjectInResponseTo?: string | null }
export function assertion(a: A) {
  const att = (n: string, v: string) => `<saml:Attribute Name="${n}"><saml:AttributeValue xmlns:xs="http://www.w3.org/2001/XMLSchema" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:type="xs:string">${v}</saml:AttributeValue></saml:Attribute>`;
  const attrs = [a.emailVerified === null ? "" : att("email_verified", a.emailVerified ?? "true"), a.displayName ? att("displayName", a.displayName) : ""].join("");
  const inResp = a.subjectInResponseTo === null ? "" : (a.subjectInResponseTo ?? a.inResponseTo) ? ` InResponseTo="${a.subjectInResponseTo ?? a.inResponseTo}"` : "";
  return `<saml:Assertion xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ID="${a.id ?? `_a${randomUUID()}`}" Version="2.0" IssueInstant="${iso(0)}"><saml:Issuer>${a.issuer ?? IDP}</saml:Issuer><saml:Subject><saml:NameID Format="urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress">${a.nameId ?? "alice@corp.example"}</saml:NameID><saml:SubjectConfirmation Method="urn:oasis:names:tc:SAML:2.0:cm:bearer"><saml:SubjectConfirmationData NotOnOrAfter="${iso(a.notAfter ?? 300_000)}" Recipient="${a.recipient}"${inResp}/></saml:SubjectConfirmation></saml:Subject><saml:Conditions NotBefore="${iso(-60_000)}" NotOnOrAfter="${iso(a.notAfter ?? 300_000)}"><saml:AudienceRestriction><saml:Audience>${a.audience}</saml:Audience></saml:AudienceRestriction></saml:Conditions><saml:AuthnStatement AuthnInstant="${iso(0)}" SessionIndex="s1"><saml:AuthnContext><saml:AuthnContextClassRef>urn:oasis:names:tc:SAML:2.0:ac:classes:Password</saml:AuthnContextClassRef></saml:AuthnContext></saml:AuthnStatement><saml:AttributeStatement>${attrs}</saml:AttributeStatement></saml:Assertion>`;
}
export function sign(xml: string, k: { key: string; cert: string }, alg: "sha256" | "sha1" = "sha256") {
  const ref = "//*[local-name(.)='Assertion']";
  const s = new SignedXml({ privateKey: k.key, publicCert: k.cert, signatureAlgorithm: alg === "sha1" ? "http://www.w3.org/2000/09/xmldsig#rsa-sha1" : "http://www.w3.org/2001/04/xmldsig-more#rsa-sha256", canonicalizationAlgorithm: "http://www.w3.org/2001/10/xml-exc-c14n#" });
  s.addReference({ xpath: ref, digestAlgorithm: alg === "sha1" ? "http://www.w3.org/2000/09/xmldsig#sha1" : "http://www.w3.org/2001/04/xmlenc#sha256", transforms: ["http://www.w3.org/2000/09/xmldsig#enveloped-signature", "http://www.w3.org/2001/10/xml-exc-c14n#"] });
  s.computeSignature(xml, { location: { reference: ref, action: "append" } });
  return s.getSignedXml();
}
export const response = (inner: string, r: { destination?: string; inResponseTo?: string }) => `<samlp:Response xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol" xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ID="_r${randomUUID()}" Version="2.0" IssueInstant="${iso(0)}" Destination="${r.destination}"${r.inResponseTo ? ` InResponseTo="${r.inResponseTo}"` : ""}><saml:Issuer>${IDP}</saml:Issuer><samlp:Status><samlp:StatusCode Value="urn:oasis:names:tc:SAML:2.0:status:Success"/></samlp:Status>${inner}</samlp:Response>`;
export const b64 = (s: string) => Buffer.from(s).toString("base64");

/**
 * For a real browser: a page that signs whoever was asked for and posts the response back cross-site, the way an identity
 * provider's page does. Only used against a server allowed to talk to loopback.
 */
export async function fakeSamlIdp(opts: { acs: (domain: string) => string; audience: (domain: string) => string; email: string; domain: string }) {
  const keys = await keypair("idp.browser.example");
  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const xml = inflateRawSync(Buffer.from(url.searchParams.get("SAMLRequest") ?? "", "base64")).toString();
    const requestId = /ID="([^"]+)"/.exec(xml)?.[1] ?? "";
    const acs = opts.acs(opts.domain);
    const signed = response(sign(assertion({ nameId: opts.email, audience: opts.audience(opts.domain), recipient: acs, inResponseTo: requestId }), keys), { destination: acs, inResponseTo: requestId });
    res.writeHead(200, { "content-type": "text/html" });
    res.end(`<!doctype html><title>Fake IdP</title><form id="f" method="post" action="${acs}"><input type="hidden" name="SAMLResponse" value="${b64(signed)}"></form><script>document.getElementById("f").submit()</script>`);
  });
  await new Promise<void>(r => server.listen(0, "127.0.0.1", () => r()));
  return { keys, entryPoint: `http://127.0.0.1:${(server.address() as { port: number }).port}/sso`, close: () => new Promise<void>(r => { server.closeAllConnections(); server.close(() => r()); }) };
}
