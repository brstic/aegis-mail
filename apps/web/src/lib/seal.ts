/**
 * Client-sealed mode (Mode B, experimental). Runs only in the browser using WebCrypto; the passphrase and derived key never
 * leave this page. PBKDF2 at 600k iterations matches OWASP's floor. WebCrypto has no Argon2.
 */
const b64 = (b: ArrayBuffer | Uint8Array) => btoa(String.fromCharCode(...new Uint8Array(b instanceof Uint8Array ? b : new Uint8Array(b))));
const unb64 = (s: string) => Uint8Array.from(atob(s), c => c.charCodeAt(0));
const ITER = 600_000;

async function derive(passphrase: string, salt: Uint8Array, iterations: number) {
  const base = await crypto.subtle.importKey("raw", new TextEncoder().encode(passphrase), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey({ name: "PBKDF2", hash: "SHA-256", salt: salt as BufferSource, iterations }, base, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
}

export async function sealText(text: string, passphrase: string) {
  const salt = crypto.getRandomValues(new Uint8Array(16)), iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await derive(passphrase, salt, ITER);
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv: iv as BufferSource }, key, new TextEncoder().encode(text));
  return { ciphertext: b64(ct), meta: { alg: "AES-GCM" as const, kdf: "PBKDF2-SHA256" as const, iterations: ITER, salt: b64(salt), iv: b64(iv), v: 1 as const } };
}

export async function unsealText(ciphertext: string, meta: { salt: string; iv: string; iterations: number }, passphrase: string) {
  const key = await derive(passphrase, unb64(meta.salt), meta.iterations);
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64(meta.iv) as BufferSource }, key, unb64(ciphertext) as BufferSource);
  return new TextDecoder().decode(pt);
}
