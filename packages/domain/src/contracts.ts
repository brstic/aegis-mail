import { z } from "zod";

/** Typed API contracts. docs/openapi.json is generated from the mounted routes that use these (pnpm openapi). */
export const Uuid = z.string().uuid();
export const Cursor = z.string().max(256).optional();

export const SignUpBody = z.object({
  email: z.string().email().max(254),
  password: z.string().min(12).max(256),
  name: z.string().min(1).max(100),
  workspaceKind: z.enum(["personal", "organization"]).default("personal"),
  workspaceName: z.string().min(1).max(100).optional(),
});
export const SignInBody = z.object({
  email: z.string().email().max(254),
  password: z.string().min(1).max(256),
  totp: z.string().regex(/^(\d{6}|[A-Za-z2-7]{5}-[A-Za-z2-7]{5}-[A-Za-z2-7]{5})$/).optional(),
});
export const ThreadListQuery = z.object({
  view: z.enum(["inbox", "focus", "important", "awaiting", "sent", "drafts", "archive", "spam", "trash", "quarantine", "scheduled", "starred"]).default("inbox"),
  accountId: Uuid.optional(),
  labelId: Uuid.optional(),
  q: z.string().max(500).optional(),
  concepts: z.enum(["true", "false"]).optional().transform(v => v === "true"),
  semantic: z.enum(["true", "false"]).optional().transform(v => v === "true"),
  cursor: Cursor,
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
export const ThreadAction = z.object({
  action: z.enum(["archive", "trash", "spam", "not_spam", "inbox", "read", "unread", "star", "unstar", "label", "unlabel"]),
  labelId: Uuid.optional(),
});
export const DraftUpsert = z.object({
  accountId: Uuid,
  threadId: Uuid.optional(),
  to: z.array(z.string().email()).max(100),
  cc: z.array(z.string().email()).max(100).default([]),
  bcc: z.array(z.string().email()).max(100).default([]),
  subject: z.string().max(998),
  text: z.string().max(200_000),
  aiGenerated: z.boolean().default(false),
  /** An alias the mailbox owner listed for this account. Refused at send time if it isn't listed. */
  fromAlias: z.string().email().optional(),
});
export const DraftAttachmentBody = z.object({
  filename: z.string().min(1).max(200),
  contentType: z.string().max(127).regex(/^[\w.+-]+\/[\w.+-]+$/).optional(),
  /** Base64. The total per draft is capped in the service, low enough for every provider's send limit. */
  dataBase64: z.string().min(1).max(4_500_000),
});
export const SendDraftBody = z.object({
  /** The identity the UI displayed. Rejected unless it matches the draft's account. */
  expectedFrom: z.string().email(),
  idempotencyKey: z.string().min(16).max(128),
  scheduledFor: z.string().datetime().optional(),
  /** Set when the user acknowledged a risk warning on the thread being replied to. */
  acknowledgedRisk: z.boolean().default(false),
});
export const ImapConnectBody = z.object({
  displayName: z.string().min(1).max(100),
  email: z.string().email(),
  username: z.string().min(1).max(254),
  password: z.string().min(1).max(1024),
  imapHost: z.string().min(1).max(253),
  imapPort: z.number().int(),
  imapSecurity: z.enum(["tls", "starttls"]),
  smtpHost: z.string().min(1).max(253).optional(),
  smtpPort: z.number().int().optional(),
  smtpSecurity: z.enum(["tls", "starttls"]).optional(),
  readOnly: z.boolean().default(false),
  kind: z.enum(["imap", "pop3"]).default("imap"),
});
export const FeedbackBody = z.object({
  kind: z.enum(["important", "not_important", "not_a_threat", "report_phishing"]),
});
export const QuarantineDecision = z.object({ decision: z.enum(["release", "delete"]), note: z.string().max(500).optional() });
export const RuleBody = z.object({
  name: z.string().min(1).max(100),
  definition: z.unknown(),
  enabled: z.boolean().default(false),
});
export const PreferencesBody = z.object({
  defaultView: z.enum(["focus", "inbox"]).optional(),
  density: z.enum(["compact", "comfortable", "spacious"]).optional(),
  layout: z.enum(["split", "full", "by_account", "by_action", "chronological"]).optional(),
  theme: z.enum(["system", "light", "dark"]).optional(),
  aiEnabled: z.boolean().optional(),
  summariesEnabled: z.boolean().optional(),
  accountRanking: z.record(z.string().uuid(), z.number().min(-1).max(1)).optional(),
  priorityWeights: z.object({ relationship: z.number().min(0).max(1), explicit_urgency: z.number().min(0).max(1), deadline: z.number().min(0).max(1), thread_state: z.number().min(0).max(1), business_context: z.number().min(0).max(1), historical_response: z.number().min(0).max(1) }).partial().optional(),
  topicsEnabled: z.boolean().optional(),
  storeAttachments: z.boolean().optional(),
  customTopics: z.array(z.object({ name: z.string().min(1).max(40), terms: z.array(z.string().min(1).max(60)).min(1).max(30) })).max(30).optional(),
  personalizationEnabled: z.boolean().optional(),
  hostedModelConsent: z.boolean().optional(),
  serverSearchEnabled: z.boolean().optional(),
  semanticSearchEnabled: z.boolean().optional(),
  automationLevel: z.enum(["observe", "assist", "approve", "limited"]).optional(),
  workingHours: z.object({ start: z.number().min(0).max(23), end: z.number().min(0).max(24), tz: z.string().max(64) }).nullable().optional(),
  timeZone: z.string().max(64).optional(),
  emailDigest: z.boolean().optional(),
  browserNotifications: z.boolean().optional(),
  criticalBypassQuiet: z.boolean().optional(),
  hiddenSections: z.array(z.string()).optional(),
  pinnedSections: z.array(z.string()).optional(),
  quietHours: z.object({ start: z.number().min(0).max(24), end: z.number().min(0).max(24) }).nullable().optional(),
  /** Per sender and per account. Kept with preferences because a delegate has their own signature on a shared mailbox. */
  signatures: z.array(z.object({ id: z.string().max(64), accountId: Uuid, name: z.string().min(1).max(60), text: z.string().max(2000), isDefault: z.boolean().default(false) })).max(50).optional(),
  savedSearches: z.array(z.object({ name: z.string().min(1).max(60), q: z.string().min(1).max(500), concepts: z.boolean().default(false), semantic: z.boolean().optional() })).max(30).optional(),
  digestHours: z.number().int().min(1).max(168).optional(),
});
export const PolicyBody = z.object({
  quarantineThreshold: z.enum(["suspicious", "high_risk", "malicious"]).optional(),
  blockDomains: z.array(z.string().max(253)).max(1000).optional(),
  allowDomains: z.array(z.string().max(253)).max(1000).optional(),
  protectedDomains: z.array(z.string().max(253)).max(1000).optional(),
  moveBulkToSpam: z.boolean().optional(),
  blockRemoteImages: z.boolean().optional(),
  releaseRequiresApprovalForMalicious: z.boolean().optional(),
  outboundBlockDomains: z.array(z.string().max(253)).max(1000).optional(),
});
export const InviteBody = z.object({
  email: z.string().email(),
  role: z.enum(["member", "workspace_manager", "security_admin"]),
});
export const AssistantBody = z.object({ message: z.string().min(1).max(2000), threadId: Uuid.optional() });
export const IncidentShareBody = z.object({
  messageId: Uuid,
  analystUserId: Uuid,
  redact: z.boolean().default(true),
  hours: z.number().int().min(1).max(168).default(24),
  note: z.string().max(500).optional(),
});
