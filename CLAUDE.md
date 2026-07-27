# CLAUDE.md — CHSimCity

## Project

CHSimCity is an explorable 3D cluster that teaches how ClickHouse works. The
structures and motion represent real mechanisms; the numbers are deliberately
scaled so people can see those mechanisms operate. It is a model, not an
emulator, and no ClickHouse source code runs in the browser.

Use **CHSimCity** in prose and headings and `chsimcity` for package-style names.

The intended reader is technically capable but may never have operated a column
store. Explain ClickHouse precisely without assuming operator vocabulary, and
disclose every simplification that could change the lesson.

## Architecture

```text
src/
  core/     shared contracts, event bus, registry, theme, utilities, timebase
  sim/      pure TypeScript ClickHouse model, and the scenarios
  world/    three.js geometry, one module per district
  engine/   renderer, camera, particle flows, roads, labels, picking
  ui/       HUD, console, inspector, tour, palette, written explanations
test/       model behaviour, and plan/content consistency
```

- `src/core/types.ts` defines `SimState`, the contract between simulation and
  presentation.
- `src/sim` never imports three.js. It owns and mutates simulation state.
- `src/world` may read `SimState` but never mutates it.
- `src/world/layout.ts` is the single source of truth for geography. Shared
  anchors, per-node anchors, table definitions and routes belong there.
- `src/engine` turns state and geometry into an interactive scene.
- `src/ui` explains and exposes state; it does not become a second model.

The browser debugging surface is `window.CHSIMCITY`.

## Stack

TypeScript in strict mode targeting ES2022, three.js r185, Vite, Vitest, Node 20+.

three.js is the only runtime dependency. Do not add another runtime dependency, a
framework, a CDN, remote fonts, binary assets, telemetry, or analytics. The
shipped application must remain a static bundle with no server and no runtime
network calls.

## Key design rules

1. **The architecture boundary is hard.** `sim` owns state, `world` presents it,
   and both meet at `SimState`.
2. **Geography has one owner.** Cross-district positions and routes live in
   `src/world/layout.ts`. A component's `focus.target` and `labelAt` are **world**
   coordinates — anything authored inside an island must go through
   `nodeLocal()`. Forgetting that once put all four islands' labels and camera
   targets on the same point.
3. **The model must be honest.** Preserve real algorithms and formulas, scale only
   what is necessary for observation, and state material simplifications in the
   component's own doc, not only in the README.
4. **`Distributed` is a table on every server, never a place.** The DDL runs on
   all of them, so all of them have it and any of them can be the initiator —
   the one the client connected to. `nodes[i].distributed` is server `i`'s copy;
   there is no `state.distributed`, no `distributed` district and no cluster
   anchor for one, and `test/layout.test.ts` enforces that. Which server
   initiates is the *application's* choice, which is why the establishing shot
   stands behind the clients: that is where the decision is made.
5. **Colour is semantic and never decorative.** A part's colour IS its
   `system.parts.state`; nothing else may use those five values. Do not reuse a
   mechanism's colour because it looks good.
6. **Meaning controls appearance.** Night uses matte structure and neon meaning
   and only emissive above the bloom threshold glows. Day is a separate rendering
   model, not the night one with the exposure raised.
7. **Frame loops allocate nothing.** Reuse vectors, colours, matrices and scratch
   objects. Visual richness is not permission to make the renderer collect
   garbage.
8. **Geometry is a factual claim.** A building can teach a falsehood more
   persuasively than nearby text teaches the truth. Review the rendered result,
   not only the source coordinates.
9. **No silent caps.** If a visualisation bounds what it draws, the counters must
   still report the truth. The parts yard is a *window*, not a limit: a part
   beyond it has `slot === -1`, is fully simulated, and is skipped by the world.
10. **A shortcut is a physical key.** Bind through `physicalKey(e)` from
    `ui/uikit.ts`, never `e.key`. `e.key` is the character the LAYOUT produces,
    so on a Cyrillic keyboard `F` arrives as `а` and `/` as `.`, and every
    shortcut written against it silently ceases to exist — with no error and
    nothing in the console. That is how fly, the tour, the palette, pause, reset
    and the theme toggle were all dead for a Russian-layout visitor while WASD
    kept working, because the camera rig alone already switched on `e.code`.
11. **A toggle is resolved by its sender.** `camera:mode` is a command — "be in
    this mode" — and the listener ignores a request for the mode it is already
    in, which is what stops it echoing the rig's own announcement. So F has to
    decide `fly` or `orbit` itself. A toggle expression inside that listener is
    unreachable, and the one that used to be there meant fly mode could be
    entered and never left.
12. **A closed overlay must be `display: none`, not merely transparent.** An
    author `display` beats the UA's `[hidden]` rule, so `.pal-overlay` and
    `.help` — `position: fixed`, `inset: 0`, `pointer-events: auto` — stayed
    hit-testable at `opacity: 0` and swallowed every click in the application
    from the first paint: the scenario picker, the dock, the console tab and the
    3D scene. The `[hidden] { display: none !important }` reset in `tokens.css`
    is what makes `hidden` mean hidden; `test/overlays.test.ts` guards it. Verify
    a control with `document.elementFromPoint`, never by emitting its bus event.
13. **A map with a uniform projection owns its aspect ratio.** The minimap
    canvas cannot be given an arbitrary CSS box: it does not stretch to fit, it
    surrounds the plan with empty ground. `test/minimap.test.ts` holds the
    stylesheet to the extent computed from `world/layout.ts`.

## ClickHouse language

- Say **part**, not page or segment or row group. A part is a directory.
- Say **granule** for `index_granularity` rows, and **mark** for the `.mrk3`
  entry that locates one. They are not the same thing.
- Use ClickHouse's own setting names verbatim in backticks:
  `parts_to_delay_insert`, `merge_with_ttl_timeout`, `max_threads`.
- Say **Keeper** for ClickHouse Keeper. Say **znode**, not node, for its data.
- Binary units in prose and UI: KiB, MiB, GiB, TiB.
- Say "exception", not "crash": a `Code: 252` does not bring the server down.
- Wrap literal SQL, engine names, settings, system tables, file names and source
  symbols in inline code.

## Testing

`npm test` runs two suites and both must be green before a change ships.

- **`test/model.test.ts`** asserts PROPERTIES of the simulation, never snapshots:
  "a merge never crosses a partition boundary", "no Keeper session means no block
  is written", "a TTL merge takes exactly one input part". A snapshot would break
  on every tuning change and prove nothing about the mechanism.
- **`test/layout.test.ts`** asserts that the plan and the content tables agree
  with each other: every route the model emits on exists, every knob has a
  default inside its own range, every doc's `see` link resolves.

Two sampling rules the suite depends on, both learned the hard way:

- **Sample during the run, not at the end.** A merge lasts a second or two and a
  query a fraction of one, so "is a merge running right now" is almost always
  false at any single instant. Use `observe()`.
- **Measure deltas, not absolutes.** `createSim` warms the cluster up at the
  DEFAULT settings before a test's knobs are applied, so any counter read
  afterwards includes work done before the knob existed. Use `baseline()`, and
  ignore queries whose `id` predates the change.

Before handing off a change: `npm test`, `npm run typecheck`, `npm run build`.

## Visual verification

A successful render command is not visual verification. Look at the image.

```bash
npm run preview
node tools/shoot.mjs http://localhost:4173/ tmp/shot.png 40000 1600 980
```

The last argument is JavaScript evaluated before the shot, which is how you stage
a view:

```bash
node tools/shoot.mjs http://localhost:4173/ tmp/yard.png 32000 1500 900 \
  "window.CHSIMCITY.bus.emit('focus',{id:'node.0.yard'});'ok'"
```

Software WebGL runs at 1–3 fps, so allow 30–70 seconds to settle. The driver
prints every console message and exception and exits non-zero if anything threw.
Do not run more than two or three at once: each rasterises WebGL on the CPU and
spikes to well over a gigabyte.

## Style

- Comments state what the code cannot: a constraint, a non-obvious invariant, a
  hazard, or the reason a formula is the shape it is. Do not narrate the next
  line.
- When a value was chosen to fix a specific observed failure, say which failure.
  Those comments are the ones that stop the bug coming back.
- Prefer `/* … */` for multi-line comments and `//` for a single-line constraint.
- Never put `*/` inside a block comment (a path like `shard*/` will end it), and
  never put a backtick inside a template literal holding GLSL. Both have already
  broken the parse once.

## Copyright

Apache-2.0. ClickHouse is a trademark of ClickHouse, Inc.; never imply that
CHSimCity is affiliated with, sponsored by, or endorsed by ClickHouse, Inc.

The project's shape is derived from
[PGSimCity](https://github.com/NikolayS/PGSimCity) by Nikolay Samokhvalov
(Apache-2.0), which does the same for PostgreSQL. Keep the acknowledgement in
`README.md` with any distribution.
