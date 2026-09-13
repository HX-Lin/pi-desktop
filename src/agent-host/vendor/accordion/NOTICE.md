# Vendored: Accordion context-fold engine

Source: <https://github.com/a-Fig/Accordion> — commit `e3eb9bbb9db64aa3db741387bf5f501424ebfb1f`
(`main`, 2026-08-22) · MIT · see `LICENSE` in this directory.

Accordion is a pi extension that treats the context window as blocks that can be
**folded** — replaced by a short deterministic digest — and unfolded again, so a
long session stays affordable without losing anything. Its engine is the part
worth owning: the fold/unfold rules, the provider-safety invariants, and the
`{#code FOLDED}` digests the model itself can act on.

## What is here

`core/` is vendored verbatim (same file names, same content):

| file | what |
|---|---|
| `types.ts` | `Block`, `Group`, `SessionMeta`, `ParsedSession` |
| `tokens.ts` | chars/4 token estimate used by the engine |
| `digest.ts` | per-kind folded representation + the `{#code FOLDED}` tag |
| `wire.ts` | `linearize` (pi messages → blocks), `applyPlan`, `computeDegradedDropRuns` |
| `groupShape.ts` | which messages of a group the wire may actually remove |
| `ops.ts` | the op vocabulary (`fold`/`unfold`/`pin`/`group`/…), `TxnResult` |
| `locks.ts` | involvement locks |
| `events.ts` | `TruthEvent` |
| `protocol.ts` | the wire message shapes (types only in this integration) |
| `truth.ts` | the engine: block log, overlays, groups, protected tail, `serializeWire` |
| `agentView.ts` | resolving an agent `unfold` / `recall` against the engine |

## What was deliberately left out

- `core/replica.ts` and `core/protocol.ts` runtime pieces — they exist to sync a
  GUI over a WebSocket. pi-desktop talks to the engine in-process over its own
  RPC (`context.map` / `context.fold`), so there is no socket, no token, and no
  second copy of the state.
- `core/conductor/` and `conductors/` — the automatic strategies. Nothing in the
  engine depends on them; they can be added later on top of
  `ContextFoldEngine`/`applyFoldCommand`.
- `extension/`, `app/` — their pi extension and Tauri/SvelteKit UI. This
  integration replaces both: `src/agent-host/context-fold.ts` is the host adapter
  and `src/renderer/components/ContextFoldMap.tsx` is the map.

## Updating from upstream

```bash
git clone --depth 1 https://github.com/a-Fig/Accordion.git /tmp/accordion
for f in types tokens digest wire groupShape ops locks events protocol truth agentView; do
  cp /tmp/accordion/core/$f.ts src/agent-host/vendor/accordion/core/$f.ts
done
```

Then re-run `npx tsc -p tsconfig.json` and `npm test`. The vendored files are
type-checked by the app's own tsconfig (they only import each other), so an
upstream change that breaks our adapter shows up immediately instead of at
runtime.
