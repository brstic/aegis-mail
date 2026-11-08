import { DEFAULT_POLICY, type Evidence, type PolicyAction, type RiskLabel, type SecurityResult, type Severity, type TenantPolicy, type ThreatCategory } from "@aegis/domain";
import { emailDomain, type ParsedMail } from "@aegis/mail-parser";
import { analyzeAttachments, BaselineScanner, type AttachmentInput, type MalwareScanner } from "./attachments";
import type { FileBrief } from "./files";
import { authDetector, brandContentMismatch, bulkDetector, contentDetector, EMPTY_RELATIONSHIP, headerDetector, injectionDetector, relationshipDetector, spamDetector, trackingDetector, urlDetector, type RelationshipContext } from "./detectors";
import { registrableDomain } from "./domains";

export * from "./attachments";
export * from "./files";
export * from "./domains";
export { EMPTY_RELATIONSHIP, parseAuthResults, screenPromptInjection, type InjectionScreen, type RelationshipContext } from "./detectors";

export const ENGINE_VERSION = "det-2026.11.2";
/** Prior log-odds. Most mail isn't malicious. */
const PRIOR = -2.7;

/** What the AI review sees: the message, plus a structural brief of each inspected attachment (signals and embedded code, no document text). */
export interface SemanticInput { subject: string; text: string; fromDomain: string; attachments?: FileBrief[] }

/** Optional semantic step. Advisory: can raise risk through evidence, never lower it or pick an action. */
export interface SemanticClassifier {
  readonly id: string;
  classify(mail: SemanticInput): Promise<{ evidence: Evidence[] } | null>;
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

  const label = labelFor(threatProbability, { isBulk: parts.isBulk, hardFloor, completeness });
  const categories = [...new Set(evidence.filter(e => e.weight > 0 && e.category).map(e => e.category!))];
  const severity = RANK[label] >= 2 ? severityOf(categories) : "none";
  const { action, rationale } = decideAction(label, policy);

  return {
    engineVersion: ENGINE_VERSION, threatProbability, severity, evidenceCompleteness: completeness, label, action,
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
  const evidence: Evidence[] = [
    ...authDetector(mail),
    ...headerDetector(mail, rel, policy.protectedDomains),
    ...urlDetector(mail, rel, policy.protectedDomains, att.qrUrls, att.fileUrls),
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
    if (r) { evidence.push(...r.evidence.map(e => ({ ...e, source: "llm" as const, hardFloor: false, weight: Math.min(Math.max(e.weight, 0), LLM_CAP[e.code] ?? 2.5) }))); provenance.push(`llm:${semantic.id}`); }
  } catch { provenance.push(`llm:${semantic.id}:unavailable`); completeness -= 0.05; }
  return finalizeAnalysis({ evidence, provenance, completeness, isBulk: result.evidence.some(e => e.code === "BULK_LIST_MAIL"), fromDomain: mail.fromDomain, policy: { ...DEFAULT_POLICY, ...policy }, scanVerdicts: result.scanVerdicts });
}

export async function analyzeMessage(mail: ParsedMail, attachments: AttachmentInput[], opts: AnalyzeOptions = {}): Promise<SecurityResult> {
  const { security, files } = await analyzeWithFiles(mail, attachments, { ...opts, semantic: undefined });
  if (!opts.semantic) return security;
  return applySemantic(security, opts.semantic, { subject: mail.subject, text: mail.visibleText || mail.text, fromDomain: emailDomain(mail.from?.address), attachments: files }, { ...DEFAULT_POLICY, ...opts.policy });
}

/** The deterministic result plus the attachment briefs, which cross the thread boundary so the AI step can see them. */
export async function analyzeWithFiles(mail: ParsedMail, attachments: AttachmentInput[], opts: Omit<AnalyzeOptions, "semantic"> & { semantic?: undefined } = {}): Promise<{ security: SecurityResult; files: FileBrief[] }> {
  const parts = await collectEvidence(mail, attachments, opts);
  return { security: finalizeAnalysis(parts), files: parts.files ?? [] };
}
