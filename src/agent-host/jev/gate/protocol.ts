/**
 * The gate's view of the Jev request shapes.
 *
 * Ported from pi-jev-auto-mode's `src/jev/state.ts` and `src/jev/types.ts` so the
 * gate code reads exactly like upstream. The transport itself is not ported: this
 * app's `jev/transport.ts` speaks both protocols from one client, and the gate's
 * engine adapter maps its answers onto these shapes.
 */

/** A JSON value accepted by the Jev `state` field. `Date` / `Map` are not included. */
export type JevJson = string | number | boolean | null | JevJson[] | { [key: string]: JevJson };

/**
 * The request state. `value` is the thing under judgment; `context` is the
 * session-scoped reference material (user policy, repository facts) that a
 * condition may point at explicitly, for example "`value.call` violates
 * `context.policy`".
 */
export interface JevState {
  readonly value: JevJson;
  readonly context: JevJson;
}

/** Values accepted by `instructions` and `criteria`. */
export type JevEntry = string | { [key: string]: JevJson } | JevJson[] | null;

export interface JevNoulQuestion {
  readonly type: "noul";
  readonly instructions?: JevEntry;
  readonly criteria?: { readonly true?: JevEntry; readonly false?: JevEntry } | null;
}
