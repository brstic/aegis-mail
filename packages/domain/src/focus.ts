export type FocusSection =
  | "needs_attention" | "waiting_on_someone" | "important_people" | "security_review"
  | "todays_commitments" | "read_later" | "low_priority";

export const FOCUS_SECTION_LABELS: Record<FocusSection, string> = {
  needs_attention: "Needs your attention",
  waiting_on_someone: "Waiting on someone",
  important_people: "Important people",
  security_review: "Worth a second look",
  todays_commitments: "Today's commitments",
  read_later: "Read later",
  low_priority: "Low priority",
};

/** Bounded 0..1 features behind the priority score. */
export interface PriorityFeatures {
  relationship: number;
  explicit_urgency: number;
  deadline: number;
  thread_state: number;
  business_context: number;
  historical_response: number;
  user_rules: number;
  bulk_noise: number;
  recently_dismissed: number;
}

export type PriorityWeights = Record<keyof PriorityFeatures, number>;

export const DEFAULT_PRIORITY_WEIGHTS: PriorityWeights = {
  relationship: 0.22, explicit_urgency: 0.1, deadline: 0.16, thread_state: 0.2, business_context: 0.1,
  historical_response: 0.12, user_rules: 0.3, bulk_noise: 0.45, recently_dismissed: 0.3,
};

export interface PriorityDecision {
  score: number;
  section: FocusSection;
  confidence: number;
  features: PriorityFeatures;
  /** Answers "why am I seeing this first?" */
  reasons: string[];
  needsReply: boolean;
  /** ISO when known. `dueIsUncertain` marks vague language that needs confirmation. */
  due?: { text: string; iso?: string; uncertain: boolean; evidence: string };
  version: string;
}
