import { describe, expect, it } from 'vitest'

import {
  DEFAULT_KNOBS,
  INDEX_GRANULARITY,
  N_MERGE_SLOTS,
  N_NODES,
  N_PART_SLOTS,
  N_QUEUE_SLOTS,
  N_READ_THREADS,
  N_REPLICAS,
  N_SHARDS,
} from '../src/core/types'
import type { Knobs } from '../src/core/types'
import {
  ANCHOR,
  CITY,
  DISTRICT_BOUNDS,
  LOCAL,
  N_TABLES,
  ROUTES,
  TABLES,
  bandZLocal,
  keeperPos,
  mergeSlotLocal,
  nodeHost,
  nodeIndex,
  nodeLocal,
  nodeOrigin,
  partSlotLocal,
  queueSlotLocal,
  readerBayLocal,
  replicaOf,
  rid,
  rowBytesCompressed,
  rowBytesUncompressed,
  routeCurve,
  shardOf,
  siblingOf,
  streamCount,
} from '../src/world/layout'
import { markCount, partitionId, partName, shardHash } from '../src/core/util'
import { KNOB_META, doc, knobMeta } from '../src/ui/content'
import { DOCS } from '../src/ui/docs'
import { SCENARIOS } from '../src/sim/scenarios'
import { CHAPTERS } from '../src/ui/tour'

/* ============================================================================
 * Plan and content consistency.
 *
 * The plan is the single source of truth for geography, and the docs are the
 * single source of truth for the explanations. Both are large hand-written
 * tables, and both are exactly the kind of thing that drifts silently: a route
 * that nobody emits on, a knob a doc references after it was renamed, a scenario
 * that focuses a component that no longer exists.
 *
 * These are cheap checks for exactly that drift.
 * ==========================================================================*/

describe('the cluster plan', () => {
  it('node indexing round-trips', () => {
    for (let s = 0; s < N_SHARDS; s++) {
      for (let r = 0; r < N_REPLICAS; r++) {
        const n = nodeIndex(s, r)
        expect(shardOf(n)).toBe(s)
        expect(replicaOf(n)).toBe(r)
      }
    }
  })

  it('a sibling is the other replica of the same shard', () => {
    for (let n = 0; n < N_NODES; n++) {
      const sib = siblingOf(n)
      expect(sib).not.toBe(n)
      expect(shardOf(sib)).toBe(shardOf(n))
    }
  })

  it('every host name is unique', () => {
    const seen = new Set<string>()
    for (let n = 0; n < N_NODES; n++) {
      expect(seen.has(nodeHost(n))).toBe(false)
      seen.add(nodeHost(n))
    }
  })

  it('the four islands do not overlap', () => {
    const half = { x: CITY.node.w / 2, z: CITY.node.d / 2 }
    for (let a = 0; a < N_NODES; a++) {
      for (let b = a + 1; b < N_NODES; b++) {
        const oa = nodeOrigin(a)
        const ob = nodeOrigin(b)
        const apart = Math.abs(oa[0] - ob[0]) >= CITY.node.w || Math.abs(oa[2] - ob[2]) >= CITY.node.d
        expect(apart, `islands ${a} and ${b} overlap`).toBe(true)
      }
    }
    void half
  })

  it('every part slot has a distinct position inside the deck', () => {
    const seen = new Set<string>()
    const halfW = CITY.yard.deckW / 2
    const halfD = CITY.yard.deckD / 2
    for (let t = 0; t < N_TABLES; t++) {
      for (let i = 0; i < N_PART_SLOTS; i++) {
        const p = partSlotLocal(t, i)
        const key = `${p[0].toFixed(3)}|${p[2].toFixed(3)}`
        expect(seen.has(key), `slot ${t}:${i} collides`).toBe(false)
        seen.add(key)
        // Every tower has to stand ON the deck, or it is floating over the pit.
        expect(Math.abs(p[0])).toBeLessThanOrEqual(halfW)
        expect(Math.abs(p[2])).toBeLessThanOrEqual(halfD)
      }
    }
  })

  it('each table band is separated from the next', () => {
    for (let t = 1; t < N_TABLES; t++) {
      expect(bandZLocal(t) - bandZLocal(t - 1)).toBe(CITY.yard.bandPitch)
    }
  })

  it('the reader bays, merge bays and queue slots are all distinct', () => {
    const bays = new Set<string>()
    for (let i = 0; i < N_READ_THREADS; i++) {
      const p = readerBayLocal(i)
      const key = `${p[0]}|${p[2]}`
      expect(bays.has(key)).toBe(false)
      bays.add(key)
    }
    const merges = new Set<string>()
    for (let i = 0; i < N_MERGE_SLOTS; i++) {
      const p = mergeSlotLocal(i)
      const key = `${p[0]}|${p[2]}`
      expect(merges.has(key)).toBe(false)
      merges.add(key)
    }
    const queue = new Set<string>()
    for (let i = 0; i < N_QUEUE_SLOTS; i++) {
      const p = queueSlotLocal(i)
      const key = `${p[0]}|${p[1]}`
      expect(queue.has(key)).toBe(false)
      queue.add(key)
    }
  })

  it('the Keeper halls are distinct and inside the Keeper district', () => {
    const b = DISTRICT_BOUNDS.keeper
    const seen = new Set<string>()
    for (let i = 0; i < 3; i++) {
      const p = keeperPos(i)
      expect(seen.has(String(p[0]))).toBe(false)
      seen.add(String(p[0]))
      expect(p[0]).toBeGreaterThanOrEqual(b.x[0])
      expect(p[0]).toBeLessThanOrEqual(b.x[1])
      expect(p[2]).toBeGreaterThanOrEqual(b.z[0])
      expect(p[2]).toBeLessThanOrEqual(b.z[1])
    }
  })

  it('nodeLocal offsets by the island origin', () => {
    for (let n = 0; n < N_NODES; n++) {
      const o = nodeOrigin(n)
      const w = nodeLocal(n, 10, 20, 30)
      expect(w).toEqual([o[0] + 10, o[1] + 20, o[2] + 30])
    }
  })

  it('the client terminal and the initiator are north of every island', () => {
    for (let n = 0; n < N_NODES; n++) {
      expect(ANCHOR.clientTerminal[2]).toBeLessThan(nodeOrigin(n)[2] - CITY.node.d / 2)
      expect(ANCHOR.distributed[2]).toBeLessThan(nodeOrigin(n)[2] - CITY.node.d / 2)
    }
  })

  it('the ground plate runs out past the fog, so its edge is never a horizon', () => {
    expect(CITY.ground / 2).toBeGreaterThan(CITY.fog.far * 1.2)
  })

  it('every anchor inside an island stays within its footprint', () => {
    for (const key of Object.keys(LOCAL) as (keyof typeof LOCAL)[]) {
      const a = LOCAL[key]
      expect(Math.abs(a[0]), `${key} is outside the island in x`).toBeLessThanOrEqual(CITY.node.w / 2)
      expect(Math.abs(a[2]), `${key} is outside the island in z`).toBeLessThanOrEqual(CITY.node.d / 2)
    }
  })
})

describe('the route network', () => {
  it('every route builds a curve with a positive length', () => {
    for (const id of Object.keys(ROUTES)) {
      const c = routeCurve(id)
      expect(c, `route ${id} has no curve`).not.toBeNull()
      expect(c!.getLength(), `route ${id} is degenerate`).toBeGreaterThan(1)
    }
  })

  it('every route id the simulation emits on exists', () => {
    const ids: string[] = [rid.clientInsert, rid.clientSelect, rid.clientResult]
    for (let n = 0; n < N_NODES; n++) {
      ids.push(
        rid.shardInsert(n),
        rid.shardQuery(n),
        rid.shardResult(n),
        rid.sortBlock(n),
        rid.writeColumns(n),
        rid.commitPart(n),
        rid.probeIndex(n),
        rid.probeSkip(n),
        rid.markToPool(n),
        rid.readerToResult(n),
        rid.yardToMerge(n),
        rid.mergeToYard(n),
        rid.yardToTtl(n),
        rid.ttlDrop(n),
        rid.toHotVolume(n),
        rid.hotToCold(n),
        rid.nodeToKeeper(n),
        rid.keeperToNode(n),
        rid.fetchPart(siblingOf(n), n),
      )
      for (let th = 0; th < N_READ_THREADS; th++) ids.push(rid.poolToReader(n, th))
    }
    for (const id of ids) expect(ROUTES[id], `missing route ${id}`).toBeDefined()
  })

  it('no route has two identical consecutive control points', () => {
    // A repeated point makes CatmullRom produce a zero tangent, and a packet on
    // it flips orientation for one frame.
    for (const id of Object.keys(ROUTES)) {
      const pts = ROUTES[id].points
      for (let i = 1; i < pts.length; i++) {
        const a = pts[i - 1]
        const b = pts[i]
        const same = a[0] === b[0] && a[1] === b[1] && a[2] === b[2]
        expect(same, `route ${id} repeats point ${i}`).toBe(false)
      }
    }
  })
})

describe('the tables', () => {
  it('every table has a sorting key starting at position 0', () => {
    for (const t of TABLES) {
      const positions = t.columns.filter((c) => c.keyPos >= 0).map((c) => c.keyPos).sort()
      expect(positions.length, `${t.name} has no sorting key`).toBeGreaterThan(0)
      expect(positions[0]).toBe(0)
      // Key positions must be contiguous, or the "prefix" argument is nonsense.
      positions.forEach((p, i) => expect(p).toBe(i))
    }
  })

  it('compression makes every row smaller, never larger', () => {
    for (let t = 0; t < N_TABLES; t++) {
      expect(rowBytesCompressed(t)).toBeLessThan(rowBytesUncompressed(t))
      for (const c of TABLES[t].columns) expect(c.ratio).toBeGreaterThanOrEqual(1)
    }
  })

  it('a wide column type declares more streams than a scalar one', () => {
    // The stream count is what drives the mark working set and the horizontal
    // merge's memory, so it has to exceed the column count wherever a table has
    // an Array, a Map, a LowCardinality or a JSON.
    for (let t = 0; t < N_TABLES; t++) {
      expect(streamCount(t)).toBeGreaterThan(TABLES[t].columns.length)
    }
  })

  it('exactly one table carries a TTL, and it declares its interval', () => {
    const withTtl = TABLES.filter((t) => t.ttl)
    expect(withTtl).toHaveLength(1)
    expect(withTtl[0].ttlSeconds).toBeGreaterThan(0)
  })

  it('a skip index never claims to prune everything', () => {
    for (const t of TABLES) {
      for (const idx of t.skipIndexes) {
        expect(idx.selectivity).toBeGreaterThan(0)
        expect(idx.selectivity).toBeLessThan(1)
        expect(idx.granularity).toBeGreaterThanOrEqual(1)
      }
    }
  })
})

describe('part naming', () => {
  it('renders the documented shape', () => {
    expect(partName('20260701', 5, 9, 2)).toBe('20260701_5_9_2')
    expect(partName('20260701', 5, 9, 2, 43)).toBe('20260701_5_9_2_43')
  })

  it('partition ids are eight digits and strictly increasing', () => {
    let prev = ''
    for (let i = 0; i < 12; i++) {
      const id = partitionId(i)
      expect(id).toMatch(/^\d{8}$/)
      if (prev) expect(Number(id)).toBeGreaterThan(Number(prev))
      prev = id
    }
  })

  it('markCount is ceil(rows / granularity) + 1', () => {
    expect(markCount(0, INDEX_GRANULARITY)).toBe(1)
    expect(markCount(1, INDEX_GRANULARITY)).toBe(2)
    expect(markCount(INDEX_GRANULARITY, INDEX_GRANULARITY)).toBe(2)
    expect(markCount(INDEX_GRANULARITY + 1, INDEX_GRANULARITY)).toBe(3)
  })

  it('the sharding hash spreads keys across shards', () => {
    const counts = [0, 0]
    for (let i = 0; i < 20000; i++) counts[shardHash(i) % 2]++
    // Not a statistical test, just a check that it is not degenerate: a hash
    // that sends everything to one shard would make the whole district a lie.
    expect(counts[0]).toBeGreaterThan(8000)
    expect(counts[1]).toBeGreaterThan(8000)
  })
})

describe('knobs and content', () => {
  it('every knob in the console exists in Knobs and has a default', () => {
    for (const m of KNOB_META) {
      expect(Object.prototype.hasOwnProperty.call(DEFAULT_KNOBS, m.key), `${String(m.key)} has no default`).toBe(true)
    }
  })

  it('every knob in Knobs is exposed in the console', () => {
    // A knob the model reads but the console never shows is a setting nobody can
    // find, which is the same as not having it.
    for (const key of Object.keys(DEFAULT_KNOBS) as (keyof Knobs)[]) {
      expect(knobMeta(key), `${String(key)} is not in KNOB_META`).toBeDefined()
    }
  })

  it('every knob default sits inside its own declared range', () => {
    for (const m of KNOB_META) {
      if (m.kind === 'toggle' || m.kind === 'select') continue
      const v = DEFAULT_KNOBS[m.key] as number
      expect(v, `${String(m.key)} default is below its min`).toBeGreaterThanOrEqual(m.min ?? -Infinity)
      expect(v, `${String(m.key)} default is above its max`).toBeLessThanOrEqual(m.max ?? Infinity)
    }
  })

  it('every select knob offers its own default as an option', () => {
    for (const m of KNOB_META) {
      if (m.kind !== 'select') continue
      const values = (m.options ?? []).map((o) => o.value)
      expect(values, `${String(m.key)} cannot select its default`).toContain(String(DEFAULT_KNOBS[m.key]))
    }
  })

  it('every doc id is unique', () => {
    const seen = new Set<string>()
    for (const d of DOCS) {
      expect(seen.has(d.id), `duplicate doc ${d.id}`).toBe(false)
      seen.add(d.id)
    }
  })

  it('every knob a doc references exists', () => {
    for (const d of DOCS) {
      for (const key of d.knobs ?? []) {
        expect(knobMeta(key), `doc ${d.id} references unknown knob ${String(key)}`).toBeDefined()
      }
    }
  })

  it('every "see also" points at a doc that exists', () => {
    for (const d of DOCS) {
      for (const other of d.see ?? []) {
        expect(doc(other), `doc ${d.id} links to unknown ${other}`).toBeDefined()
      }
    }
  })

  it('per-node component ids resolve to their family doc', () => {
    expect(doc('node.2.yard')?.id).toBe('node.yard')
    expect(doc('node.0.merges')?.id).toBe('node.merges')
    expect(doc('node.3')?.id).toBe('node')
    expect(doc('keeper.1')?.id).toBe('keeper.ensemble')
    expect(doc('nonsense.thing')).toBeUndefined()
  })

  it('every doc has a tldr, a subtitle and at least one section', () => {
    for (const d of DOCS) {
      expect(d.tldr.length, `${d.id} has no tldr`).toBeGreaterThan(10)
      expect(d.subtitle.length, `${d.id} has no subtitle`).toBeGreaterThan(4)
      expect(d.sections.length, `${d.id} has no sections`).toBeGreaterThan(0)
      for (const s of d.sections) expect(s.body.length, `${d.id}/${s.heading} is empty`).toBeGreaterThan(40)
    }
  })

  it('every reference that is a link has an absolute https URL', () => {
    for (const d of DOCS) {
      const refs = [...(d.refs?.docs ?? []), ...(d.refs?.source ?? []), ...(d.refs?.systemTables ?? [])]
      for (const r of refs) {
        expect(r.label.length).toBeGreaterThan(3)
        // A reference with no URL is deliberate — a system table has no page of
        // its own — but one WITH a url must be a real absolute link.
        if (r.url !== undefined) expect(r.url).toMatch(/^https:\/\//)
      }
    }
  })
})

describe('scenarios and the tour', () => {
  it('every scenario sets only real knobs', () => {
    for (const s of SCENARIOS) {
      for (const key of Object.keys(s.knobs) as (keyof Knobs)[]) {
        expect(
          Object.prototype.hasOwnProperty.call(DEFAULT_KNOBS, key),
          `scenario ${s.id} sets unknown knob ${String(key)}`,
        ).toBe(true)
      }
    }
  })

  it('every scenario id is unique and every one has beats', () => {
    const seen = new Set<string>()
    for (const s of SCENARIOS) {
      expect(seen.has(s.id), `duplicate scenario ${s.id}`).toBe(false)
      seen.add(s.id)
      expect(s.beats?.length ?? 0, `scenario ${s.id} narrates nothing`).toBeGreaterThan(0)
    }
  })

  it('scenario beats are ordered and fit inside the run', () => {
    for (const s of SCENARIOS) {
      let prev = -1
      for (const [at] of s.beats ?? []) {
        expect(at, `scenario ${s.id} has out-of-order beats`).toBeGreaterThan(prev)
        prev = at
        if (s.duration > 0) expect(at, `scenario ${s.id} beat is past its end`).toBeLessThan(s.duration)
      }
    }
  })

  it('every tour chapter sets only real knobs and has a body', () => {
    for (const c of CHAPTERS) {
      expect(c.body.length, `chapter ${c.id} has no body`).toBeGreaterThan(80)
      expect(c.duration).toBeGreaterThan(5)
      for (const key of Object.keys(c.knobs ?? {}) as (keyof Knobs)[]) {
        expect(
          Object.prototype.hasOwnProperty.call(DEFAULT_KNOBS, key),
          `chapter ${c.id} sets unknown knob ${String(key)}`,
        ).toBe(true)
      }
    }
  })

  it('every tour chapter and scenario focuses a component the world builds', () => {
    // The world registers per-node ids as `node.<n>.<part>`; the docs and the
    // tour name concrete instances, so these have to be checkable without a
    // renderer. Accept the shapes the world actually produces.
    const known = /^(cluster|clients(\.\w+)?|dist(\.\w+)?|keeper\.(ensemble|log|znodes|\d)|node\.\d(\.\w+)?)$/
    for (const c of CHAPTERS) {
      if (!c.focus) continue
      expect(c.focus, `chapter ${c.id} focuses ${c.focus}`).toMatch(known)
    }
    for (const s of SCENARIOS) {
      if (!s.focus) continue
      expect(s.focus, `scenario ${s.id} focuses ${s.focus}`).toMatch(known)
    }
  })
})
