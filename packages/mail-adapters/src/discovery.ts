export interface ServerSuggestion { host: string; port: number; security: "tls" | "starttls" }

export interface SettingsSuggestion {
  /** Always true. Suggestions are never used without the user confirming them. */
  requiresUserConfirmation: true;
  /** True for a built-in preset, false for a name guessed from the domain or no suggestion at all. */
  confirmed: boolean;
  useOAuth?: "gmail" | "microsoft";
  /** Set when no supported connection path exists. Stated plainly rather than guessing a host that can't work. */
  unsupported?: boolean;
  provider?: "icloud" | "yahoo" | "fastmail" | "zoho";
  imap?: ServerSuggestion;
  smtp?: ServerSuggestion;
  /** IMAP login names to try, in order. */
  usernames?: string[];
  guidance: string;
}

const APP_PASSWORD_GUIDANCE =
  "Use an app password from your mail provider's security settings, not your account password. Check these settings before saving.";
const OAUTH_GUIDANCE = "Sign in with your provider instead of entering a password.";

const PROTON_GUIDANCE = "Proton Mail doesn't offer standard IMAP. Proton Mail Bridge exposes it only on your own computer, which a hosted service can't reach, so this connection isn't supported.";

type Preset = Pick<SettingsSuggestion, "provider" | "useOAuth" | "imap" | "smtp" | "guidance" | "unsupported">;

const ICLOUD: Preset = {
  provider: "icloud",
  imap: { host: "imap.mail.me.com", port: 993, security: "tls" },
  smtp: { host: "smtp.mail.me.com", port: 587, security: "starttls" },
  guidance:
    "iCloud requires an app-specific password, created at account.apple.com under Sign-In and Security. Check these settings before saving.",
};
const YAHOO: Preset = {
  provider: "yahoo",
  imap: { host: "imap.mail.yahoo.com", port: 993, security: "tls" },
  smtp: { host: "smtp.mail.yahoo.com", port: 465, security: "tls" },
  guidance: APP_PASSWORD_GUIDANCE,
};
const FASTMAIL: Preset = {
  provider: "fastmail",
  imap: { host: "imap.fastmail.com", port: 993, security: "tls" },
  smtp: { host: "smtp.fastmail.com", port: 465, security: "tls" },
  guidance: `${APP_PASSWORD_GUIDANCE} IMAP access depends on your Fastmail plan.`,
};
const ZOHO: Preset = {
  provider: "zoho",
  imap: { host: "imap.zoho.com", port: 993, security: "tls" },
  smtp: { host: "smtp.zoho.com", port: 465, security: "tls" },
  guidance: APP_PASSWORD_GUIDANCE,
};

const PRESETS: Record<string, Preset> = {
  "icloud.com": ICLOUD, "me.com": ICLOUD, "mac.com": ICLOUD,
  "yahoo.com": YAHOO,
  "fastmail.com": FASTMAIL,
  "zoho.com": ZOHO,
  "proton.me": { unsupported: true, guidance: PROTON_GUIDANCE },
  "protonmail.com": { unsupported: true, guidance: PROTON_GUIDANCE },
  "pm.me": { unsupported: true, guidance: PROTON_GUIDANCE },
  "gmail.com": { useOAuth: "gmail", guidance: OAUTH_GUIDANCE },
  "googlemail.com": { useOAuth: "gmail", guidance: OAUTH_GUIDANCE },
  "outlook.com": { useOAuth: "microsoft", guidance: OAUTH_GUIDANCE },
  "hotmail.com": { useOAuth: "microsoft", guidance: OAUTH_GUIDANCE },
  "live.com": { useOAuth: "microsoft", guidance: OAUTH_GUIDANCE },
};

const DOMAIN = /^(?=.{1,253}$)[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/;

/**
 * Built-in lookup only. Never touches the network: autodiscover and autoconfig XML from a domain an
 * attacker can own would let that attacker choose which server receives the user's password.
 */
export function suggestSettings(email: string): SettingsSuggestion {
  const at = email.lastIndexOf("@");
  const domain = at >= 0 ? email.slice(at + 1).trim().toLowerCase() : "";
  const local = at >= 0 ? email.slice(0, at).trim() : "";

  const preset = Object.hasOwn(PRESETS, domain) ? PRESETS[domain] : undefined;
  if (preset) {
    const usernames = preset.provider === "icloud" ? [local, `${local}@${domain}`] : preset.imap ? [`${local}@${domain}`] : undefined;
    return { requiresUserConfirmation: true, confirmed: true, ...preset, ...(usernames ? { usernames } : {}) };
  }
  // The numeric check stops an address like a@127.0.0.1 from becoming a suggested server name.
  if (!DOMAIN.test(domain) || /^[\d.]+$/.test(domain)) {
    return { requiresUserConfirmation: true, confirmed: false, guidance: "Enter your mail server settings from your provider's help pages." };
  }
  return {
    requiresUserConfirmation: true,
    confirmed: false,
    imap: { host: `imap.${domain}`, port: 993, security: "tls" },
    smtp: { host: `smtp.${domain}`, port: 587, security: "starttls" },
    usernames: [`${local}@${domain}`],
    guidance: `These server names are a guess based on your address. Check them with your provider. ${APP_PASSWORD_GUIDANCE}`,
  };
}
