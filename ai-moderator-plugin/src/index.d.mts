export type Verdict = "clean" | "rude" | "severe" | "unsure" | "unavailable";

export type ModerationResult = {
  /** Post the comment only when this is true. */
  allowed: boolean;
  verdict: Verdict;
  score: number | null;
  category: string | null;
  /** Plain-language reason shown to the writer. For severe: what is wrong and why. */
  reason: string;
  /** The model's plain-English reading of a non-English comment ("" for English). */
  meaning?: string;
  /** A short name for what's wrong ("Personal attack", "Threat"…), for rude and severe; otherwise absent. */
  label?: string | null;
  /** A checked, safe rewrite for rude comments; null otherwise. */
  suggestion: string | null;
};

export type ChatMessage = { role: "system" | "user"; content: string };
export type ModelCall = (messages: ChatMessage[], maxTokens: number) => Promise<string>;

export type ModeratorOptions = {
  call?: ModelCall;
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  timeoutMs?: number;
  cleanMax?: number;
  severeMin?: number;
  unsureMin?: number;
};

export type Moderator = {
  moderate(text: string, options?: { replyingTo?: string; suggest?: boolean }): Promise<ModerationResult>;
  score(text: string): Promise<{ score: number; category: string; reason: string; meaning: string; unsure: boolean }>;
  inspectDraft(text: string): { hint: "threat" | "check" | null; message: string | null };
};

export function createModerator(options?: ModeratorOptions): Moderator;
export function inspectDraft(text: string): { hint: "threat" | "check" | null; message: string | null };
export function redact(text: string): string;
export function labelFor(verdict: Verdict, category: string | null): string | null;
export function createNemotron(options?: { apiKey?: string; baseUrl?: string; model?: string; timeoutMs?: number }): ModelCall;
export function parseJson(text: string): unknown;

export class ModeratorError extends Error {
  status: number;
}

/** waiting: a person will decide (times out). flagged: severe, sent to moderators, never posted. */
export type ReviewStatus = "none" | "waiting" | "flagged" | "approved" | "upheld" | "expired";
export const REVIEW_REASONS: Record<"waiting" | "flagged" | "approved" | "upheld" | "expired", string>;

export type Decision = ModerationResult & {
  id: string;
  original_text: string;
  created_at: string;
  accepted: boolean;
  review: { status: ReviewStatus; requested_at: string; resolved_at: string | null; decision: "approve" | "uphold" | null } | null;
  storage?: string;
};

export type ReviewState = {
  id: string;
  status: ReviewStatus;
  /** Post only when this is true (a moderator approved it). */
  allowed: boolean;
  /** The approved text; null until approved. */
  text: string | null;
  reason: string;
  expires_at: string | null;
};

export type QueueItem = {
  id: string;
  text: string;
  verdict: Verdict;
  reason: string;
  meaning: string;
  status: "waiting" | "flagged";
  requested_at: string;
  expires_at: string | null;
};

export type ModeratorService = {
  decisions: Decision[];
  preview(text: string): { hint: "threat" | "check" | null; message: string | null };
  check(text: string, replyingTo?: string): Promise<Decision>;
  accept(id: string): Promise<{ text: string; allowed: true; storage: string }>;
  /** [Ask a moderator]: the comment waits, unposted, for a person. */
  ask(id: string): Promise<ReviewState>;
  status(id: string): Promise<ReviewState>;
  /** Open reviews, oldest first. */
  queue(): Promise<QueueItem[]>;
  /** Severe comments can only be upheld. */
  resolve(id: string, decision: "approve" | "uphold"): Promise<ReviewState>;
  recent(n?: number): Decision[];
};

export function createModeratorService(options?: {
  moderator?: Moderator;
  decisions?: Decision[];
  persist?: (item: Decision, decisions: Decision[]) => Promise<string>;
  limit?: number;
  /** Default 10 minutes. A waiting review nobody answers stays unposted. */
  reviewTimeoutMs?: number;
}): ModeratorService;
export function moderatorHandler(
  service?: ModeratorService,
  options?: { base?: string; secret?: string | null; moderatorSecret?: string | null; perMinute?: number }
): (req: unknown, res: unknown, next?: () => void) => Promise<void>;
