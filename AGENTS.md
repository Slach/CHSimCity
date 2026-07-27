# AGENTS.md

Read and follow [`CLAUDE.md`](CLAUDE.md) before changing this repository. It is
the source of truth for architecture, ClickHouse language, testing, visual
accuracy and delivery rules.

The five things most likely to bite you, in order:

0. **Bind shortcuts to `physicalKey(e)`, never `e.key`.** `e.key` is the
   character the keyboard LAYOUT produces. On a Cyrillic layout `F` arrives as
   `а` and `/` as `.`, so every shortcut matched against the character silently
   stops existing — no error, nothing in the console, and the app simply looks
   broken. Test a change to the keyboard with a Cyrillic-layout event, the way
   `test/keys.test.ts` does; do not test it by pressing the key yourself.
1. **`focus.target` and `labelAt` are WORLD coordinates.** Everything inside a
   node island is authored in local ones. Go through `nodeLocal()`. Getting this
   wrong put all four islands' labels and camera targets on one point between the
   shards, and it looked plausible until somebody clicked "fly to".
2. **Sample the simulation during a run, not at the end**, and measure counter
   **deltas** from a baseline — `createSim` warms the cluster up at the DEFAULT
   settings before your knobs are applied. `test/model.test.ts` has `observe()`
   and `baseline()` for exactly this.
3. **Read a stylesheet with `node:fs`, never `import '…css?raw'`.** Under Vitest
   that import is an empty string. `test/minimap.test.ts` did it for one commit:
   its fixture threw during collection, Vitest reported the file as zero tests
   AND zero failures, and the suite stayed green while asserting nothing. Check
   that the test COUNT went up, not just that the run is green.
4. **Never put `*/` inside a block comment** (a path like `shard*/` ends it) and
   never put a backtick inside a template literal holding GLSL. Both have already
   broken the parse.

## Workflow

```bash
npm install
npm run dev            # http://localhost:5174
npm test               # model behaviour, plan consistency, keyboard, chrome
npm run typecheck
npm run build
```

All three of `npm test`, `npm run typecheck` and `npm run build` must be green
before handing off.

## Visual verification

Creating an image file is not verification — open it and say what it shows.

Driving the app through the bus, or by assigning to `.value`, is not
verification of a control either: it skips hit-testing, which is the only thing
that can tell you a transparent full-screen overlay is swallowing every click in
the application. Ask the browser where a click would actually land:

```js
const r = node.getBoundingClientRect()
document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2) // === node?
```

```bash
npm run preview
node tools/shoot.mjs http://localhost:4173/ tmp/shot.png 40000 1600 980
```

The optional sixth argument is JavaScript evaluated before the shot, and its
result is printed, so it doubles as a probe:

```bash
node tools/shoot.mjs http://localhost:4173/ tmp/yard.png 32000 1500 900 \
  "window.CHSIMCITY.bus.emit('focus',{id:'node.0.yard'});JSON.stringify(window.CHSIMCITY.sim.state.stats)"
```

Software WebGL runs at 1–3 fps, so allow 30–70 seconds to settle, and do not run
more than two or three drivers at once: each rasterises on the CPU and spikes to
well over a gigabyte.
