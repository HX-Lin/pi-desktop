# Ported: Jev gate, compaction and routing

Two upstream projects, MIT, ported into this app's own Jev layer. They are
**ports, not vendored copies**: the algorithm and every comment are kept, and the
pi-runtime and transport edges are replaced with this app's own (`jev/settings.ts`,
`jev/transport.ts`, `jev/service.ts`) so all three features share one channel
configuration, one key store and one failure taxonomy.

| upstream                                                                                                                                             | where it went                                                                            |
| ---------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `iefnaf/pi-jev` @ `7a40e30` — `src/compaction/*`, `src/routing/*`                                                                                    | `compaction/` (convert, decision, run, summarize, hook), `routing/` (decide, extension)  |
| `jomadasu/pi-jev-auto-mode` @ `06a5604` — `src/policy.ts`, `src/call.ts`, `src/intent.ts`, `src/decide.ts`, `src/jev/{questions,decide,criteria}.ts` | `gate/` (policy, call, intent, decide, questions, verdict, criteria, protocol, evaluate) |

## What was replaced at the edges

- **Transport**: upstream carried its own SDK (auto-mode) or its own fetch client
  (pi-jev). Both now go through `jev/transport.ts`, which speaks the native
  decisions protocol _and_ an OpenAI-compatible chat endpoint, so Vercel AI
  Gateway is a channel rather than a fork.
- **Keys**: upstream stored a key file in the agent directory (auto-mode) or read
  env only (pi-jev). Here keys come from the environment or this app's
  credential vault (`jev/keys.ts`).
- **Settings**: upstream read `jev.json` / env vars and exposed them through a TUI
  menu and a CLI. Here one document (`jev/settings.ts`) backs a Settings tab, and
  the gate's condition table is editable per rule.
- **Records**: auto-mode rendered decisions with pi's TUI components. Here the
  same data is a session entry (`gate/record.ts`) that the transcript renders.
- **Types**: auto-mode's `JevState` / `JevEntry` / `JevNoulQuestion` live in
  `gate/protocol.ts`, unchanged, since the vendored client names them differently.
- `@typesafe-ai/sdk` is not a dependency: the gate's engine calls our transport.

## Adding or changing a rule

`gate/questions.ts` is the single place a condition is defined (instruction,
mode, severity, threshold, and when it applies). `gate/verdict.ts` maps
probabilities to verdicts, and `gate/evaluate.ts` holds the ordering — that file
is the safety contract, so a change there needs a test in
`gate/evaluate.test.mjs`.
