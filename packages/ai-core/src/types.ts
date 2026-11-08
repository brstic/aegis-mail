import type { ActionItem } from "./text";

export interface ThreadMessageInput {
  id: string;
  fromName?: string;
  from: string;
  to: string[];
  date: string;
  subject: string;
  text: string;
  fromMe: boolean;
  riskLabel?: string | null;
}
export interface SummaryBullet { text: string; messageIds: string[] }
export interface ThreadSummary { bullets: SummaryBullet[]; ask?: string; basis: "extractive" | "model" }
export type DraftKind = "acknowledge" | "detailed" | "decline" | "clarify" | "follow_up" | "payment_inquiry" | "meeting" | "custom";
export interface DraftRequest {
  kind: DraftKind;
  /** The user's own instruction. Trusted as to intent, still validated afterward. */
  instruction?: string;
  tone: "neutral" | "warm" | "brief" | "formal";
  thread: ThreadMessageInput[];
  ownerName: string;
  ownerAddress: string;
}
export interface DraftResult { text: string; subject: string; assumptions: string[]; basis: "template" | "model" }

/** Discrete model capabilities. There's no method that sends, forwards, deletes, or modifies mail. */
export interface InferenceProvider {
  readonly id: string;
  readonly model: string;
  /** Whether message content leaves this deployment. Drives consent and Privacy Center. */
  readonly hosted: boolean;
  summarize(thread: ThreadMessageInput[]): Promise<ThreadSummary>;
  actions(thread: ThreadMessageInput[], ref: Date): Promise<ActionItem[]>;
  draft(req: DraftRequest): Promise<DraftResult>;
  /** Optional: choose an assistant tool. Absent means the deterministic planner is used. */
  plan?(message: string, threadId?: string): Promise<import("./assistant").AssistantToolCall>;
  onUsage?: (u: { purpose: string; inputTokens: number; outputTokens: number; latencyMs: number }) => void;
}
