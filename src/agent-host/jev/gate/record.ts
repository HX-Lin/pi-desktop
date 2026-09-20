/**
 * Decision records.
 *
 * Records are written as session entries, which keeps them out of the LLM
 * context on purpose: the model must not learn to argue with the gate, and a
 * recorded rationale should not become ammunition for the next tool call.
 *
 * Where upstream rendered these with pi's TUI components, this app stores the
 * same data as a structured entry and renders it in the transcript
 * (`MessageView`), including the per-condition table used for threshold tuning.
 */
import type { ConditionReport, DecisionSource } from "./decide";

export const DECISION_ENTRY_TYPE = "jev-auto-mode-decision";

export interface DecisionRecord {
  tool: string;
  summary: string;
  reasons: string[];
  status: "allowed" | "blocked" | "confirmed" | "cancelled";
  source: DecisionSource;
  rationale: string;
  conditions?: readonly ConditionReport[];
  decidingRule?: string;
  clearedByIntent?: readonly string[];
  probabilities?: Readonly<Record<string, number>>;
  model?: string;
  latencyMs?: number;
  timestamp: number;
}
