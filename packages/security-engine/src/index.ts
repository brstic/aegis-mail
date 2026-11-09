import { DEFAULT_POLICY, type Evidence, type PolicyAction, type RiskLabel, type SecurityResult, type Severity, type TenantPolicy, type ThreatCategory } from "@aegis/domain";
import { emailDomain, type ParsedMail } from "@aegis/mail-parser";
import { analyzeAttachments, BaselineScanner, type AttachmentInput, type MalwareScanner } from "./attachments";
import type { FileBrief } from "./files";
import { authDetector, brandContentMismatch, bulkDetector, contentDetector, EMPTY_RELATIONSHIP, headerDetector, injectionDetector, relationshipDetector, senderStanding, spamDetector, trackingDetector, urlDetector, type RelationshipContext } from "./detectors";
import { registrableDomain } from "./domains";

export * from "./attachments";
export * from "./files";
export * from "./domains";
export { EMPTY_RELATIONSHIP, parseAuthResults, screenPromptInjection, senderStanding, shownHost, type InjectionScreen, type RelationshipContext, type SenderStanding } from "./detectors";

export const ENGINE_VERSION = "det-2026.11.3";
/** Prior log-odds. Most mail isn't malicious. */
const PRIOR = -2.7;

/** What the AI review sees: the message, plus a structural brief of each inspected attachment (signals and embedded code, no document text). */
export interface SemanticInput { subject: string; text: string; fromDomain: string; attachments?: FileBrief[] }

/** What the AI is shown when the detectors flag a message: the message, what each detector said, and what's known about the sender. */
export interface FlagReviewInput extends SemanticInput {
  fromName?: string;
  label: RiskLabel;
  findings: { code: string; explanation: string }[];
  /** The provider's DMARC verdict passed for the sender's domain. */
  authenticated: boolean;
  linkHosts: string[];
  priorMessages: number;
  repliedBefore: boolean;
}
/**
 * The AI's answer to a detector flag. `exception` says how far a false positive should be remembered: for the sender's
 * whole domain, for this one address, or not at all.
 */
export interface FlagReview { verdict: "threat" | "false_positive" | "unsure"; confidence: number; rationale: string; exception: "sender" | "domain" | "none" }

/**
 * The AI steps. `classify` reads every message and can only add risk. `review` runs when the detectors flag a message
 * and decides whether they were right; what it may clear is bounded by `reviewable` below.
 */
export interface SemanticClassifier {
  readonly id: string;
  classify(mail: SemanticInput): Promise<{ evidence: Evidence[] } | null>;
  review?(flag: FlagReviewInput): Promise<FlagReview | null>;
}

export interface AnalyzeOptions {
  relationship?: RelationshipContext;
  policy?: Partial<TenantPolicy>;
  scanner?: MalwareScanner;
  semantic?: SemanticClassifier;
  /** Extracted attachment text, screened for injection. */
  attachmentTexts?: string[];
}

function sigmoid(x: number) { return 1 / (1 + Math.exp(-x)); }

const SEVERITY_BY_CATEGORY: Partial<Record<ThreatCategory, Severity>> = {
  malware: "critical", invoice_fraud: "critical", bec: "high", credential_phish: "high", brand_spoof: "high",
  malicious_link: "high", qr_phish: "high", reply_chain_hijack: "high", callback_phish: "medium",
  lure_recruiting_tax_shipping: "medium", prompt_injection: "medium", spam: "low", tracking: "none",
};
const SEVERITY_ORDER: Severity[] = ["none", "low", "medium", "high", "critical"];

export function severityOf(categories: ThreatCategory[]): Severity {
  let best = 0;
  for (const c of categories) best = Math.max(best, SEVERITY_ORDER.indexOf(SEVERITY_BY_CATEGORY[c] ?? "low"));
  return SEVERITY_ORDER[best]!;
}

export function labelFor(p: number, opts: { isBulk: boolean; hardFloor: boolean; completeness: number }): RiskLabel {
  if (opts.hardFloor || p >= 0.97) return "malicious";
  if (p >= 0.8) return "high_risk";
  if (p >= 0.35) return "suspicious";
  if (opts.completeness < 0.7) return "unknown_unscannable";
  if (opts.isBulk) return "bulk_low_priority";
  return "safe";
}

/**
 * Findings no review can clear: a file that matched malware, a forged sender, a domain the policy blocks, and text
 * that tries to instruct the AI. A message that argues with its reviewer doesn't get the reviewer's benefit of the doubt.
 */
const NOT_CLEARABLE = new Set(["LIST_BLOCKED_DOMAIN", "AUTH_DMARC_FAIL", "AI_PROMPT_INJECTION", "LLM_ATTACHMENT_THREAT"]);
const REVIEW_CODES = new Set(["AI_REVIEW_CLEARED", "AI_REVIEW_CONFIRMED", "AI_REVIEW_UNSURE"]);
const clearable = (evidence: Evidence[]) => !evidence.some(e => e.weight > 0 && (e.hardFloor || e.category === "malware" || NOT_CLEARABLE.has(e.code)));
const FLAGGED_LABELS = new Set<RiskLabel>(["suspicious", "high_risk", "malicious"]);

/** Did a detector, rather than the AI's own reading, flag this message with something a review could overturn? */
export function reviewable(result: SecurityResult): boolean {
  return FLAGGED_LABELS.has(result.label) && clearable(result.evidence)
    && !result.evidence.some(e => REVIEW_CODES.has(e.code) || (e.source === "llm" && e.weight > 0))
    && result.evidence.some(e => e.weight > 0 && e.source !== "llm");
}

const RANK: Record<RiskLabel, number> = { safe: 0, bulk_low_priority: 0, unknown_unscannable: 1, suspicious: 2, high_risk: 3, malicious: 4 };

/** Deterministic: same inputs, same action. No model can influence this function except through evidence. */
export function decideAction(label: RiskLabel, policy: TenantPolicy): { action: PolicyAction; rationale: string } {
  if (RANK[label] >= RANK[policy.quarantineThreshold]) {
    return { action: "quarantine", rationale: `Held for review because your policy quarantines messages rated "${policy.quarantineThreshold.replace("_", " ")}" or higher.` };
  }
  if (label === "suspicious" || label === "high_risk") return { action: "warn", rationale: "Delivered with a warning because it's below your quarantine threshold." };
  if (label === "unknown_unscannable") return { action: "warn", rationale: "Part of this message couldn't be inspected, so it isn't rated safe." };
  if (label === "bulk_low_priority") return policy.moveBulkToSpam
    ? { action: "move_to_spam", rationale: "Moved to Spam because your policy sends bulk mail there." }
    : { action: "annotate", rationale: "Marked as bulk mail." };
  return { action: "allow", rationale: "No concerning signals were found." };
}

function summarize(ev: Evidence[], label: RiskLabel, completeness: number): string {
  const top = ev.filter(e => e.weight > 0).sort((a, b) => b.weight - a.weight).slice(0, 3).map(e => e.explanation);
  const review = ev.find(e => e.code === "AI_REVIEW_CLEARED");
  if (review && (label === "safe" || label === "bulk_low_priority")) return review.explanation;
  if (label === "safe") return completeness < 1 ? "No concerning signals were found, though analysis was partial. This isn't a guarantee." : "No concerning signals were found. This isn't a guarantee.";
  if (label === "bulk_low_priority") return "This looks like routine bulk mail.";
  if (label === "unknown_unscannable" && !top.length) return "Part of this message couldn't be inspected, so it hasn't been rated safe.";
  return top.join(" ");
}

export interface AnalysisParts { evidence: Evidence[]; provenance: string[]; completeness: number; isBulk: boolean; fromDomain: string; policy: TenantPolicy; scanVerdicts?: Record<string, string>; files?: FileBrief[] }

/** Pure combination of evidence into a result. Deterministic, and the only place a label or action is decided. */
export function finalizeAnalysis(parts: AnalysisParts): SecurityResult {
  const { policy, provenance } = parts;
  let evidence = [...parts.evidence];
  let completeness = parts.completeness;
  // Tenant lists.
  const fromReg = parts.fromDomain ? registrableDomain(parts.fromDomain) : "";
  if (fromReg && policy.blockDomains.map(registrableDomain).includes(fromReg)) {
    evidence.push({ code: "LIST_BLOCKED_DOMAIN", weight: 5, source: "list", category: "spam", explanation: `Your policy blocks mail from ${fromReg}.` });
  }
  const hardFloor = evidence.some(e => e.hardFloor);
  if (fromReg && policy.allowDomains.map(registrableDomain).includes(fromReg)) {
    // Allowlist lowers ordinary risk. It can't silence malware floors, and a failed DMARC defeats it,
    // since otherwise anyone forging an allowlisted From would inherit trust.
    const forged = evidence.some(e => e.code === "AUTH_DMARC_FAIL" || e.code === "AUTH_DMARC_FAIL_FORWARDED");
    if (!forged) evidence.push({ code: "LIST_ALLOWED_DOMAIN", weight: hardFloor ? -0.5 : -2.5, source: "list", explanation: `Your policy allows mail from ${fromReg}.` });
  }

  // Benign evidence only offsets so much when strong phishing signals exist.
  const positive = evidence.filter(e => e.weight > 0).reduce((s, e) => s + e.weight, 0);
  const negative = evidence.filter(e => e.weight < 0).reduce((s, e) => s + e.weight, 0);
  const cappedNegative = Math.max(negative, -Math.max(1.2, positive * 0.45));
  // Relationship is evidence, not trust: an established sender can't erase a payment-change request.
  const score = PRIOR + positive + cappedNegative;
  const threatProbability = Math.max(0.001, Math.min(0.999, sigmoid(score)));
  completeness = Math.max(0, Math.min(1, completeness));

  // The AI's review of a detector flag. Cleared mail is delivered. A flag the AI couldn't confirm is shown with a
  // warning rather than hidden: hiding mail takes a confirmation, or a finding no review can clear.
  const canClear = clearable(evidence);
  const cleared = canClear && evidence.some(e => e.code === "AI_REVIEW_CLEARED");
  const unconfirmed = canClear && !cleared && evidence.some(e => e.code === "AI_REVIEW_UNSURE");
  let label = labelFor(threatProbability, { isBulk: parts.isBulk, hardFloor, completeness });
  if (cleared && FLAGGED_LABELS.has(label)) label = labelFor(0, { isBulk: parts.isBulk, hardFloor: false, completeness });
  else if (unconfirmed && RANK[label] > RANK.suspicious) label = "suspicious";
  const categories = [...new Set(evidence.filter(e => e.weight > 0 && e.category).map(e => e.category!))];
  const severity = RANK[label] >= 2 ? severityOf(categories) : "none";
  const { action, rationale } = decideAction(label, policy);

  return {
    engineVersion: ENGINE_VERSION, threatProbability: cleared ? Math.min(threatProbability, 0.2) : unconfirmed ? Math.min(threatProbability, 0.79) : threatProbability,
    severity, evidenceCompleteness: completeness, label, action,
    categories, evidence: evidence.sort((a, b) => b.weight - a.weight),
    summary: summarize(evidence, label, completeness), actionRationale: rationale, provenance,
    ...(parts.scanVerdicts ? { scanVerdicts: parts.scanVerdicts } : {}),
  };
}

/** Deterministic detectors only. Everything here is safe to run on a killable thread. */
export async function collectEvidence(mail: ParsedMail, attachments: AttachmentInput[], opts: AnalyzeOptions = {}): Promise<AnalysisParts> {
  const rel = opts.relationship ?? EMPTY_RELATIONSHIP;
  const policy: TenantPolicy = { ...DEFAULT_POLICY, ...opts.policy };
  const scanner = opts.scanner ?? new BaselineScanner();
  const provenance = ["headers", "auth", "url", "content", "relationship"];
  let completeness = 1;

  const att = await analyzeAttachments(attachments, scanner);
  provenance.push(...att.provenance);
  completeness -= att.completenessPenalty;
  if (mail.limitsHit.length) { completeness -= 0.2; provenance.push("limits:" + mail.limitsHit.join(",")); }
  // Beyond this, the middle of the message isn't read. Padding shouldn't be able to earn a "safe" rating.
  if (mail.text.length > 200_000 || mail.visibleText.length > 200_000) { completeness -= 0.35; provenance.push("limits:content_window"); }

  const bulk = bulkDetector(mail);
  const standing = senderStanding(mail, rel);
  const evidence: Evidence[] = [
    ...authDetector(mail),
    ...headerDetector(mail, rel, policy.protectedDomains, standing),
    ...urlDetector(mail, rel, policy.protectedDomains, att.qrUrls, att.fileUrls, standing),
    ...contentDetector(mail),
    ...brandContentMismatch(mail),
    ...spamDetector(mail),
    ...relationshipDetector(mail, rel),
    ...att.evidence,
    ...injectionDetector(mail, opts.attachmentTexts ?? []),
    ...trackingDetector(mail),
    ...bulk.evidence,
  ];
  return { evidence, provenance, completeness, isBulk: bulk.isBulk, fromDomain: emailDomain(mail.from?.address), policy, scanVerdicts: Object.fromEntries(att.verdicts), files: att.files };
}

/**
 * The optional semantic step, kept apart because it needs network and credentials the analysis thread doesn't have.
 * Advisory: it may add bounded risk, and can't lower risk, assert a malware floor, or choose an action.
 */
/** The AI can add at most this much log-odds per finding. An attachment verdict may weigh more: it rests on decoded structure, not wording. */
const LLM_CAP: Record<string, number> = { LLM_ATTACHMENT_THREAT: 4 };

export async function applySemantic(result: SecurityResult, semantic: SemanticClassifier, mail: SemanticInput, policy: Partial<TenantPolicy>): Promise<SecurityResult> {
  const provenance = [...result.provenance];
  let completeness = result.evidenceCompleteness;
  const evidence = result.evidence.filter(e => e.code !== "LIST_ALLOWED_DOMAIN" && e.code !== "LIST_BLOCKED_DOMAIN");
  try {
    const attachments = mail.attachments?.slice(0, 10);
    const r = await semantic.classify({ subject: mail.subject, text: mail.text.slice(0, 20_000), fromDomain: mail.fromDomain, ...(attachments?.length ? { attachments } : {}) });
    if (r) { evidence.push(...r.evidence.filter(e => !REVIEW_CODES.has(e.code)).map(e => ({ ...e, source: "llm" as const, hardFloor: false, weight: Math.min(Math.max(e.weight, 0), LLM_CAP[e.code] ?? 2.5) }))); provenance.push(`llm:${semantic.id}`); }
  } catch { provenance.push(`llm:${semantic.id}:unavailable`); completeness -= 0.05; }
  return finalizeAnalysis({ evidence, provenance, completeness, isBulk: result.evidence.some(e => e.code === "BULK_LIST_MAIL"), fromDomain: mail.fromDomain, policy: { ...DEFAULT_POLICY, ...policy }, scanVerdicts: result.scanVerdicts });
}

export interface ReviewOutcome { security: SecurityResult; verdict: FlagReview["verdict"] | "unavailable"; /** How far to remember a false positive, when the AI said to. */ exception: "sender" | "domain" | null }

/**
 * Asks the AI whether the detectors were right about a flagged message. Confirmed: the flag stands, with the AI's
 * reasoning added. False positive: the message is delivered and the caller may record an exception. Unsure, or no
 * answer: nothing is cleared. The label is still decided by finalizeAnalysis, which re-checks what may be cleared.
 */
export async function applyReview(result: SecurityResult, semantic: SemanticClassifier, flag: Omit<FlagReviewInput, "label" | "findings">, policy: Partial<TenantPolicy>): Promise<ReviewOutcome> {
  if (!semantic.review || !reviewable(result)) return { security: result, verdict: "unavailable", exception: null };
  const base = result.evidence.filter(e => e.code !== "LIST_ALLOWED_DOMAIN" && e.code !== "LIST_BLOCKED_DOMAIN");
  const finish = (evidence: Evidence[], provenance: string[]) => finalizeAnalysis({ evidence, provenance, completeness: result.evidenceCompleteness, isBulk: result.evidence.some(e => e.code === "BULK_LIST_MAIL"), fromDomain: flag.fromDomain, policy: { ...DEFAULT_POLICY, ...policy }, scanVerdicts: result.scanVerdicts });
  let r: FlagReview | null;
  try {
    r = await semantic.review({ ...flag, text: flag.text.slice(0, 20_000), linkHosts: flag.linkHosts.slice(0, 20), label: result.label, findings: result.evidence.filter(e => e.weight > 0).slice(0, 12).map(e => ({ code: e.code, explanation: e.explanation.slice(0, 400) })) });
  } catch { r = null; }
  if (!r) return { security: { ...result, provenance: [...result.provenance, `review:${semantic.id}:unavailable`] }, verdict: "unavailable", exception: null };
  const confidence = Math.max(0, Math.min(1, r.confidence));
  const why = r.rationale.replace(/\s+/g, " ").trim().slice(0, 300);
  const provenance = [...result.provenance, `review:${semantic.id}`];
  if (r.verdict === "false_positive" && confidence >= 0.75) {
    const security = finish([...base, { code: "AI_REVIEW_CLEARED", weight: 0, source: "llm", explanation: `AI review checked what the detectors flagged and found ordinary mail: ${why}` }], provenance);
    return { security, verdict: "false_positive", exception: FLAGGED_LABELS.has(security.label) || r.exception === "none" ? null : r.exception };
  }
  if (r.verdict === "threat") {
    return { security: finish([...base, { code: "AI_REVIEW_CONFIRMED", weight: 2.5 * confidence, source: "llm", explanation: `AI review agreed with the detectors: ${why}` }], provenance), verdict: "threat", exception: null };
  }
  return { security: finish([...base, { code: "AI_REVIEW_UNSURE", weight: 0, source: "llm", explanation: `AI review couldn't confirm what the detectors flagged, so it's shown with a warning: ${why}` }], provenance), verdict: "unsure", exception: null };
}

/** The facts about a message that the AI review is given beside its text. */
export function reviewFacts(mail: ParsedMail, rel: RelationshipContext, files: FileBrief[] = []): Omit<FlagReviewInput, "label" | "findings"> {
  return {
    subject: mail.subject, text: mail.visibleText || mail.text, fromDomain: emailDomain(mail.from?.address), fromName: mail.from?.name?.slice(0, 200),
    authenticated: senderStanding(mail, rel).authenticated, linkHosts: [...new Set(mail.urls.map(u => u.host).filter(Boolean))],
    priorMessages: rel.senderMessageCount, repliedBefore: rel.repliedTo, ...(files.length ? { attachments: files.slice(0, 10) } : {}),
  };
}

export async function analyzeMessage(mail: ParsedMail, attachments: AttachmentInput[], opts: AnalyzeOptions = {}): Promise<SecurityResult> {
  const { security, files } = await analyzeWithFiles(mail, attachments, { ...opts, semantic: undefined });
  if (!opts.semantic) return security;
  const policy = { ...DEFAULT_POLICY, ...opts.policy };
  const read = await applySemantic(security, opts.semantic, { subject: mail.subject, text: mail.visibleText || mail.text, fromDomain: emailDomain(mail.from?.address), attachments: files }, policy);
  return (await applyReview(read, opts.semantic, reviewFacts(mail, opts.relationship ?? EMPTY_RELATIONSHIP, files), policy)).security;
}

/** The deterministic result plus the attachment briefs, which cross the thread boundary so the AI step can see them. */
export async function analyzeWithFiles(mail: ParsedMail, attachments: AttachmentInput[], opts: Omit<AnalyzeOptions, "semantic"> & { semantic?: undefined } = {}): Promise<{ security: SecurityResult; files: FileBrief[] }> {
  const parts = await collectEvidence(mail, attachments, opts);
  return { security: finalizeAnalysis(parts), files: parts.files ?? [] };
}
