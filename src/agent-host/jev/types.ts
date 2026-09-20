/**
 * Shared Jev vocabulary for this app.
 *
 * The protocol shapes (state, questions, answers) live in the vendored client;
 * only the outcome vocabulary the app reasons about is ours, so the gate, the
 * compaction and the settings can share one set of failure reasons.
 */

/**
 * Why a Jev call produced no usable answer.
 *
 * Ported from pi-jev-auto-mode's `src/jev/types.ts`: every one of these must end
 * in a decision (the gate blocks, compaction falls back), never in an approval.
 */
export type JevUnavailableReason =
  "timeout" | "network" | "http" | "malformed_response" | "state_too_large" | "cancelled" | "unknown";

/** Human-readable text for a failure, used in records and notices. */
export const JEV_UNAVAILABLE_TEXT: Record<JevUnavailableReason, string> = {
  timeout: "the Jev request timed out",
  network: "the Jev request could not reach the API",
  http: "the Jev API returned an error status",
  malformed_response: "the Jev response did not match the questions that were asked",
  state_too_large: "the call description exceeded the request budget",
  cancelled: "the Jev request was cancelled",
  unknown: "the Jev request failed for an unknown reason",
};
