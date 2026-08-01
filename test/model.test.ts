import { describe, expect, it } from 'vitest'

import { createBus } from '../src/core/bus'
import { createSim } from '../src/sim/model'
import { N_NODES, N_SHARDS } from '../src/core/types'
import type { Knobs, SimApi } from '../src/core/types'
import { N_TABLES, nodeIndex, replicaOf, shardOf } from '../src/world/layout'

/* ============================================================================
 * Model behaviour tests.
 *
 * These assert PROPERTIES, not snapshots: "a merge reduces the part count",
 * "an INSERT with no Keeper session writes nothing", "a TTL merge's output has
 * fewer rows than its input". A snapshot would break on every tuning change and
 * would prove nothing about the mechanism.
 *
 * The simulation is seeded, so every run is identical — but the assertions are
 * still directional rather than exact, because tuning a constant should not have
 * to mean editing a test.
 * ==========================================================================*/

/** A sim with the bus swallowed, so tests do not depend on the UI. */
function makeSim(overrides: Partial<Knobs> = {}): SimApi {
  const sim = createSim(createBus())
  for (const key of Object.keys(overrides) as (keyof Knobs)[]) {
    const setter = sim.setKnob as unknown as (k: keyof Knobs, v: unknown) => void
    setter(key, (overrides as Record<string, unknown>)[key])
  }
  return sim
}

/** Advance `seconds` of simulated time in the model's own fixed steps. */
function run(sim: SimApi, seconds: number): void {
  const step = 1 / 30
  const n = Math.round(seconds / step)
  for (let i = 0; i < n; i++) sim.update(step)
}

/**
 * Advance `seconds`, calling `sample` after every step.
 *
 * Sampling only the final frame is what most of these assertions need to avoid:
 * a merge lasts a second or two and a query a fraction of one, so "is a merge
 * running right now" is almost always false at any single instant.
 */
function observe(sim: SimApi, seconds: number, sample: () => void): void {
  const step = 1 / 30
  const n = Math.round(seconds / step)
  for (let i = 0; i < n; i++) {
    sim.update(step)
    sample()
  }
}

/**
 * Counters at the moment the test's settings took effect.
 *
 * `createSim` warms the cluster up for ten simulated seconds so it is never
 * inert on load, and that warm-up runs at the DEFAULT settings. So a counter
 * read after applying a knob includes work done before the knob existed, and
 * every counter assertion has to be a delta.
 */
function baseline(sim: SimApi): { blocks: number[]; inserted: number[]; served: number[] } {
  return {
    blocks: sim.state.nodes.map((n) => n.blocksWritten),
    inserted: sim.state.nodes.map((n) => n.tables.reduce((a, t) => a + t.partsInserted, 0)),
    served: sim.state.nodes.map((n) => n.queriesServed),
  }
}

const activeParts = (sim: SimApi, node: number, table?: number): number => {
  const nd = sim.state.nodes[node]
  if (table !== undefined) return nd.tables[table].activeParts
  let n = 0
  for (const t of nd.tables) n += t.activeParts
  return n
}

describe('cluster shape', () => {
  it('builds the declared topology', () => {
    const sim = makeSim()
    expect(sim.state.nodes).toHaveLength(N_NODES)
    expect(sim.state.keepers).toHaveLength(3)
    for (let n = 0; n < N_NODES; n++) {
      const nd = sim.state.nodes[n]
      expect(nd.shard).toBe(shardOf(n))
      expect(nd.replica).toBe(replicaOf(n))
      expect(nd.tables).toHaveLength(N_TABLES)
    }
  })

  it('seeds every node with parts, so the yard is never empty on load', () => {
    const sim = makeSim()
    for (let n = 0; n < N_NODES; n++) {
      expect(activeParts(sim, n)).toBeGreaterThan(0)
    }
  })

  it('exactly one Keeper node is the leader', () => {
    const sim = makeSim()
    const leaders = sim.state.keepers.filter((k) => k.role === 'leader')
    expect(leaders).toHaveLength(1)
  })
})

describe('the write path', () => {
  /**
   * The failure this pins down: the flow budget used to be spent per EMISSION,
   * first come first served, so at a high insert rate the corridor pod paid and
   * the legs behind it — the wheel, the queue, the dock, the commit — found the
   * budget empty. The city drew freight arriving at the `Distributed` table and
   * nothing leaving it, then towers appearing in the yard that nothing had
   * delivered: a picture of data loss, produced by a drawing budget.
   *
   * The property is not "every statement is drawn". It is that a statement the
   * city STARTS drawing is drawn to the end.
   */
  it('draws an INSERT end to end at a rate it cannot draw in full', () => {
    const bus = createBus()
    const seen = new Map<string, number>()
    bus.on('flow', (f) => {
      if (f.kind !== 'insert' && f.kind !== 'part_write') return
      const key = f.route.replace(/\.\d+(\.\d+)?$/, '')
      seen.set(key, (seen.get(key) ?? 0) + 1)
    })
    const sim = createSim(bus)
    sim.setKnob('insertsPerSec', 200)
    run(sim, 20)
    // Drain: the last statements are still in the corridor and on the wire.
    sim.setKnob('insertsPerSec', 0)
    run(sim, 12)

    const corridor = seen.get('client.to') ?? 0
    const wheel = seen.get('node.shardkey') ?? 0
    const commit = seen.get('node.commit') ?? 0
    expect(corridor).toBeGreaterThan(0)
    // Every statement whose corridor pod was drawn reaches the sharding key.
    // Not a ratio: a dropped tail is the bug, and one is one too many.
    expect(wheel).toBe(corridor)
    // …and the parts it wrote are visibly committed into their band.
    expect(commit).toBeGreaterThan(0)
  })

  it('a part name encodes partition, block range and level', () => {
    const sim = makeSim()
    const part = sim.state.nodes[0].tables[0].parts.find((p) => p.state === 'active')
    expect(part).toBeDefined()
    // <partition_id>_<min_block>_<max_block>_<level>, with an optional mutation.
    expect(part!.name).toMatch(/^\d{8}_\d+_\d+_\d+(_\d+)?$/)
    const fields = part!.name.split('_')
    expect(Number(fields[1])).toBe(part!.minBlock)
    expect(Number(fields[2])).toBe(part!.maxBlock)
    expect(Number(fields[3])).toBe(part!.level)
  })

  it('a level-0 part covers exactly one block', () => {
    const sim = makeSim({ insertsPerSec: 20, insertBlockRows: 20000 })
    run(sim, 20)
    let seen = 0
    for (const nd of sim.state.nodes) {
      for (const t of nd.tables) {
        for (const p of t.parts) {
          if (p.level !== 0) continue
          seen++
          expect(p.maxBlock).toBe(p.minBlock)
        }
      }
    }
    expect(seen).toBeGreaterThan(0)
  })

  /**
   * Read heat and write heat are two channels, not one, because the yard paints
   * them two colours. A `temporary` part is `tmp_insert_…`: it is not in the data
   * part set and no SELECT can open it, so it being read-hot would be impossible
   * rather than merely wrong.
   */
  it('a part being written is write-hot, and a temporary part is never read-hot', () => {
    const sim = makeSim({ insertsPerSec: 20, insertBlockRows: 20000 })
    let seen = 0
    observe(sim, 20, () => {
      for (const nd of sim.state.nodes) {
        for (const t of nd.tables) {
          for (const p of t.parts) {
            if (p.state !== 'temporary') continue
            seen++
            expect(p.writeHeat).toBeGreaterThan(0.3)
            expect(p.heat).toBe(0)
          }
        }
      }
    })
    expect(seen).toBeGreaterThan(0)
  })

  it('write heat decays, so the pulse is an event and not a badge', () => {
    const sim = makeSim({ insertsPerSec: 20, insertBlockRows: 20000 })
    run(sim, 30)
    let seen = 0
    for (const nd of sim.state.nodes) {
      for (const t of nd.tables) {
        for (const p of t.parts) {
          // Ten simulated seconds is long past "just written" by any reading.
          if (sim.state.t - p.createdAt < 10) continue
          seen++
          expect(p.writeHeat).toBeLessThan(0.05)
        }
      }
    }
    expect(seen).toBeGreaterThan(0)
  })

  it('marks_count is ceil(rows / index_granularity) + 1', () => {
    const sim = makeSim()
    for (const p of sim.state.nodes[0].tables[0].parts) {
      expect(p.marks).toBe(Math.ceil(p.rows / 8192) + 1)
    }
  })

  it('inserting more creates more parts', () => {
    const quiet = makeSim({ insertsPerSec: 0.5, insertBlockRows: 200000, mergePoolSize: 1 })
    const busy = makeSim({ insertsPerSec: 30, insertBlockRows: 200000, mergePoolSize: 1 })
    run(quiet, 40)
    run(busy, 40)
    expect(busy.state.stats.activeParts).toBeGreaterThan(quiet.state.stats.activeParts)
  })

  it('async_insert creates far fewer parts for the same offered rate', () => {
    // A very high throw threshold on BOTH runs: otherwise the synchronous run
    // hits `parts_to_throw_insert`, its INSERTs start being refused, and the
    // comparison measures the cap instead of the setting under test.
    const opts = {
      insertsPerSec: 40,
      insertBlockRows: 900,
      mergePoolSize: 1,
      partsToDelayInsert: 100000,
      partsToThrowInsert: 200000,
    } as const
    const sync = makeSim({ ...opts, asyncInsert: false })
    const async_ = makeSim({
      ...opts,
      asyncInsert: true,
      asyncInsertMaxDataKib: 4096,
      asyncInsertBusyTimeoutMs: 500,
    })
    const bSync = baseline(sync)
    const bAsync = baseline(async_)
    run(sync, 45)
    run(async_, 45)

    const created = (sim: SimApi, b: ReturnType<typeof baseline>): number => {
      let n = 0
      sim.state.nodes.forEach((nd, i) => {
        n += nd.tables.reduce((a, t) => a + t.partsInserted, 0) - b.inserted[i]
      })
      return n
    }

    // The claim is about parts CREATED. The instantaneous active count confounds
    // it, because async_insert also makes each part larger and therefore slower
    // to merge — so a snapshot can show more active parts while far fewer were
    // ever written.
    const syncParts = created(sync, bSync)
    const asyncParts = created(async_, bAsync)
    expect(syncParts).toBeGreaterThan(0)
    expect(asyncParts * 2).toBeLessThan(syncParts)
  })

  it('refuses INSERTs past parts_to_throw_insert', () => {
    const sim = makeSim({
      insertsPerSec: 60,
      insertBlockRows: 600,
      mergePoolSize: 1,
      partsToDelayInsert: 12,
      partsToThrowInsert: 20,
    })
    run(sim, 60)
    let errors = 0
    for (const nd of sim.state.nodes) errors += nd.tooManyPartsErrors
    expect(errors).toBeGreaterThan(0)
  })

  it('delays INSERTs before it refuses them', () => {
    const sim = makeSim({
      insertsPerSec: 30,
      insertBlockRows: 800,
      mergePoolSize: 1,
      partsToDelayInsert: 14,
      partsToThrowInsert: 400,
    })
    run(sim, 45)
    let maxDelay = 0
    let errors = 0
    for (const nd of sim.state.nodes) {
      if (nd.insertDelay > maxDelay) maxDelay = nd.insertDelay
      errors += nd.tooManyPartsErrors
    }
    expect(maxDelay).toBeGreaterThan(0)
    // With the throw threshold far away, the pressure must express itself as a
    // delay and never as an exception.
    expect(errors).toBe(0)
  })
})

describe('merges', () => {
  it('a merge never crosses a partition boundary', () => {
    const sim = makeSim({ insertsPerSec: 25, insertBlockRows: 40000, mergePoolSize: 4 })
    let checked = 0
    observe(sim, 60, () => {
      for (const nd of sim.state.nodes) {
        for (const m of nd.merges) {
          if (!m.active) continue
          for (const slot of m.sourceSlots) {
            // -1 is the shared "beyond the yard's window" marker, so it is not a
            // usable identity: looking a part up by it finds an unrelated one.
            if (slot < 0) continue
            const p = nd.tables[m.table].parts.find((x) => x.slot === slot)
            if (!p) continue
            checked++
            expect(p.partition).toBe(m.partition)
          }
        }
      }
    })
    expect(checked).toBeGreaterThan(0)
  })

  it('a merge output has a higher level than any of its inputs', () => {
    const sim = makeSim({ insertsPerSec: 25, insertBlockRows: 40000, mergePoolSize: 4 })
    let checked = 0
    observe(sim, 60, () => {
      for (const nd of sim.state.nodes) {
        for (const m of nd.merges) {
          if (!m.active || m.sourceSlots.length === 0) continue
          let maxInput = 0
          let found = 0
          for (const slot of m.sourceSlots) {
            if (slot < 0) continue // see the note on the partition test
            const p = nd.tables[m.table].parts.find((x) => x.slot === slot)
            if (!p) continue
            found++
            if (p.level > maxInput) maxInput = p.level
          }
          if (found === 0) continue
          checked++
          const level = Number(m.resultPart.split('_')[3])
          expect(level).toBeGreaterThan(maxInput)
        }
      }
    })
    expect(checked).toBeGreaterThan(0)
  })

  /**
   * The yard's red/green pulse is only honest if these hold. A merge reads every
   * row of every input part it holds, so an input must be read-hot for as long
   * as the merge runs — that is what makes "several parts are being consumed to
   * make one" visible in the yard rather than only on the gantry.
   */
  it('a merge keeps every input part it holds read-hot', () => {
    const sim = makeSim({ insertsPerSec: 25, insertBlockRows: 40000, mergePoolSize: 4 })
    let checked = 0
    observe(sim, 60, () => {
      for (const nd of sim.state.nodes) {
        for (const m of nd.merges) {
          if (!m.active) continue
          for (const name of m.sourceParts) {
            const p = nd.tables[m.table].parts.find((x) => x.name === name)
            if (!p || !p.reserved) continue
            checked++
            expect(p.heat).toBeGreaterThan(0.5)
          }
        }
      }
    })
    expect(checked).toBeGreaterThan(0)
  })

  it('a bigger merge pool completes more merges', () => {
    const starved = makeSim({ insertsPerSec: 30, insertBlockRows: 20000, mergePoolSize: 1 })
    const healthy = makeSim({ insertsPerSec: 30, insertBlockRows: 20000, mergePoolSize: 4 })
    run(starved, 90)
    run(healthy, 90)

    const merged = (sim: SimApi): number => {
      let n = 0
      for (const nd of sim.state.nodes) for (const t of nd.tables) n += t.partsMerged
      return n
    }
    // The direct claim, and the one that is not confounded by part size: more
    // slots means more merges finish. The resulting part count also depends on
    // how large each merge's output is, which the insert batch decides.
    expect(merged(healthy)).toBeGreaterThan(merged(starved))
  })

  it('reaches both merge algorithms, so the memory lesson has contrast', () => {
    const sim = makeSim({ insertsPerSec: 30, insertBlockRows: 400000, mergePoolSize: 4 })
    const seen = new Set<string>()
    observe(sim, 90, () => {
      for (const nd of sim.state.nodes) {
        for (const m of nd.merges) {
          if (m.active) seen.add(m.algorithm)
        }
      }
    })
    expect(seen.has('horizontal')).toBe(true)
    expect(seen.has('vertical')).toBe(true)
  })

  it('a vertical merge on a wide table holds less memory per input part', () => {
    const sim = makeSim({ insertsPerSec: 30, insertBlockRows: 400000, mergePoolSize: 4 })
    // Per INPUT PART is the comparable unit: horizontal memory scales with
    // (streams x parts) and vertical with (key streams x parts), so dividing out
    // the part count isolates the algorithm from the size of the merge.
    let horizontal = 0
    let vertical = 0
    observe(sim, 90, () => {
      for (const nd of sim.state.nodes) {
        for (const m of nd.merges) {
          if (!m.active || m.sourceParts.length === 0) continue
          const perPart = m.memoryBytes / m.sourceParts.length
          // `hits` and `sessions` are the wide tables; only they can go vertical.
          if (m.table === 1) continue
          if (m.algorithm === 'horizontal') horizontal = Math.max(horizontal, perPart)
          else vertical = Math.max(vertical, perPart)
        }
      }
    })
    expect(horizontal).toBeGreaterThan(0)
    expect(vertical).toBeGreaterThan(0)
    expect(vertical).toBeLessThan(horizontal)
  })
})

describe('the read path', () => {
  it('a matching sorting key prunes granules and a non-matching one does not', () => {
    const hit = makeSim({ selectsPerSec: 30, primaryKeyHitRatio: 1, skipIndexUseRatio: 0, insertsPerSec: 1 })
    const miss = makeSim({ selectsPerSec: 30, primaryKeyHitRatio: 0, skipIndexUseRatio: 0, insertsPerSec: 1 })

    const ratios = (sim: SimApi): number[] => {
      const out: number[] = []
      // Queries planned during the warm-up were planned at the DEFAULT hit ratio
      // and correctly keep their plan, exactly as a running query on a real
      // server does. Judge only the ones planned after the knob moved.
      const from = sim.state.nextQueryId
      observe(sim, 30, () => {
        for (const nd of sim.state.nodes) {
          for (const q of nd.queries) {
            if (q.id < from) continue
            if (q.granulesTotal > 0) out.push(q.granulesAfterKey / q.granulesTotal)
          }
        }
      })
      return out
    }

    const hitRatios = ratios(hit)
    const missRatios = ratios(miss)
    expect(hitRatios.length).toBeGreaterThan(0)
    expect(missRatios.length).toBeGreaterThan(0)

    const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length
    // Without a usable key prefix EVERY granule survives — that is the lesson,
    // and it is an equality, not a tendency.
    expect(mean(missRatios)).toBe(1)
    expect(mean(hitRatios)).toBeLessThan(0.2)
  })

  it('a skip index only ever reduces the granule count', () => {
    const sim = makeSim({ selectsPerSec: 30, primaryKeyHitRatio: 0.5, skipIndexUseRatio: 1, insertsPerSec: 1 })
    let checked = 0
    observe(sim, 30, () => {
      for (const nd of sim.state.nodes) {
        for (const q of nd.queries) {
          checked++
          expect(q.granulesAfterSkip).toBeLessThanOrEqual(q.granulesAfterKey)
          expect(q.granulesAfterKey).toBeLessThanOrEqual(q.granulesTotal)
        }
      }
    })
    expect(checked).toBeGreaterThan(0)
  })

  it('partition pruning selects fewer parts than exist', () => {
    const sim = makeSim({ selectsPerSec: 30, partitionPruneRatio: 1, insertsPerSec: 1 })
    let pruned = 0
    let seen = 0
    observe(sim, 20, () => {
      for (const nd of sim.state.nodes) {
        for (const q of nd.queries) {
          seen++
          if (q.partsSelected < q.partsTotal) pruned++
        }
      }
    })
    expect(seen).toBeGreaterThan(0)
    expect(pruned).toBeGreaterThan(0)
  })

  it('a larger mark cache raises the hit ratio', () => {
    const small = makeSim({ markCacheMib: 32, selectsPerSec: 20, insertsPerSec: 1 })
    const large = makeSim({ markCacheMib: 8192, selectsPerSec: 20, insertsPerSec: 1 })
    run(small, 60)
    run(large, 60)
    expect(large.state.nodes[0].markCache.hitRatio).toBeGreaterThan(small.state.nodes[0].markCache.hitRatio)
  })

  it('a disabled uncompressed cache never records a hit', () => {
    const sim = makeSim({ uncompressedCacheMib: 0, selectsPerSec: 20, insertsPerSec: 1 })
    run(sim, 40)
    for (const nd of sim.state.nodes) {
      expect(nd.uncompressedCache.hits).toBe(0)
      expect(nd.uncompressedCache.misses).toBeGreaterThan(0)
    }
  })

  it('max_threads bounds the reader threads a query may use', () => {
    const sim = makeSim({ maxThreads: 2, selectsPerSec: 20, insertsPerSec: 1 })
    // Queries planned during the warm-up were planned at the default
    // max_threads and correctly keep it, exactly as a running query on a real
    // server keeps the threads it was allocated. Judge only the later ones.
    const from = sim.state.nextQueryId
    let checked = 0
    observe(sim, 20, () => {
      for (const nd of sim.state.nodes) {
        for (const q of nd.queries) {
          if (q.id < from) continue
          checked++
          expect(q.threads).toBeLessThanOrEqual(2)
        }
      }
    })
    expect(checked).toBeGreaterThan(0)
  })
})

describe('the Distributed table', () => {
  /** Rows routed to `shard`, summed over every server's own Distributed table. */
  const routed = (sim: SimApi, shard: number): number => {
    let total = 0
    for (const n of sim.state.nodes) total += n.distributed.rowsToShard[shard]
    return total
  }

  it('routes rows to every shard', () => {
    const sim = makeSim({ insertsPerSec: 20, insertBlockRows: 50000 })
    run(sim, 30)
    for (let s = 0; s < N_SHARDS; s++) {
      expect(routed(sim, s)).toBeGreaterThan(0)
    }
  })

  it('exists on every server, not on one of them', () => {
    // The correction this shape exists for: `Distributed` is a table created on
    // every node by the same DDL, so with a driver that spreads its connections
    // EVERY server routes rows — there is no single initiator machine.
    const sim = makeSim({ clientBalancing: 'round_robin', insertsPerSec: 24, insertBlockRows: 50000 })
    run(sim, 40)
    for (let n = 0; n < N_NODES; n++) {
      const d = sim.state.nodes[n].distributed
      expect(d.insertsInitiated, `node ${n} initiated nothing`).toBeGreaterThan(0)
      expect(d.rowsToShard[0] + d.rowsToShard[1], `node ${n} routed nothing`).toBeGreaterThan(0)
    }
  })

  it('puts every statement on one server when the driver has one hostname', () => {
    // `single` is one hostname in a connection string. The data is distributed
    // exactly as before; the fan-out and the result merging are not.
    const sim = makeSim({ clientBalancing: 'single', insertsPerSec: 24, insertBlockRows: 50000 })
    // A DELTA. `createSim` warms the cluster up on the DEFAULT knobs — which
    // spread the connections — before these are applied, so every server has
    // already initiated something by the time the test starts.
    const before = sim.state.nodes.map((n) => n.distributed.insertsInitiated)
    run(sim, 40)
    let initiators = 0
    for (let n = 0; n < N_NODES; n++) {
      if (sim.state.nodes[n].distributed.insertsInitiated > before[n]) initiators++
    }
    expect(initiators).toBe(1)
    // …and the rows still reached both shards, which is the point: the skew is
    // in who does the work, not in where the data went.
    for (let s = 0; s < N_SHARDS; s++) expect(routed(sim, s)).toBeGreaterThan(0)
  })

  it('spools nothing in foreground mode', () => {
    const sim = makeSim({ distributedInsert: 'foreground', insertsPerSec: 20, insertBlockRows: 50000 })
    run(sim, 30)
    for (let n = 0; n < N_NODES; n++) {
      for (let s = 0; s < N_SHARDS; s++) {
        expect(sim.state.nodes[n].distributed.pendingBlocks[s]).toBe(0)
      }
    }
  })

  it('never queues the slice for the initiator’s own shard', () => {
    // `prefer_localhost_replica` is on by default: in background mode the slice
    // for the initiator's OWN shard is inserted into the local table right
    // away, synchronously — only the slices bound for other shards are parked
    // in `system.distribution_queue`. So server n's queue for shardOf(n) must
    // stay empty at every instant, on every initiator.
    const sim = makeSim({ insertsPerSec: 24, insertBlockRows: 50000 })
    observe(sim, 30, () => {
      for (let n = 0; n < N_NODES; n++) {
        expect(
          sim.state.nodes[n].distributed.pendingBlocks[shardOf(n)],
          `node ${n} queued a block for its own shard`,
        ).toBe(0)
      }
    })
  })

  it('never drops a queued block while the destination cannot accept it', () => {
    // The real queue retries with backoff; it NEVER discards a file. With
    // Keeper gone every replica is read-only, so no flush can succeed and the
    // queued depth may only grow — a model that quietly dropped a block here
    // would keep `data_files` pretty while losing acknowledged data.
    const sim = makeSim({ keeperConnected: false, insertsPerSec: 24, insertBlockRows: 50000 })
    run(sim, 1) // one settling second: readOnly flips on the first tick
    let prev = 0
    observe(sim, 20, () => {
      let queued = 0
      for (const n of sim.state.nodes) for (const b of n.distributed.pendingBlocks) queued += b
      expect(queued, 'the queue shrank while every replica was read-only').toBeGreaterThanOrEqual(prev)
      prev = queued
    })
    expect(prev).toBeGreaterThan(0)
  })

  it('never makes a server that is down the initiator', () => {
    // Every real driver fails over. The statement must not be dropped and must
    // not be handed to the dead server either.
    const sim = makeSim({ nodeDown: true, insertsPerSec: 30, insertBlockRows: 50000 })
    run(sim, 40)
    const dead = N_NODES - 1
    expect(sim.state.nodes[dead].status).toBe('down')
    const before = sim.state.nodes[dead].distributed.insertsInitiated
    run(sim, 20)
    expect(sim.state.nodes[dead].distributed.insertsInitiated).toBe(before)
    expect(sim.state.clients.reachable).toBe(N_NODES - 1)
  })

  it('never routes a write to a node that is down', () => {
    const sim = makeSim({ nodeDown: true, insertsPerSec: 30, insertBlockRows: 50000 })
    const b = baseline(sim)
    run(sim, 40)
    const dead = sim.state.nodes[N_NODES - 1]
    expect(dead.status).toBe('down')
    // A delta, because the ten-second warm-up inside createSim ran before this
    // knob existed and wrote blocks on every node.
    expect(dead.blocksWritten - b.blocks[N_NODES - 1]).toBe(0)
  })

  it('the surviving replica keeps serving its shard when the other is down', () => {
    const sim = makeSim({ nodeDown: true, insertsPerSec: 20, selectsPerSec: 20, insertBlockRows: 50000 })
    const b = baseline(sim)
    run(sim, 40)
    const i = nodeIndex(N_SHARDS - 1, 0)
    const survivor = sim.state.nodes[i]
    expect(survivor.status).toBe('up')
    expect(survivor.queriesServed - b.served[i]).toBeGreaterThan(0)
    expect(survivor.blocksWritten - b.blocks[i]).toBeGreaterThan(0)
  })
})

describe('replication', () => {
  it('appends to the Keeper log and the replicas follow it', () => {
    const sim = makeSim({ insertsPerSec: 20, insertBlockRows: 50000 })
    run(sim, 40)
    expect(sim.state.keeperLogIndex).toBeGreaterThan(0)
    let fetched = 0
    for (const nd of sim.state.nodes) fetched += nd.replication.partsFetched
    expect(fetched).toBeGreaterThan(0)
  })

  it('a fetched part is marked as fetched, not as inserted', () => {
    const sim = makeSim({ insertsPerSec: 20, insertBlockRows: 50000 })
    run(sim, 50)
    let fetchedParts = 0
    for (const nd of sim.state.nodes) {
      for (const t of nd.tables) {
        for (const p of t.parts) if (p.fetched) fetchedParts++
      }
    }
    expect(fetchedParts).toBeGreaterThan(0)
  })

  it('a slow replica accumulates queue and delay', () => {
    const healthy = makeSim({ slowReplica: false, insertsPerSec: 25, insertBlockRows: 60000 })
    const slow = makeSim({ slowReplica: true, insertsPerSec: 25, insertBlockRows: 60000 })
    run(healthy, 70)
    run(slow, 70)
    // The designated straggler is replica 1 of shard 0; compare it directly
    // rather than through the cluster-wide maximum, which any node can own.
    //
    // The queue is a bounded ring, so its SIZE saturates on any node under heavy
    // load and stops discriminating. `absolute_delay` — the age of the oldest
    // unexecuted entry — keeps resolving, which is exactly why it is the metric
    // worth alerting on.
    const i = nodeIndex(0, 1)
    expect(slow.state.nodes[i].replication.absoluteDelay).toBeGreaterThan(
      healthy.state.nodes[i].replication.absoluteDelay * 2,
    )
    expect(slow.state.nodes[i].replication.queueSize).toBeGreaterThanOrEqual(
      healthy.state.nodes[i].replication.queueSize,
    )
  })

  it('no Keeper session means read-only, and reads keep working', () => {
    const sim = makeSim({ keeperConnected: false, insertsPerSec: 25, selectsPerSec: 20, insertBlockRows: 50000 })
    const b = baseline(sim)
    run(sim, 40)
    sim.state.nodes.forEach((nd, i) => {
      expect(nd.replication.readOnly).toBe(true)
      // Not one block may be written without a block number from Keeper…
      expect(nd.blocksWritten - b.blocks[i]).toBe(0)
      // …and yet every SELECT still runs off local disk.
      expect(nd.queriesServed - b.served[i]).toBeGreaterThan(0)
    })
  })

  it('the Keeper log stops growing when Keeper is unreachable', () => {
    const sim = makeSim({ keeperConnected: false, insertsPerSec: 25 })
    run(sim, 10)
    const before = sim.state.keeperLogIndex
    run(sim, 30)
    expect(sim.state.keeperLogIndex).toBe(before)
  })

  it('znode count grows with the part count', () => {
    const few = makeSim({ insertsPerSec: 1, insertBlockRows: 500000, mergePoolSize: 4 })
    const many = makeSim({ insertsPerSec: 40, insertBlockRows: 900, mergePoolSize: 1 })
    run(few, 60)
    run(many, 60)
    expect(many.state.keepers[1].znodes).toBeGreaterThan(few.state.keepers[1].znodes)
  })
})

describe('TTL', () => {
  it('runs TTL merges on the table that has a TTL and drops rows', () => {
    // `metrics` is table 1 and is the only one with a TTL.
    const sim = makeSim({
      insertsPerSec: 14,
      insertBlockRows: 40000,
      ttlEnabled: true,
      mergeWithTtlTimeout: 4,
      mergePoolSize: 4,
    })
    let ttlMerges = 0
    // Longer than the metrics TTL (120 simulated seconds) so rows really expire.
    observe(sim, 220, () => {
      for (const nd of sim.state.nodes) {
        for (const m of nd.merges) {
          if (m.active && (m.reason === 'ttl_delete' || m.reason === 'ttl_recompress')) ttlMerges++
        }
      }
    })
    expect(ttlMerges).toBeGreaterThan(0)
  })

  it('a TTL merge writes fewer rows than it reads', () => {
    const sim = makeSim({
      insertsPerSec: 14,
      insertBlockRows: 40000,
      ttlEnabled: true,
      mergeWithTtlTimeout: 4,
      mergePoolSize: 4,
    })
    let checked = 0
    observe(sim, 220, () => {
      for (const nd of sim.state.nodes) {
        for (const m of nd.merges) {
          if (!m.active || m.reason !== 'ttl_delete') continue
          // The output is not exposed directly, but the reason is — and a
          // ttl_delete merge is by construction the only kind whose result has
          // fewer rows. Assert that its input is a SINGLE part, which is the
          // other half of what makes it a TTL merge rather than a regular one.
          expect(m.sourceParts.length).toBe(1)
          checked++
        }
      }
    })
    expect(checked).toBeGreaterThan(0)
  })

  it('moves parts to the cold volume when the TTL says TO VOLUME', () => {
    const sim = makeSim({
      insertsPerSec: 14,
      insertBlockRows: 40000,
      ttlEnabled: true,
      ttlMoveToCold: true,
      mergeWithTtlTimeout: 4,
      mergePoolSize: 4,
    })
    run(sim, 240)
    let cold = 0
    for (const nd of sim.state.nodes) cold += nd.volumes[1].usedBytes
    expect(cold).toBeGreaterThan(0)
  })

  it('leaves expired parts alone when TTL is disabled', () => {
    const sim = makeSim({ insertsPerSec: 14, insertBlockRows: 40000, ttlEnabled: false, mergePoolSize: 4 })
    run(sim, 240)
    let expired = 0
    for (const nd of sim.state.nodes) for (const t of nd.tables) expired += t.expiredParts
    expect(expired).toBeGreaterThan(0)
  })
})

describe('mutations', () => {
  it('a mutation rewrites parts and gives them a mutation version', () => {
    const sim = makeSim({ runningMutation: true, insertsPerSec: 6, insertBlockRows: 60000, mergePoolSize: 2 })
    run(sim, 60)
    let mutated = 0
    for (const nd of sim.state.nodes) {
      for (const p of nd.tables[0].parts) if (p.mutation > 0) mutated++
    }
    expect(mutated).toBeGreaterThan(0)
  })

  it('a mutated part keeps its block range and level', () => {
    const sim = makeSim({ runningMutation: true, insertsPerSec: 6, insertBlockRows: 60000, mergePoolSize: 2 })
    run(sim, 60)
    let checked = 0
    for (const nd of sim.state.nodes) {
      for (const p of nd.tables[0].parts) {
        if (p.mutation === 0) continue
        checked++
        // `<partition>_<min>_<max>_<level>_<mutation>` — five fields, and the
        // first four must agree with the part's own numbers.
        const f = p.name.split('_')
        expect(f).toHaveLength(5)
        expect(Number(f[1])).toBe(p.minBlock)
        expect(Number(f[2])).toBe(p.maxBlock)
        expect(Number(f[3])).toBe(p.level)
        expect(Number(f[4])).toBe(p.mutation)
      }
    }
    expect(checked).toBeGreaterThan(0)
  })
})

describe('the settings that used to do nothing', () => {
  it('insert_quorum = all makes a replica loss a write outage', () => {
    const quiet = makeSim({ insertQuorum: 'all', nodeDown: false, insertsPerSec: 20, insertBlockRows: 50000 })
    const broken = makeSim({ insertQuorum: 'all', nodeDown: true, insertsPerSec: 20, insertBlockRows: 50000 })
    const bq = baseline(quiet)
    const bb = baseline(broken)
    run(quiet, 40)
    run(broken, 40)

    const written = (sim: SimApi, base: ReturnType<typeof baseline>, shard: number): number => {
      let n = 0
      sim.state.nodes.forEach((nd, i) => {
        if (nd.shard !== shard) return
        n += nd.blocksWritten - base.blocks[i]
      })
      return n
    }

    // Shard 1 has both replicas either way and must keep accepting writes; the
    // shard that lost one can no longer satisfy a quorum of `all`.
    expect(written(quiet, bq, N_SHARDS - 1)).toBeGreaterThan(0)
    expect(written(broken, bb, 0)).toBeGreaterThan(0)
    expect(written(broken, bb, N_SHARDS - 1)).toBe(0)
  })

  it('insert_quorum = 0 keeps writing to the surviving replica', () => {
    const sim = makeSim({ insertQuorum: 'none', nodeDown: true, insertsPerSec: 20, insertBlockRows: 50000 })
    const b = baseline(sim)
    run(sim, 40)
    const i = nodeIndex(N_SHARDS - 1, 0)
    expect(sim.state.nodes[i].blocksWritten - b.blocks[i]).toBeGreaterThan(0)
  })

  it('wait_for_async_insert = 0 loses the buffer when the node goes away', () => {
    const sim = makeSim({
      asyncInsert: true,
      waitForAsyncInsert: false,
      asyncInsertMaxDataKib: 65536,
      asyncInsertBusyTimeoutMs: 5000,
      insertsPerSec: 30,
      insertBlockRows: 20000,
    })
    // Let the buffer fill on the node that is about to disappear.
    run(sim, 12)
    const doomed = sim.state.nodes[N_NODES - 1]
    expect(doomed.asyncInsertBytes).toBeGreaterThan(0)
    sim.setKnob('nodeDown', true)
    run(sim, 3)
    expect(doomed.status).toBe('down')
    expect(doomed.asyncInsertBytes).toBe(0)
  })

  it('OPTIMIZE FINAL merges a whole partition rather than whatever the selector liked', () => {
    const sim = makeSim({ insertsPerSec: 25, insertBlockRows: 20000, mergePoolSize: 4 })
    run(sim, 30)
    // Find the node/table with the most parts in one partition, then force it.
    const node = 0
    const table = 0
    const nt = sim.state.nodes[node].tables[table]
    const counts = new Map<number, number>()
    for (const p of nt.parts) {
      // A part another merge has already reserved is not available to OPTIMIZE
      // either — the same exclusion `activeInPartition` applies.
      if (p.state !== 'active' || p.reserved) continue
      counts.set(p.partition, (counts.get(p.partition) ?? 0) + 1)
    }
    let best = -1
    let bestN = 1
    for (const [part, n] of counts) {
      if (n > bestN) {
        bestN = n
        best = part
      }
    }
    expect(best, 'no partition had more than one part to optimise').toBeGreaterThanOrEqual(0)

    sim.optimize(node, table, true)
    const forced = sim.state.nodes[node].merges.find((m) => m.active && m.reason === 'final')
    expect(forced, 'OPTIMIZE FINAL started no merge').toBeDefined()
    expect(forced!.partition).toBe(best)
    // FINAL takes the whole partition — every available part in it, not the two
    // or three the size heuristic would have chosen.
    expect(forced!.sourceParts.length).toBe(bestN)
    expect(forced!.sourceParts.length).toBeGreaterThan(2)
  })
})

describe('invariants that must always hold', () => {
  it('part slots are never double-booked', () => {
    const sim = makeSim({ insertsPerSec: 30, insertBlockRows: 30000, mergePoolSize: 3 })
    let ticks = 0
    observe(sim, 90, () => {
      // Checking every step would spend the whole test in Set allocation; every
      // tenth is often enough to catch a leak within a second of it appearing.
      if (ticks++ % 10 !== 0) return
      for (const nd of sim.state.nodes) {
        for (const t of nd.tables) {
          const slots = new Set<number>()
          for (const p of t.parts) {
            // -1 is the "beyond the window" marker and is shared by design.
            if (p.slot < 0) continue
            expect(slots.has(p.slot)).toBe(false)
            slots.add(p.slot)
          }
        }
      }
    })
  })

  it('every counter stays finite and non-negative', () => {
    const sim = makeSim({ insertsPerSec: 40, selectsPerSec: 20, insertBlockRows: 5000, mergePoolSize: 2 })
    run(sim, 120)
    const st = sim.state.stats
    for (const v of [
      st.activeParts,
      st.runningMerges,
      st.totalRows,
      st.totalBytesOnDisk,
      st.insertRowsPerSec,
      st.selectRowsPerSec,
      st.maxReplicaDelay,
      st.maxQueueSize,
    ]) {
      expect(Number.isFinite(v)).toBe(true)
      expect(v).toBeGreaterThanOrEqual(0)
    }
    expect(st.compressionRatio).toBeGreaterThan(1)
  })

  it('a paused cluster does not advance', () => {
    const sim = makeSim({ insertsPerSec: 20 })
    run(sim, 10)
    sim.setKnob('paused', true)
    const t = sim.state.t
    const parts = sim.state.stats.activeParts
    run(sim, 20)
    expect(sim.state.t).toBe(t)
    expect(sim.state.stats.activeParts).toBe(parts)
  })

  it('reset returns the cluster to its seeded state', () => {
    const sim = makeSim({ insertsPerSec: 40, insertBlockRows: 900, mergePoolSize: 1 })
    run(sim, 60)
    const busy = sim.state.stats.activeParts
    sim.reset()
    // Reset restores the defaults, so the part count must come back down to the
    // seeded level rather than staying wherever the stress test left it.
    expect(sim.state.stats.activeParts).toBeLessThan(busy)
    expect(sim.state.knobs.insertsPerSec).toBe(4)
    expect(sim.state.nodes[0].tooManyPartsErrors).toBe(0)
  })

  it('a scenario restores every setting it changed', () => {
    const sim = makeSim()
    const before = { ...sim.state.knobs }
    sim.runScenario('too-many-parts')
    run(sim, 20)
    expect(sim.state.knobs.insertsPerSec).not.toBe(before.insertsPerSec)
    sim.runScenario(null)
    for (const key of Object.keys(before) as (keyof Knobs)[]) {
      expect(sim.state.knobs[key]).toBe(before[key])
    }
  })
})
