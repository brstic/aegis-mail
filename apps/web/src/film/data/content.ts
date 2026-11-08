import evidence from "./evidence.json";

/** What's shown in the film and isn't a line of copy. Findings come from evidence.json, which is the real engine's output. */
export const EVIDENCE = evidence;
export type Sample = (typeof evidence.samples)[number];

const invoice = evidence.samples.find(s => s.id === "invoice")!;
const found = (...codes: string[]) => codes.map(c => invoice.evidence.find(e => e.code === c)!).filter(Boolean);

/** The letter's layers, top to bottom, as the forged invoice comes apart. `ask` is what's checked, `found` is what the engine said here. */
export const LAYERS = [
  {
    id: "sender", title: "Sender", short: "Who it says it's from",
    print: ["From   Aldgate Supplies Accounts", "       accounts@aldgate-suppl1es.example", "Reply  aldgate.remittance@settle-pay.example"],
    ask: "Does the domain imitate one you know? Do the name and Reply-To agree with it?",
    found: found("HDR_FROM_LOOKALIKE", "HDR_REPLYTO_MISMATCH"),
  },
  {
    id: "auth", title: "Authentication", short: "SPF, DKIM, DMARC",
    print: ["SPF     pass", "DKIM    pass", "DMARC   pass"],
    ask: "Do the server and signature line up with the From domain? A pass counts for little, because attackers can authenticate their own lookalikes.",
    found: found("AUTH_DMARC_PASS"),
  },
  {
    id: "wording", title: "Wording", short: "What it asks you to do",
    print: ["Our bank details have changed.", "Please update your records and pay the", "new account by end of day.", "Sort code 00-00-00, account 00000000"],
    ask: "Does it ask you to change payment details, give up a password, or act right now?",
    found: found("TXT_PAYMENT_CHANGE", "TXT_BANK_DETAILS_GIVEN"),
  },
  {
    id: "links", title: "Links", short: "Where they really go",
    print: ["Shown      what the link says", "Actual     where it really goes", "This one has no links."],
    ask: "Does a link go where it says it does? Links always open through a click-through page.",
    found: [],
  },
  {
    id: "files", title: "Attachments", short: "What's inside the files",
    print: ["Real type vs. the name on it", "Known malware signatures", "PDF scripts, macros, web pages", "This one has no files."],
    ask: "Is it a program in disguise, or a document carrying a script? Every PDF, Office file, web page and script is unpacked and read before you can open it.",
    found: [],
  },
  {
    id: "history", title: "History", short: "Who you already know",
    print: ["This name usually writes from", "aldgate-supplies.example", "First message from this address"],
    ask: "Does a name you know usually write from somewhere else? This is the layer a lookalike can't fake, because it's your own mail.",
    found: found("HDR_KNOWN_NAME_NEW_DOMAIN", "REL_FIRST_CONTACT"),
  },
] as const;
export type LayerId = (typeof LAYERS)[number]["id"];

/** Short names for the weights on the scale. Anything not listed falls back to its code. */
export const WEIGHT_NAMES: Record<string, string> = {
  HDR_FROM_LOOKALIKE: "Lookalike domain", TXT_PAYMENT_CHANGE: "Payment change", HDR_KNOWN_NAME_NEW_DOMAIN: "Known name, new domain", TXT_BANK_DETAILS_GIVEN: "Bank details", HDR_REPLYTO_MISMATCH: "Reply-To differs",
  REL_FIRST_CONTACT: "First contact", AUTH_DMARC_PASS: "DMARC pass", URL_LOOKALIKE: "Lookalike link", URL_TEXT_MISMATCH: "Link text lies", HDR_DISPLAY_BRAND_MISMATCH: "Brand name mismatch",
  AUTH_DMARC_FAIL: "DMARC fail", TXT_CREDENTIAL_REQUEST: "Asks for password", TXT_PASSWORD_EXPIRY: "Password expiry", TXT_ACCOUNT_THREAT: "Account threat", URL_CREDENTIAL_PATH: "Sign-in page", AUTH_SPF_FAIL: "SPF fail",
  TXT_URGENCY: "Urgency", TXT_GIFT_CARDS: "Gift cards", TXT_SECRECY: "Secrecy", TXT_EXEC_REQUEST: "Unusual request", REL_ESTABLISHED: "You know them",
};

export const RISK_LABEL: Record<string, string> = { safe: "No concerns found", suspicious: "Suspicious", high_risk: "High risk", malicious: "Malicious" };
export const ACTION_LABEL: Record<string, string> = { allow: "Delivered normally", warn: "Delivered with a warning", quarantine: "Held in quarantine" };

/** The stages of the X-ray chapter. The findings shown at the end are the real engine's, from evidence.json. */
export const XRAY_STAGES = [
  { id: "file", title: "The file", body: "An invoice from a supplier you know, signed and authenticated. Nothing about it looks wrong." },
  { id: "objects", title: "Its objects", body: "Under the page, the file is a set of objects. One of them runs a script the moment the file opens." },
  { id: "streams", title: "Decoded", body: "The script was packed into a compressed stream, where a quick scan can't read it. It's unpacked and read in full." },
  { id: "verdict", title: "Verdict", body: "" },
] as const;
export type XrayStage = (typeof XRAY_STAGES)[number]["id"];
