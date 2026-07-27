# CHSimCity

**An explorable 3D cluster that shows how ClickHouse actually works.**

**[slach.github.io/CHSimCity](https://slach.github.io/CHSimCity/)** — it runs in
the browser, with no server behind it.

Four data nodes, three Keeper nodes, and one `Distributed` table in front of
them. Every structure is one real mechanism: the towers in the middle of each
island are `system.parts`, and a part's **height is its row count** and its
**colour is its `system.parts.state`**. The yellow tower to the west is
`primary.cidx`. The gantry to the south is `system.merges`, and the beam it drops
onto the yard is the set of parts that merge has reserved.

It is built for engineers who are good at their job and have never had to operate
a column store — the people who need to know why a thousand small INSERTs a
second takes a cluster down, why a query that names the wrong column reads a
hundred times more data, and what a TTL actually costs.

---

> ### This is a prototype
>
> It is a **model** of ClickHouse, not an emulator: nothing here parses SQL and no
> byte of ClickHouse source code runs in your browser. It almost certainly
> contains inaccuracies in both the simulation and the explanations.
>
> Corrections about how ClickHouse really behaves are the most valuable thing this
> project can receive.

---

## Run it

Node.js 20 or newer, and a browser with WebGL2.

```bash
npm install
npm run dev        # http://localhost:5174
```

```bash
npm run build      # static bundle in dist/
npm run preview
npm run typecheck
npm test
```

No server, no database, no network calls. It is a single static bundle.

### Publishing

`.github/workflows/pages.yml` builds `main` and deploys `dist/` to GitHub Pages.
Typecheck and the test suite run first, and a failure in either stops the
deploy.

It needs **Settings → Pages → Source: GitHub Actions** set once on the
repository; nothing else. `base: './'` in `vite.config.ts` makes every asset URL
relative to the page, so the same `dist/` works unchanged at a project subpath,
at a user page, and from a `file://` URL — the repository name is not baked in
anywhere.

---

## Controls

| | |
|---|---|
| Left-drag | Pan — grab the ground and move it, the way a map does |
| Shift-drag / middle-drag | Orbit |
| Wheel | Zoom — the dolly follows the cursor, not the pivot |
| Click · double-click | Select · fly to |
| `W` `A` `S` `D` / arrows | Move |
| `F` | Fly mode, on and off. Click the scene to capture the mouse; `Esc` gives it back, `Esc` again leaves |
| `W` `A` `S` `D` · `Space` `C` · wheel | In fly mode: move · rise and descend · change speed |
| `H` | Back to the establishing shot |
| `T` | Guided tour — the whole cluster in fifteen chapters |
| `/` or `Ctrl-K` | Command palette: every component, setting and scenario |
| `?` | Keyboard map and colour legend |
| `K` or `P` · `,` `.` | Pause · slower / faster |
| `N` · `R` | Day / night · reset |
| `1` – `7` | Jump: clients, initiator, the four nodes, Keeper |

Every shortcut is bound to the **physical key**, not to the character it prints,
so they all work unchanged on a non-Latin keyboard layout.

The **minimap** in the bottom-left is a plan drawn from the same numbers the 3D
scene is built from. Every district is labelled and carries its own colour —
until a node is in trouble, when it gives that colour up for amber or red, so a
sick node is visible without flying to it. The cone is where you are and what you
can see; at the establishing shot you are south of the map and it pins itself to
the edge. Click a district to fly to it, or the empty ground to pull back out.

---

## What you are looking at

The geography is the order things happen in.

| District | What it is |
|---|---|
| **Client terminal** (north, outside) | The application tier. It knows one table name and nothing about shards |
| **Distributed initiator** | The hash wheel is the sharding key; the silos are the background insert spool; the merge floor is where partial results are combined |
| **Four islands** | Two shards, two replicas. Each is one ClickHouse server |
| **Keeper quorum** (south) | Three raft nodes. Metadata only — and every write depends on them |

Inside one island, west to east:

| | |
|---|---|
| **Insert dock** (north) | `MergeTreeDataWriter`: sort by ORDER BY, split by PARTITION BY, compress each column into its own `.bin`, rename the directory into place |
| **primary.cidx** (west) | The sparse primary index — one sorting-key row per 8192-row granule. Drawn as equal steps, because that is what it is |
| **Skip index sheds** | `skp_idx_*.idx2`. Each shed's **height is the share of blocks that index can actually prune** |
| **Cache deck** (elevated) | The mark cache and the uncompressed cache, as two tanks |
| **Parts yard** (centre) | `system.parts`, standing over the excavation the data lives in. One band per table |
| **Read pool** (east) | `MergeTreeReadPool` and its reader threads. Each bay's colour is its phase |
| **Merge gantry** (south) | `system.merges`, with a beam onto every input part |
| **TTL works** | Where expired rows are removed — or moved |
| **Replication queue** (west) | `system.replication_queue`, and the Keeper session lamp |
| **Storage volumes** (below) | Hot local SSD over cold object storage |

### Colour is semantic and never decorative

A part's colour **is** its `system.parts.state`, and nothing else in the cluster
uses those five colours:

**green** `active` — the only state a SELECT can see · **grey** `outdated` —
merged away, still on disk for running queries · **pale blue** `preactive` —
renamed into place, committing · **violet** `temporary` — still `tmp_insert_…` ·
**pink** — every row past its TTL.

Elsewhere: **amber** merges, **magenta** mutations, **pink** TTL, **orange**
replication, **coral** a part crossing the wire between replicas, **violet**
Keeper, **yellow** the primary index, **aqua** the skip indexes.

---

## Things worth trying

- Run **Too many parts**. Watch `parts_to_delay_insert` slow the writer down on
  purpose, long before `parts_to_throw_insert` refuses anything — the delay is
  what you see in production, and the error is what you see afterwards.
- Then run **async_insert rescues it**: same load, one setting, a fraction of the
  parts.
- Drag **Queries that match the sorting key** to zero and open the read pool.
  When `granules_after_key` equals `granules_total`, the primary index did no
  work at all. That is a schema problem, not a tuning one.
- Shrink **mark_cache_size** to 32 MiB and watch the *seeking* phase take over
  every reader bay. Nothing about the data changed; only whether the offsets were
  resident.
- Watch a **TTL merge**. It is the only kind whose output has fewer rows than its
  input, because a part is a directory and a row cannot be deleted from one.
- Turn **Keeper** off. Every replicated table goes read-only and every SELECT
  keeps working — which is why a Keeper outage takes an hour to be recognised as
  an outage.
- Turn on **One replica cannot keep up** and watch `absolute_delay` climb while
  the load balancer keeps sending it half your reads.

---

## How it is built

```
src/
  core/           contracts — types, the event bus, the palette, the registry
  sim/            the ClickHouse model. No three.js in here, ever
  world/          layout.ts is the cluster plan; one module per district
  engine/         renderer, camera, particle flows, labels, picking
  ui/             HUD, console, inspector, tour, palette, and the explanations
test/             behaviour tests for the model, consistency tests for the plan
```

Four rules hold it together:

1. **`world/layout.ts` is the single source of truth for geography.** Anchors,
   table definitions and the route network live there. No district hard-codes a
   coordinate another district needs.
2. **The simulation never imports three.js, and the world never mutates the
   simulation.** They meet at `SimState`.
3. **Structure is matte, meaning is neon.** At night only emissive materials
   cross the bloom threshold, so anything that glows carries information. Day is
   a different rendering model, not the night one with the lights turned up.
4. **Frame loops allocate nothing.** Every vector, colour and matrix is hoisted.

Stack: [three.js](https://threejs.org) r185, TypeScript, Vite. One runtime
dependency, no framework, no CDN, no telemetry.

`window.CHSIMCITY` in the browser console hands you
`{ sim, registry, bus, rig, gfx, flows }`.

---

## Honesty

The algorithms are meant to be *true*, not pretty: the merge selector really does
refuse to merge across a partition boundary and really does prefer uniform
ranges, the primary index really is binary-searched into mark ranges, a
`MERGE_PARTS` log entry really does make the sibling replica perform the merge
itself rather than fetch the result, and a TTL merge really does rewrite the part
around the rows it removes.

Three distortions are deliberate, and every component's inspector names the ones
that affect it:

1. **Time is stretched** for anything sub-second and **compressed** for anything
   measured in hours. The `metrics` table's TTL is two minutes rather than two
   weeks, and `merge_with_ttl_timeout` is 20 s rather than four hours, because a
   TTL you cannot watch expire teaches nothing.
2. **The cluster is a scale model.** Four nodes, and at most 96 *visible* parts
   per table per node — a part beyond that window is still fully simulated and
   still counted, it simply has nowhere to stand.
3. **Granules are counted, not simulated.** A query's cost comes from how many
   index granules survive partition pruning, the primary key and the skip
   indexes, which is the arithmetic ClickHouse itself does — but the rows inside
   a granule are never materialised.

One further scaling deserves its own mention because it is not a distortion of
time or count but of *breadth*: the mark cache's working set is sized as if the
node hosted twenty-four times the three tables actually drawn. Sizing it against
three tables would make the 5 GiB default look infinitely generous and hide the
failure mode entirely.

---

## Acknowledgements

The idea and the shape of this project — an explorable 3D city where every
building is a real database mechanism — come from
[PGSimCity](https://github.com/NikolayS/PGSimCity) by Nikolay Samokhvalov, which
does the same thing for PostgreSQL. The architecture here follows its lead: the
hard `sim` / `world` boundary, one plan file owning all geography, semantic
colour, and the rule that geometry is a factual claim. The ClickHouse model, the
districts and the explanations are this project's own, and so is any error in
them.

The explanations lean on the ClickHouse documentation and source. None of the
people or projects named here has reviewed this, and nothing in it should be read
as endorsed by them.

---

## Licence

[Apache-2.0](LICENSE).

ClickHouse is a trademark of ClickHouse, Inc. CHSimCity is an independent
educational project and is not affiliated with, sponsored by, or endorsed by
ClickHouse, Inc.
