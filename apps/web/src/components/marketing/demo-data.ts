/**
 * Synthetic demo content. Fictional people, `.example` domains, no real mail.
 *
 * Evidence strings, labels and rationales are what @aegis/security-engine (det-2026.11.2) produced when these
 * messages were run through `analyzeMessage`. Summaries are shortened from its output, and the "no concerns" one is
 * reworded for this page.
 * Ranking reasons use the wording in packages/platform/src/priority.ts.
 * Rerun them through the engine if the detectors change.
 */

export type EvidenceSource = "headers" | "auth" | "url" | "content" | "relationship";
export interface DemoEvidence { code: string; source: EvidenceSource; direction: "raises" | "lowers" | "note"; text: string }

export const SOURCE_LABEL: Record<EvidenceSource, string> = {
  headers: "Sender",
  auth: "Authentication",
  url: "Links",
  content: "Wording",
  relationship: "History",
};

const DMARC_PASS: DemoEvidence = { code: "AUTH_DMARC_PASS", source: "auth", direction: "lowers", text: "The sender's domain passed DMARC authentication. This confirms who owns the domain, not that they're trustworthy." };
const ESTABLISHED: DemoEvidence = { code: "REL_ESTABLISHED", source: "relationship", direction: "lowers", text: "You've exchanged several messages with this sender." };
const RECURRING: DemoEvidence = { code: "REL_RECURRING", source: "relationship", direction: "lowers", text: "You've received several messages from this sender." };
const FIRST: DemoEvidence = { code: "REL_FIRST_CONTACT", source: "relationship", direction: "raises", text: "This is the first message from this sender." };

export const NO_CONCERNS = "No concerning signals were found. That doesn't prove a message is safe, only that these checks found nothing.";
export const ALLOW_RATIONALE = "No concerning signals were found.";
const HOLD_RATIONALE = `Held for review because your policy quarantines messages rated "high risk" or higher.`;
const FLAGGED_REASON = "Security checks flagged this message, so it's held apart from your priorities.";

/* ---------- Focus inbox ---------- */

export type DemoRisk = "safe" | "suspicious" | "high_risk" | "malicious" | "bulk_low_priority";
export type DemoSection = "needs_attention" | "security_review" | "todays_commitments" | "important_people" | "low_priority";

/** Same order as the product's Focus view. */
export const SECTIONS: { key: DemoSection; label: string }[] = [
  { key: "needs_attention", label: "Needs your attention" },
  { key: "security_review", label: "Security review" },
  { key: "todays_commitments", label: "Today's commitments" },
  { key: "important_people", label: "Important people" },
  { key: "low_priority", label: "Low priority" },
];

export interface FocusMessage {
  id: string;
  section: DemoSection;
  fromName: string;
  fromAddress: string;
  account: "Work" | "Personal";
  subject: string;
  snippet: string;
  time: string;
  risk: DemoRisk;
  held?: boolean;
  reasons: string[];
  summary: string;
  rationale: string;
  evidence: DemoEvidence[];
}

export const FOCUS_MESSAGES: FocusMessage[] = [
  {
    id: "priya", section: "needs_attention", fromName: "Priya Raman", fromAddress: "priya@brightwell.example", account: "Work",
    subject: "Signed statement of work, one change on page 3",
    snippet: "Could you confirm the start date on page 3 by Thursday?",
    time: "9:12 AM", risk: "safe",
    reasons: ["You regularly correspond with this sender.", "It asks you to do something.", `It mentions a date: "Thursday".`, "It concerns business matters like contracts, budgets or decisions."],
    summary: NO_CONCERNS, rationale: ALLOW_RATIONALE, evidence: [DMARC_PASS, ESTABLISHED],
  },
  {
    id: "tomas", section: "needs_attention", fromName: "Tomas Herrera", fromAddress: "tomas@cedarbooks.example", account: "Work",
    subject: "Re: Q3 figures",
    snippet: "Can you confirm the Q3 revenue figure before I file?",
    time: "8:40 AM", risk: "safe",
    reasons: ["You regularly correspond with this sender.", "It asks you a direct question.", "You're already in this conversation and it's waiting on you."],
    summary: NO_CONCERNS, rationale: ALLOW_RATIONALE, evidence: [DMARC_PASS, ESTABLISHED],
  },
  {
    id: "tallow", section: "security_review", fromName: "Tallow Press Billing", fromAddress: "billing@tallowpress.example", account: "Work",
    subject: "Invoice 2208: new remittance details",
    snippet: "Our bank details have changed, so please use the new account below.",
    time: "8:05 AM", risk: "high_risk", held: true,
    reasons: [FLAGGED_REASON],
    summary: "It asks to change bank or payment details. Replies would go to a different domain from the sender. It pressures you to act quickly.",
    rationale: HOLD_RATIONALE,
    evidence: [
      { code: "TXT_PAYMENT_CHANGE", source: "content", direction: "raises", text: "It asks to change bank or payment details." },
      { code: "HDR_REPLYTO_MISMATCH", source: "headers", direction: "raises", text: "Replies would go to remit@ledgerhub.example, a different domain from the sender (tallowpress.example)." },
      { code: "TXT_URGENCY", source: "content", direction: "raises", text: "It pressures you to act quickly." },
      FIRST, DMARC_PASS,
    ],
  },
  {
    id: "helpdesk", section: "security_review", fromName: "IT Helpdesk", fromAddress: "helpdesk@fernhi11.example", account: "Work",
    subject: "Action required: mailbox quota exceeded",
    snippet: "Your mailbox is almost full. Validate your login details immediately.",
    time: "7:58 AM", risk: "malicious", held: true,
    reasons: [FLAGGED_REASON],
    summary: `The sender's domain "fernhi11.example" closely resembles fernhill.example, but it isn't the same domain. A link points to a raw IP address instead of a named website. It asks you to confirm a password or sign-in details.`,
    rationale: HOLD_RATIONALE,
    evidence: [
      { code: "HDR_FROM_LOOKALIKE", source: "headers", direction: "raises", text: `The sender's domain "fernhi11.example" closely resembles fernhill.example, but it isn't the same domain.` },
      { code: "URL_IP_HOST", source: "url", direction: "raises", text: "A link points to a raw IP address (198.51.100.23) instead of a named website." },
      { code: "TXT_CREDENTIAL_REQUEST", source: "content", direction: "raises", text: "It asks you to confirm a password or sign-in details." },
      { code: "TXT_PASSWORD_EXPIRY", source: "content", direction: "raises", text: "It claims a password is expiring or a mailbox is full." },
      { code: "TXT_ACCOUNT_THREAT", source: "content", direction: "raises", text: "It warns that an account will be locked or closed." },
      { code: "URL_INSECURE_LOGIN", source: "url", direction: "raises", text: "A sign-in style link on 198.51.100.23 doesn't use encryption." },
      { code: "URL_CREDENTIAL_PATH", source: "url", direction: "raises", text: "A link on 198.51.100.23 looks like a sign-in or verification page, and it isn't on the sender's domain." },
      { code: "TXT_URGENCY", source: "content", direction: "raises", text: "It pressures you to act quickly." },
      FIRST,
    ],
  },
  {
    id: "parcel", section: "security_review", fromName: "Parcel Desk", fromAddress: "notices@parcel-desk.example", account: "Personal",
    subject: "Re: your delivery",
    snippet: "Your parcel delivery failed. Pay the small redelivery fee to reschedule.",
    time: "Yesterday", risk: "suspicious",
    reasons: [FLAGGED_REASON],
    summary: "The subject looks like a reply, but it isn't part of any existing conversation. It claims a delivery problem that needs action. This is the first message from this sender.",
    rationale: "Delivered with a warning because it's below your quarantine threshold.",
    evidence: [
      { code: "THREAD_FAKE_REPLY", source: "headers", direction: "raises", text: "The subject looks like a reply, but it isn't part of any existing conversation." },
      { code: "TXT_DELIVERY_LURE", source: "content", direction: "raises", text: "It claims a delivery problem that needs action." },
      FIRST, DMARC_PASS,
    ],
  },
  {
    id: "dana", section: "todays_commitments", fromName: "Dana Whitfield", fromAddress: "dana@fernhill.example", account: "Work",
    subject: "Board pack goes out today at 4pm",
    snippet: "The budget section is final. The pack goes to the board today at 4pm.",
    time: "Yesterday", risk: "safe",
    reasons: ["You regularly correspond with this sender.", `It mentions a date: "today at 4pm".`, "It concerns business matters like contracts, budgets or decisions."],
    summary: NO_CONCERNS, rationale: ALLOW_RATIONALE, evidence: [DMARC_PASS, ESTABLISHED],
  },
  {
    id: "lena", section: "important_people", fromName: "Lena Fischer", fromAddress: "lena@willowpost.example", account: "Personal",
    subject: "Saturday plans",
    snippet: "Dinner is booked for seven. Nothing to do, just wanted you to know.",
    time: "Yesterday", risk: "safe",
    reasons: ["You marked this sender as important."],
    summary: NO_CONCERNS, rationale: ALLOW_RATIONALE, evidence: [DMARC_PASS, ESTABLISHED],
  },
  {
    id: "ledger", section: "low_priority", fromName: "The Ledger Weekly", fromAddress: "news@ledgerweekly.example", account: "Work",
    subject: "This week: small-business bookkeeping",
    snippet: "This week's reading list.",
    time: "Mon", risk: "bulk_low_priority",
    reasons: ["It's a newsletter or bulk mail."],
    summary: "This looks like routine bulk mail.", rationale: "Marked as bulk mail.",
    evidence: [
      { code: "TRK_PIXEL", source: "headers", direction: "note", text: "1 tracking pixel was blocked, so the sender can't see when you open this." },
      { code: "BULK_LIST_MAIL", source: "headers", direction: "note", text: "This looks like newsletter or bulk mail." },
      DMARC_PASS, RECURRING,
    ],
  },
];

/* ---------- Phishing detection demo ---------- */

export interface PhishSample {
  id: string;
  pick: string;
  pickDetail: string;
  fromName: string;
  fromAddress: string;
  replyTo?: string;
  to: string;
  subject: string;
  body: string[];
  /** Text a reader sees, and the real destination, when the message contains a disguised link. */
  link?: { shown: string; actual: string };
  risk: DemoRisk;
  action: string;
  rationale: string;
  summary: string;
  evidence: DemoEvidence[];
  context: string;
}

export const PHISH_SAMPLES: PhishSample[] = [
  {
    id: "invoice", pick: "Forged supplier invoice", pickDetail: "Lookalike domain, new bank details",
    fromName: "Aldgate Supplies Accounts", fromAddress: "accounts@aldgate-suppl1es.example", replyTo: "aldgate.remittance@settle-pay.example",
    to: "morgan@fernhill.example", subject: "Invoice 4471: updated bank details",
    body: [
      "Hello Morgan,",
      "Please find invoice 4471 for October attached to our account. Our bank details have changed. Please update your records and pay the new account by end of day, as the old account is being closed.",
      "Sort code 00-00-00, account 00000000.",
      "Regards,\nAccounts team, Aldgate Supplies",
    ],
    risk: "malicious", action: "Held in quarantine", rationale: HOLD_RATIONALE,
    summary: `The sender's domain "aldgate-suppl1es.example" closely resembles aldgate-supplies.example, but it isn't the same domain. It asks to change bank or payment details.`,
    context: "Assumes this mailbox already corresponds with the real aldgate-supplies.example. That history is what makes the lookalike visible. Notice that DMARC passes: attackers can authenticate a domain they own.",
    evidence: [
      { code: "HDR_FROM_LOOKALIKE", source: "headers", direction: "raises", text: `The sender's domain "aldgate-suppl1es.example" closely resembles aldgate-supplies.example, but it isn't the same domain.` },
      { code: "TXT_PAYMENT_CHANGE", source: "content", direction: "raises", text: "It asks to change bank or payment details." },
      { code: "HDR_KNOWN_NAME_NEW_DOMAIN", source: "relationship", direction: "raises", text: `"Aldgate Supplies Accounts" usually writes from aldgate-supplies.example, but this message came from aldgate-suppl1es.example.` },
      { code: "HDR_REPLYTO_MISMATCH", source: "headers", direction: "raises", text: "Replies would go to aldgate.remittance@settle-pay.example, a different domain from the sender (aldgate-suppl1es.example)." },
      FIRST, DMARC_PASS,
    ],
  },
  {
    id: "password", pick: "Fake Microsoft password expiry", pickDetail: "Disguised link, failed authentication",
    fromName: "Microsoft 365", fromAddress: "no-reply@micros0ft-security.example",
    to: "morgan@fernhill.example", subject: "Your password expires today",
    body: ["Your Microsoft 365 password expires in 2 hours. Verify your password now to keep access to your mailbox. Your account will be locked if you do not act immediately."],
    link: { shown: "https://login.microsoft.com", actual: "https://micros0ft-login.example/verify" },
    risk: "malicious", action: "Held in quarantine", rationale: HOLD_RATIONALE,
    summary: `A link points to micros0ft-login.example, which imitates Microsoft. The sender's domain closely resembles Microsoft, but it isn't the same domain. A link displays "login.microsoft.com" but really goes to micros0ft-login.example.`,
    context: "This message is fiction, written for this page, and didn't come from Microsoft. Real password notices can also be imitated well enough to pass some of these checks, so check your account by going to it directly.",
    evidence: [
      { code: "URL_LOOKALIKE", source: "url", direction: "raises", text: "A link points to micros0ft-login.example, which imitates Microsoft." },
      { code: "HDR_FROM_LOOKALIKE", source: "headers", direction: "raises", text: `The sender's domain "micros0ft-security.example" closely resembles Microsoft, but it isn't the same domain.` },
      { code: "URL_TEXT_MISMATCH", source: "url", direction: "raises", text: `A link displays "login.microsoft.com" but really goes to micros0ft-login.example.` },
      { code: "HDR_DISPLAY_BRAND_MISMATCH", source: "headers", direction: "raises", text: `The display name says "Microsoft 365", but the message came from micros0ft-security.example, not a Microsoft domain.` },
      { code: "AUTH_DMARC_FAIL", source: "auth", direction: "raises", text: "The sender's domain (micros0ft-security.example) failed DMARC, so the From address may be forged." },
      { code: "TXT_CREDENTIAL_REQUEST", source: "content", direction: "raises", text: "It asks you to confirm a password or sign-in details." },
      { code: "TXT_PASSWORD_EXPIRY", source: "content", direction: "raises", text: "It claims a password is expiring or a mailbox is full." },
      { code: "TXT_ACCOUNT_THREAT", source: "content", direction: "raises", text: "It warns that an account will be locked or closed." },
      { code: "URL_CREDENTIAL_PATH", source: "url", direction: "raises", text: "A link on micros0ft-login.example looks like a sign-in or verification page, and it isn't on the sender's domain." },
      { code: "AUTH_SPF_FAIL", source: "auth", direction: "raises", text: "The sending server isn't authorized by the sender's domain (SPF)." },
      { code: "TXT_URGENCY", source: "content", direction: "raises", text: "It pressures you to act quickly." },
      FIRST,
    ],
  },
  {
    id: "giftcards", pick: "CEO gift-card request", pickDetail: "Known name, wrong domain, no links",
    fromName: "Dana Whitfield", fromAddress: "dana.whitfield.ceo@quickmail.example",
    to: "morgan@fernhill.example", subject: "Quick favor",
    body: ["Morgan, are you at your desk? I need you to buy 8 gift cards for a client today. I am in a meeting and can't take calls. Scratch the codes and send them to me here. Keep this between us for now.", "Dana"],
    risk: "malicious", action: "Held in quarantine", rationale: HOLD_RATIONALE,
    summary: `It asks you to buy gift cards, a hallmark of scams. "Dana Whitfield" usually writes from fernhill.example, but this message came from quickmail.example. It asks for secrecy or says the sender can't be reached.`,
    context: "There are no links or attachments to inspect here. The signals come from the wording and from who usually writes under this name. A rewording that avoids these phrases could score lower, which is why the wording checks are only one layer.",
    evidence: [
      { code: "TXT_GIFT_CARDS", source: "content", direction: "raises", text: "It asks you to buy gift cards, a hallmark of scams." },
      { code: "HDR_KNOWN_NAME_NEW_DOMAIN", source: "relationship", direction: "raises", text: `"Dana Whitfield" usually writes from fernhill.example, but this message came from quickmail.example.` },
      { code: "TXT_SECRECY", source: "content", direction: "raises", text: "It asks for secrecy or says the sender can't be reached." },
      { code: "TXT_EXEC_REQUEST", source: "content", direction: "raises", text: "It opens with an unusual personal request." },
      FIRST, DMARC_PASS,
    ],
  },
  {
    id: "genuine", pick: "Genuine client email", pickDetail: "Someone you already work with",
    fromName: "Priya Raman", fromAddress: "priya@brightwell.example",
    to: "morgan@fernhill.example", subject: "Signed statement of work, one change on page 3",
    body: ["Hi Morgan,", "Thanks for the call yesterday. I have attached the signed statement of work. Could you confirm the start date on page 3 by Thursday? Everything else looks right to us.", "Priya"],
    risk: "safe", action: "Delivered normally", rationale: ALLOW_RATIONALE,
    summary: NO_CONCERNS,
    context: "A deadline and a request aren't suspicious on their own. A message like this goes to Focus, where it's ranked for attention rather than held.",
    evidence: [DMARC_PASS, ESTABLISHED],
  },
];
