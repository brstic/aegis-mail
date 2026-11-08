export type RiskLabel = "safe" | "bulk_low_priority" | "suspicious" | "high_risk" | "malicious" | "unknown_unscannable";
export type PolicyAction = "allow" | "annotate" | "warn" | "move_to_spam" | "quarantine";
export type Severity = "none" | "low" | "medium" | "high" | "critical";
export type ThreatCategory =
  | "spam" | "credential_phish" | "bec" | "invoice_fraud" | "brand_spoof" | "malware"
  | "malicious_link" | "qr_phish" | "reply_chain_hijack" | "callback_phish" | "lure_recruiting_tax_shipping"
  | "tracking" | "prompt_injection";

export interface Evidence {
  /** Stable, content-free code. Safe for telemetry. */
  code: string;
  /** log-odds contribution. Negative values are benign evidence. */
  weight: number;
  category?: ThreatCategory;
  /** User-facing plain language. May reference content; encrypted at rest. */
  explanation: string;
  /** Which subsystem produced this. */
  source: "headers" | "auth" | "url" | "content" | "attachment" | "relationship" | "llm" | "list";
  /** Hard floor: malware-class evidence that allowlists can't override. */
  hardFloor?: boolean;
}

export interface SecurityResult {
  engineVersion: string;
  threatProbability: number;
  severity: Severity;
  /** 0..1: how complete the analysis was (e.g. unscannable attachment lowers this). */
  evidenceCompleteness: number;
  label: RiskLabel;
  action: PolicyAction;
  categories: ThreatCategory[];
  evidence: Evidence[];
  /** One readable paragraph for users. */
  summary: string;
  actionRationale: string;
  /** Detector provenance, e.g. ["auth","url","clamd:unavailable"]. */
  provenance: string[];
  /** Malware scan outcome per attachment, by sha256. Absent when nothing was scanned (sent mail, no attachments). */
  scanVerdicts?: Record<string, string>;
}

export interface TenantPolicy {
  quarantineThreshold: "suspicious" | "high_risk" | "malicious";
  /** Blocked sender domains. */
  blockDomains: string[];
  /** Allowed sender domains. These can't override hardFloor evidence. */
  allowDomains: string[];
  protectedDomains: string[];
  moveBulkToSpam: boolean;
  blockRemoteImages: boolean;
  /** Who can release quarantined mail. Content owner always can unless admin-gated malware. */
  releaseRequiresApprovalForMalicious: boolean;
  /** Outbound: domains this workspace's mail may not be sent to, enforced at send time for every mailbox. */
  outboundBlockDomains: string[];
}

export const DEFAULT_POLICY: TenantPolicy = {
  quarantineThreshold: "high_risk",
  blockDomains: [],
  allowDomains: [],
  protectedDomains: [],
  moveBulkToSpam: false,
  blockRemoteImages: true,
  releaseRequiresApprovalForMalicious: true,
  outboundBlockDomains: [],
};
