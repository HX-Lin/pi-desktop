# Vendored: Jev protocol client

Source: <https://github.com/iefnaf/pi-jev> at commit `7a40e30da13b2f549c26cc73bb3f36a26c9f1735`,
path `src/vendor/fast-jev-compaction/` — itself a vendored subset of
[tamaratran/fast-jev-compaction](https://github.com/tamaratran/fast-jev-compaction), MIT
(see `LICENSE` in this directory, retained from upstream).

These files describe the Jev wire protocol and the state/compaction primitives
that go with it: the request body, response validation, the fitted `state`
document, and the tool-call collection used when a compaction has to decide what
is still worth keeping.

## Mechanical change

Relative imports were rewritten from `'./x.js'` to `'./x'`. The upstream style
targets `tsc` with `nodenext`; this repo bundles with esbuild, which does not
resolve `./x.js` to `./x.ts`. Nothing else was touched.

## What is not here

- `client.ts` is kept but unused by this app: the transport in
  `src/agent-host/jev/transport.ts` builds its own requests so it can also speak
  the OpenAI-compatible `chat/completions` protocol (Vercel AI Gateway) and
  share one failure taxonomy with the gate.
- The upstream projects' other layers (their pi extension hooks, the `/jev` TUI
  menu, the CLI, the TypeSafe SDK) are not vendored; `src/agent-host/jev/`
  implements those concerns against this app's own settings, vault and RPC.

## Updating

```bash
git clone --depth 1 https://github.com/iefnaf/pi-jev.git /tmp/pi-jev
for f in types request client state compact index; do
  cp /tmp/pi-jev/src/vendor/fast-jev-compaction/$f.ts src/agent-host/vendor/jev/$f.ts
done
cp /tmp/pi-jev/src/vendor/fast-jev-compaction/LICENSE src/agent-host/vendor/jev/LICENSE
# then re-apply the `./x.js` -> `./x` import rewrite
```

The files are type-checked by this repo's tsconfig, so an upstream change that
breaks our consumers fails the build rather than a judgment at runtime.
