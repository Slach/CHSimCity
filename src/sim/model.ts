/* ============================================================================
 * CHSimCity — THE SIMULATION
 *
 * This file is the engine. Everything the cluster draws is a projection of the
 * state produced here, so the rules below are meant to be *true*, not pretty:
 * a part really is written to a temporary directory and renamed into place, the
 * merge selector really does refuse to merge across a partition boundary, the
 * primary index really is sparse and really is searched for mark ranges, a TTL
 * merge really does rewrite a part rather than delete rows in place, and a
 * `MERGE_PARTS` log entry really does make the sibling replica do the merge
 * itself instead of copying the result.
 *
 * THREE HONEST DISTORTIONS, all deliberate:
 *
 *  1. TIME IS STRETCHED for anything sub-second, and COMPRESSED for anything
 *     measured in hours. A real mark lookup is ~200 ns and a real TTL is days;
 *     at 60 fps you would see neither. Every duration here is a monotone
 *     stretch or squeeze of the real one, so the *shape* is faithful — a
 *     horizontal merge on a wide table costs far more memory than a vertical
 *     one, a `set` index prunes far less than a correlated `minmax` — while the
 *     absolute numbers are theatre. Rates (rows/sec, bytes/sec, parts) are NOT
 *     rescaled; those are reported in real units.
 *
 *  2. THE CLUSTER IS A SCALE MODEL. Four data nodes, three Keeper nodes, at
 *     most 96 visible parts per table per node, eight reader threads. A real
 *     node holds thousands of parts; the yard is a window onto the newest ones
 *     and the counters report the true total.
 *
 *  3. GRANULES ARE COUNTED, NOT SIMULATED. A query's cost is derived from how
 *     many index granules survive partition pruning, the primary key and the
 *     skip indexes — which is exactly the arithmetic ClickHouse itself does in
 *     `MergeTreeDataSelectExecutor` — but the rows inside a granule are never
 *     materialised. Nothing here parses SQL, and no byte of ClickHouse source
 *     code runs in your browser.
 * ==========================================================================*/

import {
  COMPRESS_BLOCK_BYTES,
  currentTask,
  DEFAULT_KNOBS,
  INDEX_GRANULARITY,
  MAX_READ_TASKS,
  N_KEEPERS,
  N_MERGE_SLOTS,
  N_NODES,
  N_PART_SLOTS,
  N_QUEUE_SLOTS,
  N_READ_THREADS,
  N_REPLICAS,
  N_SHARDS,
} from '../core/types'
import type {
  Bus,
  CacheSim,
  DistributedSim,
  FlowKind,
  FlowRequest,
  KeeperSim,
  Knobs,
  LogEntryType,
  MergeAlgorithm,
  MergeReason,
  MergeSim,
  MutationSim,
  NodeSim,
  NodeTableSim,
  PartSim,
  PartState,
  QuerySim,
  QueueEntrySim,
  ReaderSim,
  ReadTaskSim,
  SimApi,
  SimState,
  VolumeSim,
} from '../core/types'
import {
  N_TABLES,
  TABLES,
  keeperPos,
  nodeHost,
  nodeIndex,
  replicaOf,
  rid,
  rowBytesCompressed,
  rowBytesUncompressed,
  shardOf,
  siblingOf,
  streamCount,
} from '../world/layout'
import {
  clamp,
  clamp01,
  damp,
  expDelay,
  makeRng,
  markCount,
  partName,
  partitionId,
  pushHistory,
  shardHash,
  weightedPick,
} from '../core/util'
import { SCENARIOS, SCENARIO_NARRATION_SECONDS } from './scenarios'

/* --------------------------------------------------------------------------
 * Constants
 * ------------------------------------------------------------------------*/

const MIB = 1024 * 1024
const GIB = 1024 * MIB
const STEP_MAX = 1 / 30
/** Most sub-steps one update() call may run, so a huge delta cannot stall the tab. */
const MAX_STEPS = 20

/**
 * Bytes one entry in a `.mrk3` file occupies. A mark is a *pair* of offsets —
 * where the compressed block starts in the `.bin`, and where the row starts
 * inside that block once decompressed — plus, for a stream with adaptive
 * granularity, the granule's row count. Three 64-bit numbers.
 *
 * This is the number that makes the mark cache matter: a wide table with
 * hundreds of streams and thousands of granules per part has a mark set
 * measured in gigabytes, and every one of those bytes has to be resident before
 * a reader can seek.
 */
const MARK_BYTES = 24

/**
 * Bytes per second the modelled local SSD sustains for reads before requests
 * start queueing behind each other. Calibrated so a healthy cluster sits at
 * ~1.2x pressure and a four-way concurrent merge on the widest table pushes it
 * to the ceiling — which is the whole reason `background_pool_size` is a knob.
 */
const HOT_READ_BYTES_PER_SEC = 900 * MIB
const HOT_WRITE_BYTES_PER_SEC = 500 * MIB
const COLD_READ_BYTES_PER_SEC = 160 * MIB
const COLD_WRITE_BYTES_PER_SEC = 90 * MIB

/**
 * `SimpleMergeSelector`'s base. The selector prefers a range whose total size is
 * at least `base` times the size of its largest part, which is what produces the
 * roughly-logarithmic tree of merge levels instead of an endless sequence of
 * two-part merges. ClickHouse's own default is 5.
 */
const MERGE_SELECTOR_BASE = 5
/** Fewest parts the selector will ever merge. Merging one is not a merge. */
const MERGE_MIN_PARTS = 2
/** Most parts one merge takes. `max_parts_to_merge_at_once`. */
const MERGE_MAX_PARTS = 100

/**
 * `enable_vertical_merge_algorithm` triggers once the part has more than this
 * many columns and more than `verticalMinRows` rows. Below that a horizontal
 * merge is cheaper because the vertical one's second pass is pure overhead.
 */
const VERTICAL_MIN_COLUMNS = 11
const VERTICAL_MIN_ROWS = 131072

/** `min_bytes_for_wide_part`: below this a part is stored `Compact`, one file. */
const MIN_BYTES_FOR_WIDE_PART = 10 * MIB

/** `merge_max_block_size` — rows a merge moves at a time. */
const MERGE_MAX_BLOCK_ROWS = 8192

/**
 * `max_block_size` — rows a reader returns in one block, and ClickHouse's own
 * default.
 *
 * It is what makes a packet on the read path a fixed size: a thread does not
 * hand its whole mark range up at once, it streams blocks of this many rows. The
 * stripes used to be sized by the thread's ENTIRE task instead, which on a full
 * scan is millions of rows, so `flowSize` produced slabs long enough to lie
 * across the yard — a picture of one enormous object moving, when what is
 * happening is a great many small ones.
 */
const MAX_BLOCK_ROWS = 65409

/**
 * Seconds an `outdated` part is retained before its directory is removed —
 * `old_parts_lifetime`.
 *
 * ClickHouse's default is 480 s. Compressed here for the same reason the TTL is:
 * at 480 s against this model's merge rate the yard filled with grey, outdated
 * towers outnumbering active ones three to one, which is the opposite of what
 * `system.parts` looks like on a real server and buried the state the yard exists
 * to show.
 */
const OLD_PARTS_LIFETIME = 3

/** Particle budget, so a busy cluster cannot flood the flow pool. */
const FLOW_BUDGET_PER_SEC = 520

/** How long a part sits in `temporary`, then in `preactive`, before it is live. */
const TEMPORARY_SECONDS = 0.18
const PREACTIVE_SECONDS = 0.1

/** A compact byte formatter for toasts; the UI has its own. */
function fmtBytesShort(b: number): string {
  const units = ['B', 'KiB', 'MiB', 'GiB']
  let v = b
  let i = 0
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i++
  }
  return `${v.toFixed(i === 0 ? 0 : 1)} ${units[i]}`
}

/** Simulated seconds of data one INSERT block spans, for TTL purposes. */
const BLOCK_TIME_SPAN = 6

/**
 * Queue entries one replica executes at once. Stands in for
 * `max_replicated_merges_in_queue` and the fetch concurrency together; see the
 * comment at its use site for why one-at-a-time was wrong.
 *
 * Eight, which is `background_fetches_pool_size`'s own default. At four, a
 * perfectly ordinary insert rate outran the queue and `absolute_delay` climbed
 * on a healthy cluster — the metric has to be quiet when nothing is wrong.
 */
const QUEUE_CONCURRENCY = 8

/**
 * Shortest a SELECT may take. See the comment at its use site: this is a
 * presentation floor, not a claim about ClickHouse.
 */
const MIN_QUERY_SECONDS = 0.14

/**
 * `merge_tree_min_rows_for_concurrent_read` — 163840 rows, which is 20 granules
 * at the default `index_granularity`.
 *
 * It is the smallest amount of work the pool thinks is worth a second thread, so
 * it decides both how many threads a query gets and how big a share each one is
 * dealt. This is why a point lookup runs on ONE core however high `max_threads`
 * is: there is nothing to parallelise, and starting eight threads to read twelve
 * granules would cost more than reading them.
 */
const MIN_MARKS_FOR_CONCURRENT_READ = Math.ceil(163840 / INDEX_GRANULARITY)

/**
 * `merge_tree_min_read_task_size` — the floor on a thread's share, in marks.
 *
 * Without it a query that survived the indexes with thirty granules would be cut
 * into eight two-granule tasks, and the bookkeeping would cost more than the
 * read.
 */
const MIN_READ_TASK_MARKS = 8

/**
 * How many per-part analysis pods one probe leg draws at once.
 *
 * Analysis really is one task per selected part, in parallel, and a node here can
 * hold a hundred selected parts. Drawing all of them would spend the entire frame
 * budget on the cheapest step in the query. This bounds the DRAWING only: the
 * query's `partsSelected` counts every part, and the tooltip says so.
 */
const ANALYSIS_PODS = 5

/**
 * The modelled node hosts three tables. A real one hosts hundreds, and they all
 * share ONE `mark_cache_size`. Sizing the cache against three tables' marks
 * would make the default look infinitely generous and hide the actual failure
 * mode, which is a server whose *whole schema* does not fit.
 *
 * So the mark working set is scaled by this factor, standing for the rest of the
 * schema. It is the one place the model multiplies a quantity to represent
 * something it does not draw, and it is why the default 5 GiB is comfortable
 * here while 32 MiB is catastrophic — exactly the relationship a real server has.
 */
const MARK_SET_SERVER_FACTOR = 24

/* --------------------------------------------------------------------------
 * createSim
 * ------------------------------------------------------------------------*/

export function createSim(bus: Bus): SimApi {
  const rng = makeRng(0xc11c4)
  const rr = (lo: number, hi: number) => lo + (hi - lo) * rng()

  /* ---- state skeleton -------------------------------------------------
   * Built once, then reset in place: world modules hold references to
   * state.nodes[i].tables[t].parts forever, so the ARRAY OBJECTS must never be
   * replaced — only their contents. ------------------------------------- */

  /**
   * One server's `Distributed` table. There are `N_NODES` of these and they are
   * identical at boot, because the DDL that creates them is identical — the
   * asymmetry between servers only ever comes from where the clients connect.
   */
  function makeDistributed(): DistributedSim {
    return {
      pendingBlocks: new Array(N_SHARDS).fill(0),
      pendingBytes: new Array(N_SHARDS).fill(0),
      lastShard: 0,
      rowsToShard: new Array(N_SHARDS).fill(0),
      readShard: new Array(N_SHARDS).fill(-1),
      fanOut: 0,
      rowsMerged: 0,
      bytesFromRemote: 0,
      queriesInitiated: 0,
      insertsInitiated: 0,
      activity: 0,
    }
  }

  function makeCache(capacityMib: number): CacheSim {
    return {
      capacityBytes: capacityMib * MIB,
      usedBytes: 0,
      hits: 0,
      misses: 0,
      hitRatio: 0,
      evictions: 0,
    }
  }

  function makeVolumes(): VolumeSim[] {
    return [
      {
        id: 0,
        name: 'hot',
        kind: 'local_ssd',
        totalBytes: 400 * GIB,
        usedBytes: 0,
        throughputBytesPerSec: HOT_WRITE_BYTES_PER_SEC,
        load: 0,
      },
      {
        id: 1,
        name: 'cold',
        kind: 's3',
        totalBytes: 20 * 1024 * GIB,
        usedBytes: 0,
        throughputBytesPerSec: COLD_WRITE_BYTES_PER_SEC,
        load: 0,
      },
    ]
  }

  function makeMerge(slot: number, node: number): MergeSim {
    return {
      slot,
      node,
      table: 0,
      active: false,
      reason: 'regular',
      algorithm: 'horizontal',
      resultPart: '',
      sourceParts: [],
      sourceSlots: [],
      partition: 0,
      progress: 0,
      rowsRead: 0,
      totalRows: 0,
      bytesRead: 0,
      totalBytes: 0,
      memoryBytes: 0,
      elapsed: 0,
      verticalColumn: -1,
      duration: 1,
    }
  }

  function makeReader(slot: number): ReaderSim {
    const tasks: ReadTaskSim[] = []
    // Allocated once, at boot. `assignReaders` runs on every SELECT, and a
    // SELECT-heavy scenario runs dozens per second.
    for (let i = 0; i < MAX_READ_TASKS; i++) tasks.push({ table: 0, part: -1, markBegin: 0, markEnd: 0, marksInPart: 0 })
    return {
      slot,
      state: 'idle',
      tasks,
      taskCount: 0,
      marksTotal: 0,
      stolenFrom: -1,
      query: -1,
      marksDone: 0,
      column: 0,
      progress: 0,
      markCacheHit: false,
      blockCacheHit: false,
    }
  }

  function makeQueueEntry(slot: number): QueueEntrySim {
    return {
      slot,
      type: 'GET_PART',
      table: 0,
      partName: '',
      tries: 0,
      createdAt: 0,
      executing: false,
      progress: 0,
      lastException: '',
    }
  }

  function makeNodeTable(table: number): NodeTableSim {
    return {
      table,
      parts: [],
      activeParts: 0,
      outdatedParts: 0,
      rows: 0,
      bytesOnDisk: 0,
      bytesUncompressed: 0,
      nextBlock: 1,
      expiredParts: 0,
      heat: 0,
      partsInserted: 0,
      partsMerged: 0,
      partsDropped: 0,
    }
  }

  const nodes: NodeSim[] = []
  for (let i = 0; i < N_NODES; i++) {
    const merges: MergeSim[] = []
    for (let m = 0; m < N_MERGE_SLOTS; m++) merges.push(makeMerge(m, i))
    const readers: ReaderSim[] = []
    for (let r = 0; r < N_READ_THREADS; r++) readers.push(makeReader(r))
    const queue: QueueEntrySim[] = []
    for (let q = 0; q < N_QUEUE_SLOTS; q++) queue.push(makeQueueEntry(q))
    const tables: NodeTableSim[] = []
    for (let t = 0; t < N_TABLES; t++) tables.push(makeNodeTable(t))

    nodes.push({
      index: i,
      shard: shardOf(i),
      replica: replicaOf(i),
      host: nodeHost(i),
      status: 'up',
      tables,
      merges,
      mutations: [],
      readers,
      queries: [],
      markCache: makeCache(DEFAULT_KNOBS.markCacheMib),
      uncompressedCache: makeCache(DEFAULT_KNOBS.uncompressedCacheMib),
      replication: {
        connected: true,
        readOnly: false,
        logPointer: 0,
        logMaxIndex: 0,
        absoluteDelay: 0,
        queue,
        queueSize: 0,
        insertsInQueue: 0,
        mergesInQueue: 0,
        partsFetched: 0,
        partsSent: 0,
      },
      volumes: makeVolumes(),
      insertRowsPerSec: 0,
      selectRowsPerSec: 0,
      insertDelay: 0,
      tooManyPartsErrors: 0,
      memoryBytes: 0,
      memoryPeakBytes: 0,
      asyncInsertBytes: 0,
      queriesServed: 0,
      blocksWritten: 0,
      cpu: 0,
      // Every server has the `Distributed` table, because `CREATE TABLE …
      // ENGINE = Distributed(…)` is run on every server. Whether this one is
      // currently an initiator depends only on where the clients pointed.
      distributed: makeDistributed(),
    })
  }

  const keepers: KeeperSim[] = []
  for (let i = 0; i < N_KEEPERS; i++) {
    keepers.push({
      slot: i,
      // Node 1 stands forward of the others in the plan, and it is the leader.
      role: i === 1 ? 'leader' : 'follower',
      term: 1,
      commitIndex: 0,
      sessions: 0,
      znodes: 0,
      requestsPerSec: 0,
      activity: 0,
    })
  }


  const state: SimState = {
    t: 0,
    realT: 0,
    knobs: { ...DEFAULT_KNOBS },
    tables: TABLES,
    nodes,
    keepers,
    clients: {
      lastInsertTarget: 0,
      lastSelectTarget: 0,
      sentToNode: new Array(N_NODES).fill(0),
      reachable: N_NODES,
      activity: 0,
    },
    stats: {
      insertsPerSec: 0,
      selectsPerSec: 0,
      insertRowsPerSec: 0,
      selectRowsPerSec: 0,
      activeParts: 0,
      runningMerges: 0,
      mergeRowsPerSec: 0,
      totalRows: 0,
      totalBytesOnDisk: 0,
      totalBytesUncompressed: 0,
      compressionRatio: 1,
      markCacheHitPct: 0,
      meanQueryMs: 0,
      maxReplicaDelay: 0,
      maxQueueSize: 0,
      history: { parts: [], merges: [], insertRows: [], selectRows: [], delay: [], markCache: [] },
    },
    nextQueryId: 1,
    keeperLogIndex: 0,
    scenario: null,
    scenarioT: 0,
  }

  const K = state.knobs
  const stats = state.stats

  /* ---- derived per-table constants ------------------------------------- */

  const rowUncompressed: number[] = TABLES.map((_, t) => rowBytesUncompressed(t))
  const rowCompressed: number[] = TABLES.map((_, t) => rowBytesCompressed(t))
  const streams: number[] = TABLES.map((_, t) => streamCount(t))
  const insertWeights: number[] = TABLES.map((d) => d.insertWeight)
  const selectWeights: number[] = TABLES.map((d) => d.selectWeight)

  /* ---- part slot allocation --------------------------------------------
   * `parts` is a dense array; `slot` is a stable visual identity drawn from a
   * per-node-table free list. The world places a part by its slot, so a part
   * must keep the same slot for its whole life or the yard would shuffle. */

  const freeSlots: number[][][] = []
  for (let n = 0; n < N_NODES; n++) {
    const perTable: number[][] = []
    for (let t = 0; t < N_TABLES; t++) {
      const list: number[] = []
      for (let s = N_PART_SLOTS - 1; s >= 0; s--) list.push(s)
      perTable.push(list)
    }
    freeSlots.push(perTable)
  }

  /**
   * A visual slot, or -1.
   *
   * When the window is full, the oldest part that is already on its way out is
   * evicted from the DISPLAY first — `old_parts_lifetime` is a maximum, not a
   * minimum, so retiring an `outdated` directory early is a legitimate thing for
   * the model to do and costs no information. Only if every slot holds a part
   * that is still answering queries does the new part go unslotted.
   */
  function takeSlot(node: number, table: number): number {
    const list = freeSlots[node][table]
    if (list.length > 0) return list.pop()!
    const parts = nodes[node].tables[table].parts
    let victim: PartSim | null = null
    for (const p of parts) {
      if (p.slot < 0) continue
      if (p.state !== 'outdated' && p.state !== 'deleting') continue
      if (!victim || p.createdAt < victim.createdAt) victim = p
    }
    if (victim) {
      const slot = victim.slot
      victim.slot = -1
      return slot
    }
    return -1
  }

  function giveSlot(node: number, table: number, slot: number): void {
    freeSlots[node][table].push(slot)
  }

  /* ---- flow emission budget -------------------------------------------- */

  let flowTokens = 90
  let quiet = false
  let applying = false

  /**
   * Packet bulk from a row count. This is the ONLY way a `size` should be
   * chosen: a packet's volume is the batch it is carrying, and nothing else.
   *
   * The unit is the DECADE: size = log10(rows) − 2, floored at 100 rows and
   * clamped just above the top of the `insertBlockRows` knob (2,000,000). The
   * engine stretches the pod's length ×2.5 per decade (see engine/flows.ts) —
   * ×10 rows = ×2.5 train — so the knob's whole 100 → 2M range reads as
   * roughly half a world unit up to a ~26-unit freight run.
   *
   *   100 → 0   1k → 1   10k → 2   100k → 3   1M → 4   2M → 4.3
   *
   * CALIBRATED AGAINST THE KNOB, not against the data range. Two earlier
   * curves failed here: a gentle slope put the 100k default two thirds of the
   * way up, so raising the knob — the lesson this control exists for — changed
   * almost nothing on screen; and a floor at 1k made 100-row INSERTs identical
   * to 1k ones, hiding exactly the difference the "batch your inserts" story
   * turns on. Length rather than girth because girth is capped by the duct the
   * pod rides in (ROAD_RADIUS, engine/roads.ts): four decades of batch cannot
   * fit in a cross-section, but a train can always get longer.
   */
  function flowSize(rows: number): number {
    if (!(rows > 0)) return 0
    return clamp(Math.log10(rows) - 2, 0, 4.4)
  }

  function flow(route: string, count: number, kind: FlowKind, size?: number, stagger?: number): void {
    if (quiet) return
    if (flowTokens < count) return
    flowTokens -= count
    const req: FlowRequest = { route, count, kind }
    if (size !== undefined) req.size = size
    if (stagger !== undefined) req.stagger = stagger
    bus.emit('flow', req)
  }

  /**
   * An INSERT is drawn END TO END, or not drawn at all.
   *
   * `flow` spends a token per emission, first come first served, and that is
   * right for traffic whose pods are independent of each other — a merge, a
   * fetch, a reader capillary. It is exactly wrong for a statement, because a
   * statement's legs are emitted in ORDER over several seconds: the corridor
   * pod goes first and pays, and the legs behind it — the wheel, the queue, the
   * dock, the sort, the commit — are the ones that find the budget empty. Turn
   * `insertsPerSec` up to 200 and the result is not "fewer pods": it is freight
   * arriving at the `Distributed` table and NOTHING leaving, then towers
   * appearing in the yard that nothing was seen to deliver. The city says the
   * data was lost. The data was not lost; the drawing ran out of budget.
   *
   * So the whole journey is reserved at the door, once. What the city shows at
   * a rate it cannot draw is a SAMPLE of statements, each one complete — which
   * is the honest reduction, and the only one that leaves every arrow in the
   * INSERT path meaning what it says.
   */
  const TRACE_COST = 9

  /** Claim one statement's whole journey, or decline to draw it at all. */
  function beginTrace(): boolean {
    if (quiet) return false
    if (flowTokens < TRACE_COST) return false
    flowTokens -= TRACE_COST
    return true
  }

  /**
   * One leg of an already-reserved journey. It does NOT consult the budget:
   * paying twice is what made the tail of a statement disappear.
   */
  function leg(traced: boolean, route: string, count: number, kind: FlowKind, size?: number, stagger?: number): void {
    if (!traced || quiet) return
    const req: FlowRequest = { route, count, kind }
    if (size !== undefined) req.size = size
    if (stagger !== undefined) req.stagger = stagger
    bus.emit('flow', req)
  }

  function toast(text: string, kind: 'info' | 'warn' | 'good' = 'info', ms = 4200): void {
    if (quiet) return
    bus.emit('toast', { text, kind, ms })
  }

  /* ---- warning rate limiters ------------------------------------------- */

  let quorumFailures = 0
  let quorumWarnT = -100
  /** Rate limit on `Code: 279`, which the queue's retry loop would otherwise repeat. */
  let connWarnT = -100
  let asyncLossWarnT = -100
  let tooManyPartsWarnT = -100
  let readOnlyWarnT = -100
  let delayWarnT = -100
  let queueWarnT = -100

  /* ======================================================================
   * PARTS
   *
   * A part is a directory. Everything below follows from that one fact: it is
   * created under a temporary name, renamed into place, becomes visible as a
   * unit, is superseded as a unit, and is removed as a unit. There is no such
   * thing as modifying a part, which is why an UPDATE is a mutation that
   * rewrites whole parts and why TTL cannot delete a row without rewriting the
   * part around it.
   * ====================================================================*/

  /**
   * Allocate a part. Returns null when the yard is full, which is the modelled
   * stand-in for a node that has more parts than the visualisation can hold —
   * the counters keep the true total, so nothing is silently lost.
   */
  function createPart(
    node: number,
    table: number,
    partition: number,
    minBlock: number,
    maxBlock: number,
    level: number,
    rows: number,
    opts: { fetched?: boolean; mutation?: number; volume?: number; ttlBase?: number; traced?: boolean } = {},
  ): PartSim | null {
    const nt = nodes[node].tables[table]
    // -1 is not a failure: the part exists and is simulated, it just has no
    // place to stand in the yard. See PartSim.slot.
    const slot = takeSlot(node, table)

    const def = TABLES[table]
    const uncompressed = rows * rowUncompressed[table]
    const onDisk = rows * rowCompressed[table]
    const ttlBase = opts.ttlBase ?? state.t
    const ttlSpan = def.ttlSeconds ?? 0

    const part: PartSim = {
      slot,
      name: partName(partitionId(partition), minBlock, maxBlock, level, opts.mutation ?? 0),
      partition,
      minBlock,
      maxBlock,
      level,
      mutation: opts.mutation ?? 0,
      rows,
      bytesOnDisk: onDisk,
      bytesUncompressed: uncompressed,
      marks: markCount(rows, INDEX_GRANULARITY),
      // A brand-new part is written under `tmp_insert_…` and is invisible; a
      // fetched part arrives already complete and only needs committing.
      state: opts.fetched ? 'preactive' : 'temporary',
      /* Whether this part's commit is part of a journey already being drawn.
       * Undefined means "not part of one" — a merge output, a mutation result —
       * and those pay the ordinary budget for their commit pod. */
      traced: opts.traced,
      volume: opts.volume ?? 0,
      createdAt: state.t,
      stateSince: state.t,
      // Rows in one block span a little time, so a part is rarely wholly
      // expired at once — which is exactly why a TTL merge usually has to
      // rewrite rather than drop.
      ttlMin: ttlSpan > 0 ? ttlBase + ttlSpan : Infinity,
      ttlMax: ttlSpan > 0 ? ttlBase + ttlSpan + BLOCK_TIME_SPAN : Infinity,
      reserved: false,
      // A part being created is being WRITTEN, not read. It used to arrive with
      // read heat, which made every new part in the yard look like something a
      // SELECT had just touched — the two are now separate channels and the
      // yard pulses a different colour for each.
      heat: 0,
      writeHeat: 1,
      fetched: !!opts.fetched,
    }

    nt.parts.push(part)
    nodes[node].volumes[part.volume].usedBytes += part.bytesOnDisk
    return part
  }

  function removePart(node: number, table: number, part: PartSim): void {
    const nt = nodes[node].tables[table]
    const i = nt.parts.indexOf(part)
    if (i >= 0) nt.parts.splice(i, 1)
    nodes[node].volumes[part.volume].usedBytes = Math.max(
      0,
      nodes[node].volumes[part.volume].usedBytes - part.bytesOnDisk,
    )
    if (part.slot >= 0) giveSlot(node, table, part.slot)
  }

  function setPartState(node: number, table: number, part: PartSim, next: PartState): void {
    if (part.state === next) return
    part.state = next
    part.stateSince = state.t
  }

  /** Active parts of one partition, in sorting order — the merge selector's input. */
  function activeInPartition(nt: NodeTableSim, partition: number, out: PartSim[]): PartSim[] {
    out.length = 0
    for (const p of nt.parts) {
      if (p.state === 'active' && !p.reserved && p.partition === partition) out.push(p)
    }
    out.sort((a, b) => a.minBlock - b.minBlock)
    return out
  }

  function tickParts(node: number, dt: number): void {
    const n = nodes[node]
    for (let t = 0; t < N_TABLES; t++) {
      const nt = n.tables[t]
      let active = 0
      let outdated = 0
      let rows = 0
      let onDisk = 0
      let uncompressed = 0
      let expired = 0

      for (let i = nt.parts.length - 1; i >= 0; i--) {
        const p = nt.parts[i]
        const age = state.t - p.stateSince
        /* Both channels decay fast enough that the yard's pulse stays an EVENT.
         *
         * Read heat used to decay at 0.5, which was slower than the query rate
         * tops it up at: every active part sat pinned at 1 and the whole yard
         * pulsed green continuously, which says nothing. At 2.2 a part fades
         * within about a second of the last query that opened it, so the parts
         * lit at any moment are the ones a query is actually reading — and with
         * partition pruning on, that is one partition group and not the yard. */
        p.heat = damp(p.heat, 0, 2.2, dt)
        p.writeHeat = damp(p.writeHeat, 0, 1.1, dt)
        // A merge holds its inputs open and reads every row of them, start to
        // finish. `reserved` is exactly the window in which that is happening,
        // so the input parts stay read-hot for as long as the merge runs — which
        // is what makes "several parts are being consumed to make one" visible
        // in the yard rather than only on the gantry.
        if (p.reserved) p.heat = Math.max(p.heat, 0.85)

        switch (p.state) {
          case 'temporary':
            // The columns are still being compressed into `tmp_insert_…`.
            if (age >= TEMPORARY_SECONDS) {
              setPartState(node, t, p, 'preactive')
              /* Into the band of the table this part belongs to. A part is not
               * committed to "the yard": `system.parts` has a row for THIS
               * table, and the tower is about to stand in that table's band. */
              if (p.traced === undefined) flow(rid.commitPart(node, t), 1, 'part_write', flowSize(p.rows))
              else leg(p.traced, rid.commitPart(node, t), 1, 'part_write', flowSize(p.rows))
            }
            break
          case 'preactive':
            // Renamed into place; `DataPartsLock` is held while it joins the set.
            //
            // Deliberately NOT where `partsInserted` is counted. Every part
            // reaches `active` through this state — one written by an INSERT, one
            // fetched from a sibling, and the output of a merge alike — so
            // counting here conflated three things `system.part_log` keeps
            // separate as `NewPart`, `DownloadPart` and `MergeParts`. It made
            // `async_insert` look like it barely reduced the part count, because
            // the fetches and merge outputs it did not reduce swamped the
            // insertions it did.
            if (age >= PREACTIVE_SECONDS) {
              setPartState(node, t, p, 'active')
              nt.heat = Math.min(1, nt.heat + 0.2)
            }
            break
          case 'active':
            active++
            if (p.ttlMax < state.t) expired++
            break
          case 'outdated':
            outdated++
            // `old_parts_lifetime`: the directory survives its replacement so a
            // query that started before the merge finished can still read it.
            if (age >= OLD_PARTS_LIFETIME) setPartState(node, t, p, 'deleting')
            break
          case 'deleting':
            if (age >= 0.4) {
              removePart(node, t, p)
              nt.partsDropped++
              continue
            }
            break
        }

        rows += p.state === 'active' ? p.rows : 0
        if (p.state === 'active' || p.state === 'outdated') {
          onDisk += p.bytesOnDisk
          uncompressed += p.bytesUncompressed
        }
      }

      nt.activeParts = active
      nt.outdatedParts = outdated
      nt.rows = rows
      nt.bytesOnDisk = onDisk
      nt.bytesUncompressed = uncompressed
      nt.expiredParts = expired
      nt.heat = damp(nt.heat, 0, 1.2, dt)
    }
  }

  /* ======================================================================
   * THE WRITE PATH
   *
   * INSERT → sort by ORDER BY → split by PARTITION BY → one part per partition
   * → compress each column into its own `.bin` → write `.mrk3` marks and
   * `primary.cidx` → rename `tmp_insert_…` into place → announce to Keeper.
   *
   * The single most important consequence: ONE INSERT MAKES AT LEAST ONE PART
   * PER PARTITION IT TOUCHES. An INSERT spread over thirty days of a
   * `toYYYYMMDD`-partitioned table makes thirty parts, and that is how a
   * well-meaning backfill produces `TOO_MANY_PARTS`.
   * ====================================================================*/

  /** Which partitions this block's rows land in, and how many rows in each. */
  const blockRowsPerPartition = new Float64Array(32)

  function splitByPartition(table: number, rows: number): number {
    const def = TABLES[table]
    const n = Math.min(def.partitions, blockRowsPerPartition.length)
    blockRowsPerPartition.fill(0, 0, n)
    if (def.ttlSeconds) {
      // A time-series table with a time partition key: almost everything lands
      // in the newest partition, because that is what "append-only" means.
      blockRowsPerPartition[n - 1] = rows * 0.94
      if (n > 1) blockRowsPerPartition[n - 2] = rows * 0.06
      return n
    }
    // The other tables are backfilled a little as well as appended to, so the
    // block genuinely straddles partitions — which is where extra parts come from.
    let left = rows
    for (let i = n - 1; i >= 0; i--) {
      const share = i === n - 1 ? 0.72 : i === n - 2 ? 0.2 : 0.08 / Math.max(1, n - 2)
      const take = Math.min(left, Math.round(rows * share))
      blockRowsPerPartition[i] = take
      left -= take
    }
    if (left > 0) blockRowsPerPartition[n - 1] += left
    return n
  }

  /**
   * `parts_to_delay_insert` / `parts_to_throw_insert`.
   *
   * ClickHouse does not fail an INSERT the moment the yard gets busy: it first
   * *slows the writer down*, on purpose, so the merge pool has a chance to catch
   * up. Only past the throw threshold does it give up. Modelling the delay and
   * not just the exception matters, because in production the delay is what you
   * actually see: p99 insert latency climbing while nothing is technically wrong.
   */
  function insertPressure(node: number, table: number): { delay: number; reject: boolean } {
    const active = nodes[node].tables[table].activeParts
    if (active < K.partsToDelayInsert) return { delay: 0, reject: false }
    if (active >= K.partsToThrowInsert) return { delay: 1, reject: true }
    const span = Math.max(1, K.partsToThrowInsert - K.partsToDelayInsert)
    // `max_delay_to_insert` is quadratic in ClickHouse, not linear: the last few
    // parts before the throw threshold cost far more than the first few.
    const k = (active - K.partsToDelayInsert) / span
    return { delay: k * k, reject: false }
  }

  /**
   * Write one block into one node. Returns the number of parts created, which is
   * the number the operator cares about and rarely predicts correctly.
   */
  function writeBlock(node: number, table: number, rows: number, traced: boolean): number {
    const n = nodes[node]
    if (n.status === 'down') return 0

    const pressure = insertPressure(node, table)
    n.insertDelay = damp(n.insertDelay, pressure.delay, 6, 1 / 30)
    if (pressure.reject) {
      n.tooManyPartsErrors++
      if (state.t - tooManyPartsWarnT > 12) {
        tooManyPartsWarnT = state.t
        toast(
          `Code: 252. DB::Exception: Too many parts (${n.tables[table].activeParts}) in table ${TABLES[table].name}`,
          'warn',
          6000,
        )
      }
      return 0
    }

    // `ReplicatedMergeTree` allocates its block numbers from Keeper. Without a
    // Keeper session it cannot, and the table goes read-only — the INSERT fails
    // rather than writing a part nobody could replicate.
    //
    // The condition reads `K.keeperConnected` and not the cached
    // `replication.readOnly`, because that flag is recomputed in tickReplication,
    // which runs AFTER the write path in the same step. Consulting the cache let
    // exactly one block through on the tick the session was lost — a one-frame
    // race that is invisible on screen and wrong in principle: the allocation
    // fails at the moment it is attempted, not one heartbeat later.
    const replicated = TABLES[table].engine !== 'MergeTree'
    if (replicated && (!K.keeperConnected || n.replication.readOnly)) {
      if (state.t - readOnlyWarnT > 15) {
        readOnlyWarnT = state.t
        toast('Code: 242. DB::Exception: Table is in readonly mode (replica path in ZooKeeper is inaccessible)', 'warn', 6000)
      }
      return 0
    }

    leg(traced, rid.sortBlock(node), 1, 'block', flowSize(rows))
    // The block is split across the column writers, so each pod carries a share
    // of it rather than the whole thing.
    const writers = Math.min(3, 1 + Math.floor(streams[table] / 8))
    leg(traced, rid.writeColumns(node), writers, 'part_write', flowSize(rows / writers), 0.12)

    const nParts = splitByPartition(table, rows)
    const nt = n.tables[table]
    let created = 0
    for (let p = 0; p < nParts; p++) {
      const r = Math.round(blockRowsPerPartition[p])
      if (r <= 0) continue
      const block = nt.nextBlock++
      // A brand-new part always has min_block == max_block and level 0. That
      // identity is what tells you, from a part name alone, that nothing has
      // merged it yet.
      const part = createPart(node, table, p, block, block, 0, r, { traced })
      if (!part) continue
      created++
      // `system.part_log`'s `NewPart`: a part this node wrote from an INSERT.
      // Fetched parts are counted by `replication.partsFetched` and merge outputs
      // by `partsMerged`; conflating the three is what this counter must not do.
      nt.partsInserted++
      // Every part written on a replicated table becomes a `/log` entry, and the
      // sibling replica will fetch it. This is the whole of insert replication.
      if (replicated) appendKeeperLog(node, table, 'GET_PART', part.name)
      leg(traced, rid.toHotVolume(node), 1, 'part_write', flowSize(r))
    }

    n.blocksWritten++
    insertRowsAcc[node] += rows
    return created
  }

  /**
   * `async_insert`: the server accumulates small INSERTs in memory and writes one
   * part when either `async_insert_max_data_size` bytes or
   * `async_insert_busy_timeout_ms` have accumulated. It is the correct answer to
   * "many small INSERTs", and turning it on visibly collapses the part count —
   * at the cost of `wait_for_async_insert` deciding whether the client learns
   * about a failure at all.
   */
  const asyncBuffer: { rows: number[]; timer: number[] }[] = []
  for (let i = 0; i < N_NODES; i++) {
    asyncBuffer.push({ rows: new Array(N_TABLES).fill(0), timer: new Array(N_TABLES).fill(0) })
  }

  function queueAsyncInsert(node: number, table: number, rows: number): void {
    const buf = asyncBuffer[node]
    buf.rows[table] += rows
    nodes[node].asyncInsertBytes = 0
    for (let t = 0; t < N_TABLES; t++) nodes[node].asyncInsertBytes += buf.rows[t] * rowUncompressed[t]
  }

  function tickAsyncInsert(node: number, dt: number): void {
    const buf = asyncBuffer[node]
    const capBytes = K.asyncInsertMaxDataKib * 1024
    const timeout = K.asyncInsertBusyTimeoutMs / 1000
    let held = 0
    for (let t = 0; t < N_TABLES; t++) {
      if (buf.rows[t] <= 0) {
        buf.timer[t] = 0
        continue
      }
      buf.timer[t] += dt
      const bytes = buf.rows[t] * rowUncompressed[t]
      if (bytes >= capBytes || buf.timer[t] >= timeout) {
        const rows = Math.round(buf.rows[t])
        buf.rows[t] = 0
        buf.timer[t] = 0
        // A flush is its own piece of freight: one part standing for however
        // many statements the buffer swallowed, so it reserves its own journey.
        writeBlock(node, t, rows, beginTrace())
      } else {
        held += bytes
      }
    }
    nodes[node].asyncInsertBytes = held
  }

  /* ======================================================================
   * THE DISTRIBUTED TABLE — ON EVERY SERVER
   *
   * A `Distributed` table stores nothing. On INSERT it evaluates the sharding
   * expression per row, splits the block, and delivers each piece as an INSERT
   * into the underlying MergeTree table on one replica of its shard — never
   * into the remote server's own Distributed table. Its OWN shard's piece is
   * written locally right away in either mode (`prefer_localhost_replica`);
   * the other shards' pieces go over the wire immediately
   * (`distributed_foreground_insert = 1`) or are parked in the background
   * INSERT queue on its own disk (`= 0`, the default) and flushed later. On
   * SELECT it rewrites the query for one replica of each shard, sends it, and
   * merges the partial results.
   *
   * There is no initiator NODE. The DDL runs on every server, so all four have
   * the table and all four can do this; the initiator of a given statement is
   * whichever server the client opened a connection to. Everything below is
   * therefore parameterised by that server.
   *
   * The spool is the part people get wrong: in background mode the INSERT
   * returns as soon as THE SERVER THE CLIENT REACHED has the data on its own
   * disk. If that server dies, those blocks are on its disk, not in the shards
   * — and which server it was is a property of the client's connection, not of
   * the cluster.
   * ====================================================================*/

  /**
   * Which server the application connects to for the next statement, and so
   * which one becomes its initiator.
   *
   * This is the driver's decision, not ClickHouse's. `round_robin` is a driver
   * with the whole cluster in its connection string; `single` is the far more
   * common one hostname, and it is why one server in a cluster is sometimes at
   * twice everyone else's CPU while holding exactly the same data.
   *
   * A server that is down cannot be an initiator. Every real driver fails over,
   * so this returns another server rather than dropping the statement — but
   * when nothing is reachable it returns -1 and the caller must not invent a
   * fallback.
   */
  function pickInitiator(): number {
    const live: number[] = []
    for (let n = 0; n < N_NODES; n++) if (nodes[n].status !== 'down') live.push(n)
    state.clients.reachable = live.length
    if (live.length === 0) return -1
    switch (K.clientBalancing) {
      case 'single':
        // One hostname. It fails over only because the alternative is an
        // outage, and it goes back the moment its server returns.
        return live[0]
      case 'random':
        return live[Math.floor(rng() * live.length)]
      default:
        clientRoundRobin = (clientRoundRobin + 1) % live.length
        return live[clientRoundRobin]
    }
  }

  let clientRoundRobin = 0

  /** Record that the application sent one statement to `node`. */
  function noteClientStatement(node: number): void {
    state.clients.sentToNode[node]++
    state.clients.activity = Math.min(1, state.clients.activity + 0.25)
  }

  /** Rows this INSERT sends to each shard. Written by `shardBlock`. */
  const shardRows = new Float64Array(N_SHARDS)

  /**
   * Split one block by the sharding key. A hash of a high-cardinality column
   * distributes evenly; the skew term below stands in for the far more common
   * real case of a sharding key with a hot value in it.
   */
  function shardBlock(initiator: number, rows: number, blockId: number): void {
    shardRows.fill(0)
    const h = shardHash(blockId)
    // Even split, plus a deterministic ±12% lean that follows the hash. A
    // perfectly even split would hide the one thing this wheel exists to show.
    const lean = ((h % 1000) / 1000 - 0.5) * 0.24
    for (let s = 0; s < N_SHARDS; s++) {
      const bias = s === 0 ? 1 + lean : 1 - lean
      shardRows[s] = (rows / N_SHARDS) * bias
    }
    // The expression is the same on every server — it comes from the table
    // definition — so any server splits a given block identically. That is what
    // makes it safe for the application to write through any of them.
    nodes[initiator].distributed.lastShard = h % N_SHARDS
  }

  /** Which replica of `shard` should receive a write or serve a read. */
  function pickReplica(shard: number, forWrite: boolean): number {
    const candidates: number[] = []
    for (let r = 0; r < N_REPLICAS; r++) {
      const n = nodeIndex(shard, r)
      if (nodes[n].status === 'down') continue
      if (forWrite && nodes[n].replication.readOnly) continue
      candidates.push(n)
    }
    if (candidates.length === 0) return -1
    switch (K.loadBalancing) {
      case 'in_order':
      case 'nearest_hostname':
        // Both are deterministic: the same replica answers every query until it
        // is unavailable. Good for cache locality, bad for spreading load.
        return candidates[0]
      case 'round_robin':
        roundRobin[shard] = (roundRobin[shard] + 1) % candidates.length
        return candidates[roundRobin[shard]]
      default:
        return candidates[Math.floor(rng() * candidates.length)]
    }
  }

  const roundRobin = new Array(N_SHARDS).fill(0)

  let pendingInserts = 0
  let nextInsertArrival = 0
  let blockSeq = 1

  function tickDistributedInsert(dt: number): void {
    // Client arrivals: a Poisson process at `insertsPerSec`.
    nextInsertArrival -= dt
    let guard = 400
    while (nextInsertArrival <= 0 && guard-- > 0) {
      pendingInserts++
      const gap = expDelay(K.insertsPerSec, rng)
      if (!isFinite(gap)) {
        nextInsertArrival = 1e9
        break
      }
      nextInsertArrival += gap
    }

    while (pendingInserts > 0) {
      pendingInserts--
      // The application opens a connection first, and THAT is what decides
      // which server's Distributed table does the splitting and whose disk the
      // spool lands on.
      const init = pickInitiator()
      if (init < 0) {
        toast('Code: 210. Connection refused — no server is reachable', 'warn', 4000)
        break
      }
      const table = weightedPick(insertWeights, rng)
      const rows = K.insertBlockRows
      noteClientStatement(init)
      state.clients.lastInsertTarget = init
      // Counted at the CONNECTION, not at arrival: which server initiates is
      // the client's decision and it is made here, while the freight's other
      // consequences all wait for the corridor.
      nodes[init].distributed.insertsInitiated++
      insertCountAcc++
      // One pod, as big as the batch. `insertBlockRows` is the knob the whole
      // "batch your inserts" lesson turns on, and this is where turning it down
      // becomes visible as a swarm of small pods instead of one large one.
      const traced = beginTrace()
      leg(traced, rid.clientToNode(init), 1, 'insert', flowSize(rows))
      /* Nothing else happens yet. The block is IN FLIGHT: the split, the
       * server's counters and the ok all wait until the freight has visibly
       * reached the Distributed table — a pod that vanishes into the door
       * while its consequences started seconds ago teaches nothing. */
      inFlight.push({ init, table, rows, due: state.t + CORRIDOR_S, traced })
    }

    // Statements whose freight has just reached the initiator's door.
    for (let i = inFlight.length - 1; i >= 0; i--) {
      if (inFlight[i].due > state.t) continue
      const st = inFlight[i]
      inFlight[i] = inFlight[inFlight.length - 1]
      inFlight.pop()
      // The server died while the statement was in flight: the connection died
      // with it, and what the client's retry policy does next is its business.
      if (nodes[st.init].status === 'down') continue
      splitAtDistributed(st.init, st.table, st.rows, st.traced)
    }

    // Forwarded blocks whose wire crossing has just ended. They arrive at the
    // receiver's insert dock — the sender was inserting into the underlying
    // MergeTree table directly — so no Distributed table is involved here.
    for (let i = onWire.length - 1; i >= 0; i--) {
      const b = onWire[i]
      if (b.due > state.t) continue
      // The receiver is down: the block stays on the sender's side and the
      // send is retried — a background distributed send really does retry.
      if (nodes[b.node].status === 'down') continue
      onWire[i] = onWire[onWire.length - 1]
      onWire.pop()
      /* `insert_quorum` is re-checked where the block lands, because the shard
       * may have lost a replica while this block was on the wire. The model
       * refuses the write outright so the lesson stays clean; a real server
       * can be uglier — the part may be written and the client told
       * `Code: 319. Unknown status of insert`. */
      const need = quorumRequired()
      if (need > 0 && liveReplicas(b.shard) < need) {
        quorumFailures++
        continue
      }
      dockBlock(b.node, b.table, b.rows, b.traced)
    }

    // The background spool flush, per server. A server that is down flushes
    // nothing: its spool is on its own disk and waits for it to come back,
    // which is the whole risk of the background mode.
    for (let n = 0; n < N_NODES; n++) {
      const d = nodes[n].distributed
      if (nodes[n].status !== 'down') {
        for (let s = 0; s < N_SHARDS; s++) {
          const q = spool[n][s]
          while (q.length > 0 && q[0].due <= state.t) {
            const item = q[0]
            if (!deliverToShard(n, s, item.table, item.rows, 'spool', item.traced)) {
              /* The real queue NEVER drops a file. A failed send raises
               * `error_count` and the directory backs off exponentially —
               * `distributed_background_insert_sleep_time_ms` (100 ms) ×
               * 2^error_count, capped at 30 s — then tries again. One flat
               * nudge stands in for that curve at this timescale; what must
               * survive is that the file stays, so `data_files` keeps telling
               * the truth while the destination is refusing. */
              item.due = state.t + 1.5 + rng() * 1.5
              break
            }
            q.shift()
            d.pendingBlocks[s] = Math.max(0, d.pendingBlocks[s] - 1)
            d.pendingBytes[s] = Math.max(0, d.pendingBytes[s] - item.rows * rowCompressed[item.table])
          }
        }
      }
      d.activity = damp(d.activity, 0, 2.4, dt)
    }

    state.clients.activity = damp(state.clients.activity, 0, 2.4, dt)
  }

  /* Roughly the client corridor's travel time at its route speed, so the
   * split happens as the freight arrives. Approximate on purpose: matching
   * the animation exactly would couple the model to world geometry. */
  const CORRIDOR_S = 3.4
  /** Same idea for the server-to-server arcs; they vary by pair, this is the middle. */
  const WIRE_S = 2.6
  /** INSERT statements still visibly travelling the client corridor. */
  const inFlight: { init: number; table: number; rows: number; due: number; traced: boolean }[] = []
  /** Forwarded blocks still visibly crossing a server-to-server arc. */
  const onWire: { node: number; shard: number; table: number; rows: number; due: number; traced: boolean }[] = []

  /**
   * The block has reached the initiator's `Distributed` table: NOW the
   * sharding expression runs, one slice per shard leaves the building — down
   * to this server's own dock, or over the wire to the other shard — and the
   * ok goes back to the client. The ok departs AT the split, not at the far
   * end of the writes: with `distributed_foreground_insert = 0` (the default;
   * the setting was called `insert_distributed_sync` before 23.10) that
   * really is all the client waits for — except its OWN shard's slice, which
   * `prefer_localhost_replica` writes synchronously even then.
   */
  function splitAtDistributed(init: number, table: number, rows: number, traced: boolean): void {
    const d = nodes[init].distributed
    const blockId = blockSeq++
    shardBlock(init, rows, blockId)
    d.activity = Math.min(1, d.activity + 0.3)

    /* The whole block into the hash wheel, ONCE, at its full row count. Every
     * slice that leaves does so from there — down to the local dock, or into
     * the queue silo of the shard that owns it — so the difference in bulk
     * between the one duct in and the two out IS the split, shown rather than
     * stated. It is emitted before the loop for the same reason the wheel is
     * one building: the expression is evaluated once, over the whole block. */
    leg(traced, rid.distToWheel(init), 1, 'insert', flowSize(rows))

    for (let s = 0; s < N_SHARDS; s++) {
      const r = Math.round(shardRows[s])
      if (r <= 0) continue
      d.rowsToShard[s] += r
      if (K.distributedInsert === 'foreground' || s === shardOf(init)) {
        /* Foreground: the INSERT does not return until every shard has the
         * data — slower, and the only mode in which a client learns that a
         * shard is down.
         *
         * The initiator's OWN shard takes this path in BOTH modes:
         * `prefer_localhost_replica` (on by default) writes that slice into
         * the local table right now, synchronously, even with
         * `distributed_foreground_insert = 0`. It never enters the queue —
         * only the slices bound for OTHER shards are deferred. A "background"
         * INSERT is therefore partly synchronous. */
        deliverToShard(init, s, table, r, 'dist', traced)
      } else {
        // Parked: a .bin file in `data/<database>/<table>/shard<N>_all_replicas/`
        // on the disk of the server the client reached — the directory that
        // `system.distribution_queue` reports — flushed by a background thread.
        d.pendingBlocks[s]++
        d.pendingBytes[s] += r * rowCompressed[table]
        spool[init][s].push({ table, rows: r, due: state.t + 0.25 + rng() * 0.35, traced })
        leg(traced, rid.wheelToSpool(init, s), 1, 'insert', flowSize(r))
      }
    }
    /* The INSERT's answer is an ok, not data: a short pod however large the
     * batch was. That asymmetry — freight up the corridor, a receipt back
     * down it — IS the lesson, so the size is a constant near the floor. */
    leg(traced, rid.nodeToClient(init), 1, 'result', 0.2)
  }

  /**
   * `node`'s own Distributed table just split a block, and this slice belongs
   * to `node`'s own shard: it walks from the front door down to the dock of
   * the real table. Only that case — a forwarded slice coming off the wire
   * arrives AT the dock (`fan.insert.*` and `spool.flush.*` end there), because
   * the sender inserted into the underlying MergeTree table directly and the
   * receiving server's Distributed table never saw it.
   */
  function landBlock(node: number, table: number, rows: number, traced: boolean): void {
    leg(traced, rid.distToDock(node), 1, 'insert', flowSize(rows))
    dockBlock(node, table, rows, traced)
  }

  /** The slice is at `node`'s insert dock, however it got there: write it. */
  function dockBlock(node: number, table: number, rows: number, traced: boolean): void {
    // The async buffer ENDS this statement's journey: what comes out later is
    // one part built from many statements, and it reserves a journey of its own.
    if (K.asyncInsert) queueAsyncInsert(node, table, rows)
    else writeBlock(node, table, rows, traced)
  }

  /* The background INSERT queue — what `system.distribution_queue` reports.
   * Per server (it lives on the initiator's own disk), then per destination
   * shard. The real thing is one directory of .bin files per destination under
   * `data/<database>/<table>/`; the model keeps rows-per-shard, which is the
   * same information at this scale. */
  const spool: { table: number; rows: number; due: number; traced: boolean }[][][] = []
  for (let n = 0; n < N_NODES; n++) {
    const perShard: { table: number; rows: number; due: number; traced: boolean }[][] = []
    for (let s = 0; s < N_SHARDS; s++) perShard.push([])
    spool.push(perShard)
  }

  /** Replicas of `shard` that could acknowledge a write right now. */
  function liveReplicas(shard: number): number {
    let n = 0
    for (let r = 0; r < N_REPLICAS; r++) {
      const i = nodeIndex(shard, r)
      if (nodes[i].status !== 'down' && !nodes[i].replication.readOnly) n++
    }
    return n
  }

  /** How many replicas `insert_quorum` requires for this shard. */
  function quorumRequired(): number {
    switch (K.insertQuorum) {
      case 'one':
        return 1
      case 'majority':
        return Math.floor(N_REPLICAS / 2) + 1
      case 'all':
        return N_REPLICAS
      default:
        return 0
    }
  }

  /**
   * Send one shard's slice to one live replica of that shard, straight into
   * the underlying MergeTree table there. `origin` is which building the slice
   * physically leaves — the Distributed table itself (a foreground send, or
   * the local short-cut) or the background queue (a flush) — and it decides
   * which duct the packet rides, nothing else.
   *
   * Returns whether the slice was handed over. `false` means it was NOT:
   * a foreground caller treats that as the statement's error, the queue
   * flush treats it as "keep the file and retry later".
   */
  function deliverToShard(
    from: number,
    shard: number,
    table: number,
    rows: number,
    origin: 'dist' | 'spool',
    traced: boolean,
  ): boolean {
    /* `prefer_localhost_replica` (on by default): a sender that is itself a
     * replica of the target shard writes the slice to ITSELF — a plain local
     * insert, no connection pool, and therefore NO FAILOVER. Even read-only:
     * the slice still goes to this server and `writeBlock` refuses it there
     * with the real `Code: 242`, exactly as a direct local INSERT would fail.
     * It does not fall back to the sibling replica or to the queue. */
    const node = shardOf(from) === shard ? from : pickReplica(shard, true)
    if (node < 0) {
      if (state.t - connWarnT > 12) {
        connWarnT = state.t
        toast(`Code: 279. All connection tries failed for shard ${shard + 1}`, 'warn', 5000)
      }
      return false
    }

    /* `insert_quorum` is what turns a replica loss from a non-event into a write
     * outage. With it at 0 — the default — the write succeeds on one replica and
     * the others catch up through the log. With it at `all`, losing one replica
     * of a two-replica shard means the shard cannot accept writes at all, and
     * that is the trade the setting exists to let you make deliberately. */
    const need = quorumRequired()
    if (need > 0 && liveReplicas(shard) < need) {
      quorumFailures++
      if (state.t - quorumWarnT > 12) {
        quorumWarnT = state.t
        toast(
          `Code: 319. Unknown status of insert — insert_quorum (${need}) is greater than the number of live replicas on shard ${shard + 1}`,
          'warn',
          6000,
        )
      }
      return false
    }

    // Over the wire only when it is going to a DIFFERENT server. The wire ends
    // at the RECEIVER'S INSERT DOCK: the sender is inserting into the
    // underlying MergeTree table over its connection, and the receiving
    // server's Distributed table plays no part in it. The forwarded copy
    // becomes a part only when it comes OFF the wire (see onWire), so the
    // receiving yard never grows a tower before the pod that carries it has
    // visibly arrived.
    if (node !== from) {
      leg(traced, origin === 'spool' ? rid.spoolFlush(from, node) : rid.fanInsert(from, node), 1, 'insert', flowSize(rows))
      onWire.push({ node, shard, table, rows, due: state.t + WIRE_S, traced })
    } else {
      // `origin` can only be 'dist' here: the local shard's slice never
      // enters the queue (see splitAtDistributed), and a queue directory for
      // a REMOTE shard cannot flush to this server.
      landBlock(node, table, rows, traced)
    }
    return true
  }

  /* ======================================================================
   * THE READ PATH
   *
   * This is the sequence the whole project exists to make visible.
   *
   *   1. PARTITION PRUNING. The partition expression is evaluated against the
   *      WHERE clause and whole partitions are discarded without opening a file.
   *   2. THE PRIMARY INDEX. `primary.cidx` holds one row of the sorting key per
   *      granule — 8192 rows by default — so it is small enough to live in RAM
   *      permanently. A binary search over it turns a WHERE on a key prefix into
   *      a set of MARK RANGES. This is not a lookup index: it cannot find a row,
   *      only the granule a row must be in.
   *   3. SKIP INDEXES. Inside the surviving ranges, each `skp_idx_*.idx2` is
   *      consulted per index granule and granules it can prove irrelevant are
   *      dropped. They only ever *remove* work, never add precision.
   *   4. THE READ POOL. `MergeTreeReadPool` hands the surviving mark ranges to
   *      `max_threads` reader threads, smallest tasks last, so the threads
   *      finish together instead of one straggling.
   *   5. THE READERS. Each resolves a mark through the MARK CACHE, reads the
   *      compressed block it points at, checks the UNCOMPRESSED CACHE, and
   *      decompresses if it has to.
   *
   * `granulesTotal` → `granulesAfterKey` → `granulesAfterSkip` is the entire
   * story of why a ClickHouse query is fast or slow.
   * ====================================================================*/

  let pendingSelects = 0
  let nextSelectArrival = 0

  function tickClientSelect(dt: number): void {
    nextSelectArrival -= dt
    let guard = 400
    while (nextSelectArrival <= 0 && guard-- > 0) {
      pendingSelects++
      const gap = expDelay(K.selectsPerSec, rng)
      if (!isFinite(gap)) {
        nextSelectArrival = 1e9
        break
      }
      nextSelectArrival += gap
    }

    while (pendingSelects > 0) {
      pendingSelects--
      const table = weightedPick(selectWeights, rng)
      // The client→server hop is emitted inside `startDistributedQuery`, which
      // is where the server is chosen. Emitting it here would have to guess.
      startDistributedQuery(table)
    }
  }

  /** How a SELECT is shaped this time round — decided once, used by every shard. */
  interface QueryShape {
    prunePartitions: boolean
    usePrimaryKey: boolean
    useSkipIndex: number
    /**
     * Distinct GROUP BY keys each shard will end up with. 1 means a bare
     * aggregate with no GROUP BY at all.
     *
     * This is what decides the size of the answer, because the default stage for
     * a multi-shard query is `WithMergeableState`: the shard ships one row of
     * aggregate state per group, not the rows it read.
     */
    groups: number
    sql: string
  }

  function shapeQuery(table: number): QueryShape {
    const def = TABLES[table]
    const prune = rng() < K.partitionPruneRatio
    const pk = rng() < K.primaryKeyHitRatio
    const skipIdx = rng() < K.skipIndexUseRatio && def.skipIndexes.length > 0
      ? Math.floor(rng() * def.skipIndexes.length)
      : -1

    const keyCol = def.columns.find((c) => c.keyPos === 0)?.name ?? 'id'
    const skipCol = skipIdx >= 0 ? def.skipIndexes[skipIdx].expr : null
    const parts: string[] = []
    if (prune) parts.push(`${def.partitionBy.replace(/\(.*\)/, '(…)')} = …`)
    if (pk) parts.push(`${keyCol} = …`)
    if (skipCol) parts.push(`${skipCol} = …`)
    const where = parts.length ? ` WHERE ${parts.join(' AND ')}` : ''

    /* WHAT THE ANSWER WILL COST, which is a different question from what the
     * query will read.
     *
     * Compression ratio stands in for cardinality here, because it is the same
     * property seen from the other side: a column ClickHouse compresses 30× is a
     * column with few distinct values. So grouping by a well-compressed column
     * gives a handful of groups, and grouping by a poorly-compressed one can give
     * more groups than `group_by_two_level_threshold` — at which point the shard's
     * hash table goes two-level and the states it ships carry bucket numbers. */
    const roll = rng()
    let groups = 1
    let groupCol: string | null = null
    if (roll > 0.35) {
      const wide = roll > 0.82
      const cands = def.columns.filter((c) => (wide ? c.ratio <= 5 : c.ratio > 8))
      const col = cands.length > 0 ? cands[Math.floor(rng() * cands.length)] : def.columns[0]
      groupCol = col.name
      groups = wide
        ? Math.round(60_000 + rng() * 900_000)
        : Math.round(4 + rng() * 400)
    }
    const groupBy = groupCol ? ` GROUP BY ${groupCol}` : ''
    const select = groupCol ? `${groupCol}, count(), sum(…)` : 'count(), sum(…)'
    const sql = `SELECT ${select} FROM ${def.name}${where}${groupBy}`

    return { prunePartitions: prune, usePrimaryKey: pk, useSkipIndex: skipIdx, groups, sql }
  }

  function startDistributedQuery(table: number): void {
    // Same as an INSERT: the client picks a server, and that server is the
    // initiator. It is not a special node — it is about to read its own shard
    // alongside the shard it asks the others for.
    const init = pickInitiator()
    if (init < 0) {
      toast('Code: 210. Connection refused — no server is reachable', 'warn', 4000)
      return
    }
    const shape = shapeQuery(table)
    const d = nodes[init].distributed
    noteClientStatement(init)
    state.clients.lastSelectTarget = init
    d.queriesInitiated++
    /* A SELECT leaving the client is a STATEMENT, not data: a few hundred bytes
     * of SQL however much it is about to read, so its size is a CONSTANT and not
     * a `flowSize` — being unmoved by the row counts is the point.
     *
     * But not an arbitrarily small constant. The client routes are the longest
     * in the model — five hundred units, seen from an establishing shot a
     * thousand units back — and at 0.6 the statement and its answer were both
     * under a pixel there, so "the application asks and is answered" had
     * silently stopped being drawn at all. Honesty about volume does not get to
     * cost a mechanism its visibility. */
    flow(rid.clientToNode(init), 1, 'query', 1.05)
    let fanned = 0
    for (let s = 0; s < N_SHARDS; s++) {
      const primary = pickReplica(s, false)
      if (primary < 0) {
        toast(`Code: 279. All connection tries failed for shard ${s + 1}`, 'warn', 4000)
        continue
      }
      d.readShard[s] = primary
      // `parallel_replicas` splits ONE shard's mark ranges across its replicas,
      // so both replicas read a share of the same data instead of one reading
      // all of it. It is the only setting here that changes how much *work* a
      // shard does rather than which node does it.
      if (K.parallelReplicas) {
        for (let r = 0; r < N_REPLICAS; r++) {
          const n = nodeIndex(s, r)
          if (nodes[n].status === 'down') continue
          if (startNodeQuery(n, init, table, shape, 1 / N_REPLICAS)) fanned++
        }
      } else if (startNodeQuery(primary, init, table, shape, 1)) {
        fanned++
      }
    }
    // `fanOut` is recomputed from the live queries once per step in `step`, so
    // it is not assigned here; `fanned` is only used to tell "the fan-out found
    // no reachable shard at all" from "it found some".
    if (fanned === 0) d.readShard.fill(-1)
    d.activity = Math.min(1, d.activity + 0.25)
  }

  /**
   * Plan and start one SELECT on one node. `share` is the fraction of the mark
   * ranges this node is responsible for — 1 normally, 1/replicas with
   * `parallel_replicas`.
   */
  function startNodeQuery(
    node: number,
    initiator: number,
    table: number,
    shape: QueryShape,
    share: number,
  ): boolean {
    const n = nodes[node]
    if (n.status === 'down') return false
    if (n.queries.length >= 6) return false // `max_concurrent_queries`

    const def = TABLES[table]
    const nt = n.tables[table]

    /* --- 1. partition pruning -------------------------------------------
     * Everything in steps 1–4 happens at PLAN time, in `selectRangesToRead`,
     * before there is a pipeline to run it in — so the predicate goes to the
     * planner and not to the pool. Whole PARTS are what this step removes, by the
     * partition key, the partition minmax index and column statistics, without
     * opening one index file. */
    flow(rid.queryToAnalysis(node), 1, 'query', 0.9)
    let partsSelected = 0
    let partsTotal = 0
    let granulesTotal = 0
    const targetPartition = shape.prunePartitions ? def.partitions - 1 : -1
    for (const p of nt.parts) {
      if (p.state !== 'active') continue
      partsTotal++
      if (targetPartition >= 0 && p.partition !== targetPartition) continue
      partsSelected++
      // marks_count - 1 is the granule count: the last mark only terminates.
      granulesTotal += Math.max(1, p.marks - 1)
      p.heat = Math.min(1, p.heat + 0.35)
    }
    if (partsSelected === 0) return false

    /* --- 2. the primary index ------------------------------------------- */
    // A binary search over `primary.cidx` yields the granules whose key range
    // can contain a match — normally a handful. Without a usable key prefix
    // there is no search to do and every granule survives, which is a full scan
    // of the selected partitions and is exactly what a missing ORDER BY costs.
    let granulesAfterKey = granulesTotal
    if (shape.usePrimaryKey) {
      // The first key column's cardinality decides how tight the range is. A
      // UUID sorting key is sorted but useless for a range scan on anything
      // else, which is why `sessions` gains far less here than `hits` does.
      const keyCol = def.columns.find((c) => c.keyPos === 0)
      const tightness = keyCol && keyCol.ratio > 20 ? 0.004 : keyCol && keyCol.ratio > 5 ? 0.02 : 0.09
      granulesAfterKey = Math.max(1, Math.round(granulesTotal * tightness * (0.6 + rng() * 0.8)))
    }
    /* ONE POD PER PART, not one per table.
     *
     * `MergeTreeDataSelectExecutor` schedules one analysis task PER PART on its
     * own thread pool and waits for all of them, so the honest picture is a
     * handful of pods going up the rack at once — each one a part opening its own
     * `primary.cidx`. The count is capped so a node holding a hundred selected
     * parts does not spend the whole frame budget here; the query's own
     * `partsSelected` still reports the truth. Each pod carries the granules THAT
     * PART had to consider, which is why a query with no usable key prefix sends
     * visibly bigger pods than one landing on a narrow range. */
    const probes = Math.min(partsSelected, ANALYSIS_PODS)
    const granulesPerPart = Math.max(1, Math.round(granulesTotal / partsSelected))
    flow(rid.probeIndex(node, table), probes, 'mark_read', flowSize(granulesPerPart), 0.05)

    /* --- 3. skip indexes ------------------------------------------------ */
    let granulesAfterSkip = granulesAfterKey
    if (shape.useSkipIndex >= 0) {
      const idx = def.skipIndexes[shape.useSkipIndex]
      // A skip index works on `granularity` index granules at a time, so it can
      // never be more precise than that block — which is why a granularity of 4
      // on a highly selective predicate still leaves four granules to read.
      const block = idx.granularity
      const blocks = Math.ceil(granulesAfterKey / block)
      const survivingBlocks = Math.max(1, Math.round(blocks * (1 - idx.selectivity)))
      granulesAfterSkip = Math.min(granulesAfterKey, survivingBlocks * block)
      flow(
        rid.probeSkip(node, table),
        probes,
        'mark_read',
        flowSize(Math.max(1, Math.round(granulesAfterKey / partsSelected))),
        0.05,
      )
    }

    granulesAfterSkip = Math.max(1, Math.round(granulesAfterSkip * share))

    /* The per-part answers coming back, and then ONE list going to the pool.
     * The seam between planning and execution: after this pod the query is I/O,
     * and nothing downstream ever consults an index again. */
    flow(
      rid.skipToAnalysis(node, table),
      probes,
      'mark_read',
      flowSize(Math.max(1, Math.round(granulesAfterSkip / partsSelected))),
      0.05,
    )
    flow(rid.rangesToPool(node), 1, 'mark_read', flowSize(granulesAfterSkip))

    /* --- 4. marks, and what the mark cache does about them --------------
     * The cache is TOUCHED here because the query's mark working set is known
     * here, but nothing is drawn arriving at the pool: `.mrk3` is resolved by the
     * thread that is about to seek, and the pod for it leaves the mark cache for
     * a reader BAY in `startReader`. Index analysis, just above, used the index
     * caches instead — a different pair entirely. */
    const marksNeeded = granulesAfterSkip * streams[table]
    const markBytes = marksNeeded * MARK_BYTES
    const markHit = touchCache(n.markCache, markBytes, markWorkingSet(node, table))

    /* --- 5. bytes, threads, and time ------------------------------------ */
    const rowsRead = granulesAfterSkip * INDEX_GRANULARITY
    // A query reads the columns it names, not the whole row — that is the entire
    // point of a column store. Model it as the sorting key plus a couple of
    // payload columns, which is a realistic analytical query.
    const readCols = Math.min(def.columns.length, 2 + def.columns.filter((c) => c.keyPos >= 0).length)
    let bytesPerRow = 0
    for (let i = 0; i < readCols; i++) bytesPerRow += def.columns[i].bytesPerRow / def.columns[i].ratio
    const bytesRead = rowsRead * bytesPerRow

    const blockHit = K.uncompressedCacheMib > 0
      ? touchCache(n.uncompressedCache, rowsRead * bytesPerRow * 6, hotDataBytes(node, table))
      : false
    if (K.uncompressedCacheMib <= 0) n.uncompressedCache.misses++

    // `max_threads` is a ceiling, not an allocation: what the pool actually uses
    // is however many `merge_tree_min_rows_for_concurrent_read` shares the work
    // divides into. An indexed lookup therefore lights one bay and a full scan
    // lights all of them, with the same `max_threads`.
    const threads = clamp(
      Math.min(K.maxThreads, Math.ceil(granulesAfterSkip / MIN_MARKS_FOR_CONCURRENT_READ)),
      1,
      N_READ_THREADS,
    )

    // The device read has to be paid for; a mark-cache miss adds a seek per
    // stream, and a decompression that the uncompressed cache could have
    // avoided adds CPU. Cold-volume parts cost about six times as much.
    const coldShare = coldFraction(node, table)
    const throughput =
      HOT_READ_BYTES_PER_SEC * (1 - coldShare) + COLD_READ_BYTES_PER_SEC * coldShare
    const ioPressure = 1 + 2.2 * clamp01(ioLoad[node] - 1)
    const seekPenalty = markHit ? 0 : (marksNeeded / 4096) * 0.02
    const decompress = blockHit ? 0 : bytesRead / (1200 * MIB)
    /* MIN_QUERY_SECONDS is a presentation floor, and it is honest about being
     * one: a real point lookup finishes in under a millisecond, and a query that
     * completes inside one 1/30 s model step can never light a reader bay, never
     * appear in `system.processes`, and never be observed at all. The floor is
     * applied to the total, so the RELATIVE cost of a full scan against an
     * indexed lookup is unchanged — only the very bottom of the range is lifted
     * off the frame boundary. */
    const duration = Math.max(
      MIN_QUERY_SECONDS,
      ((bytesRead / Math.max(1, throughput)) * ioPressure + seekPenalty + decompress) / threads + 0.02,
    )

    const q: QuerySim = {
      id: state.nextQueryId++,
      node,
      initiator,
      table,
      active: true,
      sql: shape.sql,
      partsTotal,
      partsSelected,
      granulesTotal,
      granulesAfterKey,
      granulesAfterSkip,
      rowsRead: 0,
      bytesRead: 0,
      /* What this shard will actually SEND: one row of aggregate state per group
       * it saw. The shape's `GROUP BY` cardinality bounds it, and the rows read
       * bound it too — a shard cannot report more groups than it has rows. This is
       * the number that crosses the network at stage `WithMergeableState`, and the
       * reason a distributed aggregate on a low-cardinality key is nearly free
       * however much data it read. */
      groups: Math.max(1, Math.min(shape.groups, rowsRead)),
      threads,
      analysing: true,
      analysisDuration: Math.min(duration * 0.35, 0.12),
      elapsed: 0,
      duration,
      // `max_memory_usage`: an aggregation holds one hash table per thread plus
      // the blocks in flight. This is why raising `max_threads` raises memory.
      memoryBytes: threads * 4 * MIB + granulesAfterSkip * streams[table] * 512,
      merged: false,
    }
    n.queries.push(q)
    n.queriesServed++
    nt.heat = Math.min(1, nt.heat + 0.25)
    // Only a remote shard costs a network hop. The initiator's own share of the
    // reading never leaves the machine.
    // Also a statement and not data — the initiator forwards the SQL, not rows.
    if (node !== initiator) flow(rid.fanQuery(initiator, node), 1, 'query', 0.95)

    /* NOT `assignReaders(node, q)` HERE.
     *
     * There is no pool yet. Analysis is still running — one task per part — and
     * the pool is created from its result, so the threads are handed their queues
     * in `tickQueries` when `analysing` goes false. Assigning them here drew
     * threads reading granules that the skip index had not finished discarding. */
    return true
  }

  /* The work list the index analysis hands the pool: one entry per part that
   * still has marks to read. Allocated once — `assignReaders` runs on every
   * SELECT, and the read-heavy scenarios run dozens per second.
   *
   * A node can hold more active parts than this; those are simply not dealt out,
   * and the query's own `granulesAfterSkip` still reports every granule it will
   * read. The window is on the DEAL, never on the counters. */
  const WORK_PARTS = 256
  const workSlot = new Int32Array(WORK_PARTS)
  const workMarks = new Int32Array(WORK_PARTS) // marks in this part the query must read
  const workTotal = new Int32Array(WORK_PARTS) // marks in the whole part
  const workBegin = new Int32Array(WORK_PARTS) // where inside the part its surviving range starts

  /**
   * `MergeTreeReadPool` — `fillPerThreadInfo` and `getTask`.
   *
   * What the pool receives is a LIST OF (part, mark ranges), and its job is to
   * cut that list up, not to hand out parts. So a thread's workload is a handful
   * of ranges that can come from several different parts — each with its own
   * `primary.cidx` and its own skip-index files — and one part is normally being
   * read by several threads at once. That is the fact this function exists to
   * produce; a pool that gave one part to one thread would be a queue, and would
   * stall on whichever thread drew the biggest part.
   *
   * Two real behaviours follow, and both are modelled:
   *
   *   - the deal walks the concatenated list, so a thread's share can start in
   *     the middle of one part's range and end in the middle of another's;
   *   - a thread with room comes back for what is left over rather than idling,
   *     which is `getTask` stealing off the back of another thread's queue.
   */
  function assignReaders(node: number, q: QuerySim): void {
    const n = nodes[node]
    const nt = n.tables[q.table]

    /* --- the work list -------------------------------------------------- */
    let w = 0
    let marksSelectable = 0
    for (const p of nt.parts) {
      if (p.state !== 'active') continue
      if (w >= WORK_PARTS) break
      const total = Math.max(1, p.marks - 1)
      workSlot[w] = p.slot
      workTotal[w] = total
      marksSelectable += total
      w++
    }
    if (w === 0) return

    /* Every part carries the WHOLE key range of the table — parts are sorted
     * within themselves, not against each other — so a range predicate leaves a
     * piece of nearly every part behind, roughly in proportion to its size. This
     * is why merging parts speeds up a key lookup: fewer ranges to seek to, not
     * fewer rows to read. */
    let dealt = 0
    for (let i = 0; i < w; i++) {
      const share = Math.round((q.granulesAfterSkip * workTotal[i]) / marksSelectable)
      const marks = clamp(share, 1, workTotal[i])
      workMarks[i] = marks
      // The surviving range is somewhere inside the part, not at its head.
      workBegin[i] = Math.floor(rng() * (workTotal[i] - marks + 1))
      dealt += marks
    }

    /* --- the deal -------------------------------------------------------
     * `min_marks_per_thread = (sum_marks - 1) / threads + 1`: an even split of
     * MARKS, floored by `merge_tree_min_read_task_size`. The unevenness a viewer
     * sees comes from part boundaries and from stealing, not from the split. */
    const perThread = Math.max(MIN_READ_TASK_MARKS, Math.ceil(dealt / q.threads))
    let pi = 0 // cursor into the work list
    let off = 0 // marks already taken out of workMarks[pi]
    let assigned = 0
    let lastDealt = -1
    for (const r of n.readers) {
      if (assigned >= q.threads || pi >= w) break
      if (r.state !== 'idle') continue
      r.taskCount = 0
      r.marksTotal = 0
      r.stolenFrom = -1
      let want = perThread
      while (want > 0 && pi < w && r.taskCount < MAX_READ_TASKS) {
        const avail = workMarks[pi] - off
        if (avail <= 0) {
          pi++
          off = 0
          continue
        }
        const take = Math.min(avail, want)
        const task = r.tasks[r.taskCount++]
        task.table = q.table
        task.part = workSlot[pi]
        task.marksInPart = workTotal[pi]
        task.markBegin = workBegin[pi] + off
        task.markEnd = task.markBegin + take
        r.marksTotal += take
        off += take
        want -= take
      }
      if (r.marksTotal === 0) continue
      startReader(node, r, q)
      lastDealt = r.slot
      assigned++
    }

    /* --- stealing ------------------------------------------------------- */
    /* Work is left only when the threads that were dealt to filled their queues.
     * A thread that still has room takes it rather than waiting, and records
     * whose remainder it was — which is the difference between a pool and a
     * static split, and the reason `max_threads` threads do not finish at
     * `max_threads` different times. */
    if (pi < w) {
      for (const r of n.readers) {
        if (pi >= w) break
        if (readerQuery[node * N_READ_THREADS + r.slot] !== q.id) continue
        if (r.taskCount >= MAX_READ_TASKS) continue
        let stole = 0
        while (pi < w && r.taskCount < MAX_READ_TASKS) {
          const avail = workMarks[pi] - off
          if (avail <= 0) {
            pi++
            off = 0
            continue
          }
          const task = r.tasks[r.taskCount++]
          task.table = q.table
          task.part = workSlot[pi]
          task.marksInPart = workTotal[pi]
          task.markBegin = workBegin[pi] + off
          task.markEnd = task.markBegin + avail
          r.marksTotal += avail
          stole += avail
          off += avail
        }
        if (stole > 0 && r.slot !== lastDealt) r.stolenFrom = lastDealt
      }
    }
  }

  /** Put one thread to work on the queue `assignReaders` just filled for it. */
  function startReader(node: number, r: ReaderSim, q: QuerySim): void {
    const n = nodes[node]
    r.state = 'seeking'
    r.marksDone = 0
    r.column = 0
    r.progress = 0
    r.query = q.id
    r.markCacheHit = n.markCache.hitRatio > rng()
    r.blockCacheHit = K.uncompressedCacheMib > 0 && n.uncompressedCache.hitRatio > rng()
    readerQuery[node * N_READ_THREADS + r.slot] = q.id
    // The reading, not the whole query: planning is already over by the time a
    // thread exists, so a bay's bar must not include it.
    readerDuration[node * N_READ_THREADS + r.slot] = Math.max(0.05, q.duration - q.analysisDuration)
    /* Before it can seek, the thread needs the `.mrk3` entry — from the MarkCache,
     * per part and per stream, and this is the only step that touches it. */
    flow(rid.markToReader(node, r.slot), 1, 'mark_read', flowSize(r.marksTotal))
    /* The pod handed to a thread is the SIZE OF ITS QUEUE, so the pool's uneven
     * dealing is visible as unequal pods arriving at the bays. Its bulk is a
     * count of MARKS, like every other pod on the analysis legs — what travels
     * here is a task list, and sizing it by the rows those marks stand for made a
     * full scan's task list bigger than the data it describes. */
    flow(rid.poolToReader(node, r.slot), 1, 'mark_read', flowSize(r.marksTotal))
  }

  const readerQuery = new Int32Array(N_NODES * N_READ_THREADS).fill(-1)
  const readerDuration = new Float64Array(N_NODES * N_READ_THREADS).fill(1)
  const readerStateT = new Float64Array(N_NODES * N_READ_THREADS)

  /** The reader-thread state machine: seek → read → decompress → filter. */
  function tickReaders(node: number, dt: number): void {
    const n = nodes[node]
    for (const r of n.readers) {
      if (r.state === 'idle') continue
      const k = node * N_READ_THREADS + r.slot
      readerStateT[k] += dt
      const total = Math.max(0.05, readerDuration[k])
      r.progress = clamp01(readerStateT[k] / total)

      // The four states are unequal on purpose. A mark-cache hit makes the seek
      // nearly free; a decompression that the uncompressed cache could have
      // served is nearly free too. The shape of the bar tells you which cache
      // is doing the work.
      const seekEnd = r.markCacheHit ? 0.04 : 0.22
      const readEnd = seekEnd + 0.44
      const decompressEnd = readEnd + (r.blockCacheHit ? 0.04 : 0.26)

      const p = r.progress
      if (p < seekEnd) r.state = 'seeking'
      else if (p < readEnd) r.state = 'reading'
      else if (p < decompressEnd) r.state = 'decompressing'
      else if (p < 0.94) r.state = 'filtering'
      else r.state = 'aggregating'

      r.marksDone = Math.round(r.marksTotal * p)
      r.column = Math.min(TABLES[0].columns.length - 1, Math.floor(p * 4))

      if (r.state === 'reading' && rng() < dt * 8) {
        /* The stripe leaves the PART the thread is on right now, and each thread
         * has its own lane back. Before this there was one route per node, so
         * eight threads reading eight different parts sent everything up a single
         * duct — which is what made the pool look like a funnel with one input
         * instead of the many-to-many it is. */
        const task = r.tasks[currentTask(r)]
        const marks = Math.max(1, task.markEnd - task.markBegin)
        // One BLOCK, not one task: `max_block_size` rows, or the whole range if
        // it is smaller than that. A stripe is a block leaving the reader.
        const rows = Math.min(MAX_BLOCK_ROWS, marks * INDEX_GRANULARITY)
        flow(rid.readerToResult(node, r.slot), 1, 'column_read', flowSize(rows))
      }

      if (p >= 1) {
        r.state = 'idle'
        r.taskCount = 0
        r.marksTotal = 0
        r.stolenFrom = -1
        r.query = -1
        r.progress = 0
        r.marksDone = 0
        readerStateT[k] = 0
        readerQuery[k] = -1
      }
    }
  }

  function tickQueries(node: number, dt: number): void {
    const n = nodes[node]
    for (let i = n.queries.length - 1; i >= 0; i--) {
      const q = n.queries[i]
      q.elapsed += dt
      /* PLANNING FIRST, then reading. While `analysing` the query is in
       * `selectRangesToRead`, so no thread has been handed anything and no row
       * has been read; the pool is created from the analysis result, which is the
       * moment the threads get their queues. */
      if (q.analysing) {
        if (q.elapsed < q.analysisDuration) continue
        q.analysing = false
        assignReaders(node, q)
        continue
      }
      const p = clamp01(q.elapsed / q.duration)
      q.rowsRead = Math.round(q.granulesAfterSkip * INDEX_GRANULARITY * p)
      q.bytesRead = Math.round(q.granulesAfterSkip * INDEX_GRANULARITY * p * 12)
      selectRowsAcc[node] += q.granulesAfterSkip * INDEX_GRANULARITY * (dt / q.duration)
      if (p >= 1) {
        // The partial result goes back to the server that fanned the query out,
        // which merges it with the other shard's. Only that server ever sees the
        // whole answer, and the merging is real CPU work done on it — which is
        // why pointing every client at one hostname concentrates load that the
        // data distribution alone would have spread.
        const d = nodes[q.initiator].distributed
        /* WHAT CROSSES THE WIRE IS THE STATE, NOT THE ROWS.
         *
         * The default stage for a multi-shard query is `WithMergeableState`: the
         * shard finishes its own aggregation and ships a non-finalised state, one
         * row per group. So the pod's bulk is `groups`, and the bytes counted are
         * the state's bytes — roughly a key and an accumulator per group.
         *
         * This used to be `flowSize(q.rowsRead)`, which drew a billion-row scan
         * dragging a billion rows across the network, and the model's own
         * `node.resultmerge` doc contradicted it on screen. */
        const stateBytes = q.groups * 48
        if (node !== q.initiator) {
          flow(rid.fanResult(node, q.initiator), 1, 'result', flowSize(q.groups))
          // Bytes over the wire, which is what `bytesFromRemote` means. The
          // initiator's own share never crosses it — `prefer_localhost_replica`
          // runs it in-process, at the same stage, with no socket.
          d.bytesFromRemote += stateBytes
        }
        d.rowsMerged += q.groups
        d.activity = Math.min(1, d.activity + 0.2)
        // And the answer home is the merged, finalised result: still one row per
        // group, so an aggregate that scanned a billion rows leaves by the same
        // door as one that scanned a thousand.
        flow(rid.nodeToClient(q.initiator), 1, 'result', flowSize(q.groups))
        queryMsAcc += q.duration * 1000
        queryMsCount++
        n.queries.splice(i, 1)
      }
    }
  }

  /* ======================================================================
   * CACHES
   *
   * The mark cache is the one nobody thinks about until it is too small. It
   * holds `.mrk3` entries, and a reader cannot start reading a column until it
   * has the mark that says where in the `.bin` to seek. On a wide table with
   * hundreds of streams that working set is measured in gigabytes, and a miss
   * costs a real disk seek per stream.
   *
   * The uncompressed cache is the opposite: OFF by default, and correctly so.
   * It only pays for itself on a workload that reads the same small set of
   * granules over and over. On an analytical scan it is pure eviction churn,
   * which is why `uncompressed_cache_size` defaults to 0 in this model too.
   * ====================================================================*/

  /** Bytes of marks one node's table would need fully resident. */
  function markWorkingSet(node: number, table: number): number {
    const nt = nodes[node].tables[table]
    let marks = 0
    for (const p of nt.parts) if (p.state === 'active') marks += p.marks
    return marks * streams[table] * MARK_BYTES * MARK_SET_SERVER_FACTOR
  }

  /** Bytes of the recently-read granules — the uncompressed cache's target. */
  function hotDataBytes(node: number, table: number): number {
    const nt = nodes[node].tables[table]
    // The hot set is the newest partition plus whatever a primary-key query
    // keeps hitting. Roughly a twentieth of the table, which is generous.
    return nt.bytesUncompressed * 0.05 + COMPRESS_BLOCK_BYTES
  }

  /**
   * One cache access. `want` is the bytes this access needs; `workingSet` is the
   * bytes the workload would need fully resident. The hit probability is the
   * share of the working set the cache can actually hold — the simplest model
   * that gets the *shape* right, including the cliff when the working set
   * outgrows the cache.
   */
  function touchCache(cache: CacheSim, want: number, workingSet: number): boolean {
    if (cache.capacityBytes <= 0) {
      cache.misses++
      return false
    }
    const resident = clamp01(cache.capacityBytes / Math.max(1, workingSet))
    // Warm caches are better than the ratio suggests, because the workload is
    // not uniform: the newest partition is read far more than the oldest.
    const skewed = clamp01(Math.pow(resident, 0.55))
    const hit = rng() < skewed
    if (hit) cache.hits++
    else {
      cache.misses++
      if (cache.usedBytes + want > cache.capacityBytes) cache.evictions++
    }
    cache.usedBytes = Math.min(cache.capacityBytes, Math.max(cache.usedBytes, cache.capacityBytes * skewed))
    return hit
  }

  function tickCaches(node: number, dt: number): void {
    const n = nodes[node]
    for (const c of [n.markCache, n.uncompressedCache]) {
      const seen = c.hits + c.misses
      const target = seen > 0 ? c.hits / seen : 0
      c.hitRatio = damp(c.hitRatio, target, 0.6, dt)
    }
  }

  /* ======================================================================
   * MERGES — `system.merges`
   *
   * The merge selector is not a queue. Every few seconds each node looks at
   * every partition of every table and asks one question: is there a RANGE OF
   * ADJACENT PARTS worth merging? Adjacency is by block number, and the range
   * may not cross a partition boundary, ever — that is what makes PARTITION BY
   * a physical guarantee rather than a hint.
   *
   * `SimpleMergeSelector` prefers a range whose total size is at least `base`
   * times its largest member, which is what builds the roughly-logarithmic
   * ladder of merge levels you see in part names. A range where one part
   * dominates the others is a bad merge: it rewrites a large part to gain very
   * little, and the selector will wait for the small parts to accumulate first.
   * ====================================================================*/

  /** Scratch, reused so the selector allocates nothing per tick. */
  const selectorParts: PartSim[] = []
  const selectorBest: PartSim[] = []

  interface MergeCandidate {
    parts: PartSim[]
    partition: number
    reason: MergeReason
    score: number
  }

  const candidate: MergeCandidate = { parts: [], partition: 0, reason: 'regular', score: 0 }

  /**
   * Pick the best merge for one table on one node, or return false.
   *
   * The TTL check runs FIRST and ignores the size limits, because a TTL merge
   * exists to remove data, not to reduce the part count. That ordering is the
   * whole reason `merge_with_ttl_timeout` is a separate setting: without it a
   * large part whose rows have expired would never be selected on size grounds
   * and its expired rows would live forever.
   */
  function selectMerge(node: number, table: number): boolean {
    const nt = nodes[node].tables[table]
    const def = TABLES[table]
    const maxBytes = K.maxBytesToMergeGib * GIB

    /* --- TTL first ------------------------------------------------------ */
    if (K.ttlEnabled && def.ttlSeconds) {
      let bestPart: PartSim | null = null
      let bestExpiry = Infinity
      for (const p of nt.parts) {
        if (p.state !== 'active' || p.reserved) continue
        if (p.ttlMin >= state.t) continue // nothing in it has expired yet
        const last = ttlMergedAt.get(p.name) ?? -1e9
        if (state.t - last < K.mergeWithTtlTimeout) continue
        if (p.ttlMin < bestExpiry) {
          bestExpiry = p.ttlMin
          bestPart = p
        }
      }
      if (bestPart) {
        candidate.parts.length = 0
        candidate.parts.push(bestPart)
        candidate.partition = bestPart.partition
        // A part every row of which has expired does not need rewriting at all —
        // and with `ttl_only_drop_parts` ClickHouse does not rewrite it, it
        // deletes the directory. That is the cheapest possible TTL, and it is
        // why a partition key aligned with the TTL is worth designing for.
        candidate.reason = K.ttlMoveToCold ? 'ttl_recompress' : 'ttl_delete'
        candidate.score = 1e9
        return true
      }
    }

    /* --- the regular size-based selector -------------------------------- */
    let found = false
    candidate.score = -1
    for (let partition = 0; partition < def.partitions; partition++) {
      const ps = activeInPartition(nt, partition, selectorParts)
      if (ps.length < MERGE_MIN_PARTS) continue

      // Every window of adjacent parts is a candidate. `SimpleMergeSelector`
      // scores by "how uniform are these, and how much does merging them buy",
      // and this is the same shape: total bytes over the largest member.
      for (let begin = 0; begin < ps.length - 1; begin++) {
        let sumBytes = 0
        let maxPartBytes = 0
        let sumRows = 0
        for (let end = begin; end < Math.min(ps.length, begin + MERGE_MAX_PARTS); end++) {
          const p = ps[end]
          sumBytes += p.bytesOnDisk
          sumRows += p.rows
          if (p.bytesOnDisk > maxPartBytes) maxPartBytes = p.bytesOnDisk
          const count = end - begin + 1
          if (count < MERGE_MIN_PARTS) continue
          // `max_bytes_to_merge_at_max_space_in_pool`: past this the merge is
          // refused outright, which is why very large parts stop merging and a
          // mature table settles at a few big parts per partition rather than one.
          if (sumBytes > maxBytes) break

          const uniformity = sumBytes / Math.max(1, maxPartBytes)
          // The selector wants `uniformity >= base`. Below that it prefers to
          // wait: merging a 100 GiB part with a 1 MiB part rewrites 100 GiB to
          // remove one part, and doing that repeatedly is how a cluster spends
          // its whole disk budget on write amplification.
          if (uniformity < MERGE_SELECTOR_BASE && nt.activeParts < K.partsToDelayInsert) continue
          // Under insert pressure ClickHouse becomes far less fussy: reducing
          // the part count is suddenly worth the write amplification.
          const pressure = nt.activeParts >= K.partsToDelayInsert ? 4 : 1
          const score = uniformity * pressure * count
          if (score > candidate.score) {
            candidate.score = score
            candidate.partition = partition
            candidate.reason = 'regular'
            selectorBest.length = 0
            for (let i = begin; i <= end; i++) selectorBest.push(ps[i])
            found = true
          }
          void sumRows
        }
      }
    }
    if (found) {
      candidate.parts.length = 0
      for (const p of selectorBest) candidate.parts.push(p)
    }
    return found
  }

  /** Keyed by part NAME: a slot is not a unique identity once -1 exists. */
  const ttlMergedAt = new Map<string, number>()

  /** Seconds since this node last ran its merge selector. */
  const selectorTimer = new Float64Array(N_NODES)
  const SELECTOR_PERIOD = 0.35

  function freeMergeSlot(node: number): MergeSim | null {
    const n = nodes[node]
    const limit = Math.min(K.mergePoolSize, N_MERGE_SLOTS)
    let running = 0
    for (const m of n.merges) if (m.active) running++
    if (running >= limit) return null
    for (const m of n.merges) if (!m.active) return m
    return null
  }

  /**
   * Start one merge on one node.
   *
   * `announce` is load-bearing. Only the replica that DECIDED a merge writes the
   * `MERGE_PARTS` entry to `/log`; a replica performing a merge because it read
   * such an entry must not write another one. Announcing unconditionally made the
   * two replicas of a shard ping-pong merge instructions at each other: every
   * execution produced a fresh entry for the sibling, both queues saturated
   * within a minute, and `absolute_delay` climbed for the rest of the session on
   * a cluster where nothing was wrong.
   */
  function startMerge(node: number, table: number, announce = true, forced = false): boolean {
    const slot = freeMergeSlot(node)
    if (!slot) return false
    // `forced` means the caller has already filled `candidate` — OPTIMIZE, which
    // ignores the size limits by design. Running the selector here would silently
    // throw that away and merge something else instead, which is what the earlier
    // version did: OPTIMIZE FINAL prepared a whole-partition merge and then got
    // whatever the ordinary heuristic happened to like.
    if (!forced && !selectMerge(node, table)) return false
    if (forced && candidate.parts.length < MERGE_MIN_PARTS) return false

    const def = TABLES[table]
    const nt = nodes[node].tables[table]
    const inputs = candidate.parts

    let rows = 0
    let bytes = 0
    let minBlock = Infinity
    let maxBlock = -Infinity
    let level = 0
    for (const p of inputs) {
      p.reserved = true
      // Read-hot from the instant it is reserved, not from the next step's
      // tickParts: the selector runs after tickParts in the same step, so
      // deferring this left every merge's first frame showing cold inputs.
      p.heat = Math.max(p.heat, 0.85)
      rows += p.rows
      bytes += p.bytesOnDisk
      if (p.minBlock < minBlock) minBlock = p.minBlock
      if (p.maxBlock > maxBlock) maxBlock = p.maxBlock
      if (p.level > level) level = p.level
    }

    // TTL removes rows, so the result is smaller than its input. That is the
    // only case in which a merge's output has fewer rows than its inputs, and it
    // is why `rows_written < rows_read` in `system.part_log` means "TTL ran".
    let resultRows = rows
    if (candidate.reason === 'ttl_delete') {
      const p = inputs[0]
      const span = Math.max(1e-6, p.ttlMax - p.ttlMin)
      const expiredShare = clamp01((state.t - p.ttlMin) / span)
      resultRows = Math.round(rows * (1 - expiredShare))
    }

    /* --- which algorithm, and what it costs in memory ------------------- */
    // `enable_vertical_merge_algorithm`. A HORIZONTAL merge reads every column
    // of every input part concurrently: one read buffer per stream per part, so
    // memory grows with (columns × parts). A VERTICAL merge reads only the
    // sorting-key columns first, records the row permutation, and then applies
    // it one column at a time — so memory grows with the widest single column
    // plus the permutation, and the width of the table stops mattering.
    //
    // On the `hits` and `sessions` tables the difference is a factor of five,
    // and it is the reason a wide-table merge on an under-provisioned server
    // dies with MEMORY_LIMIT_EXCEEDED while a narrow one never does.
    const wide = def.columns.length >= VERTICAL_MIN_COLUMNS || streams[table] >= 14
    const algorithm: MergeAlgorithm = wide && resultRows >= VERTICAL_MIN_ROWS ? 'vertical' : 'horizontal'
    const keyStreams = def.columns.filter((c) => c.keyPos >= 0).length
    // The permutation a vertical merge records is NOT held for the whole part:
    // the merge proceeds in blocks of `merge_max_block_size` rows, so the
    // permutation resident at any moment is one block's worth. An earlier version
    // charged it per row of the whole output, which made a vertical merge on a
    // large part cost MORE than a horizontal one — the exact opposite of why the
    // algorithm exists.
    const memoryBytes =
      algorithm === 'horizontal'
        ? streams[table] * inputs.length * COMPRESS_BLOCK_BYTES * 0.5
        : keyStreams * inputs.length * COMPRESS_BLOCK_BYTES * 0.5 +
          Math.min(resultRows, MERGE_MAX_BLOCK_ROWS) * 8

    /* --- how long it takes --------------------------------------------- */
    const coldShare = coldFraction(node, table)
    const readRate = HOT_READ_BYTES_PER_SEC * (1 - coldShare) + COLD_READ_BYTES_PER_SEC * coldShare
    const writeRate = HOT_WRITE_BYTES_PER_SEC * (1 - coldShare) + COLD_WRITE_BYTES_PER_SEC * coldShare
    // A merge reads its inputs uncompressed, sorts, and writes compressed. The
    // decompress/recompress is the CPU cost, and on a ZSTD(3) column it, not
    // the disk, is what sets the pace.
    const uncompressed = rows * rowUncompressed[table]
    const cpuSeconds = uncompressed / (700 * MIB)
    const ioSeconds = bytes / readRate + (resultRows * rowCompressed[table]) / writeRate
    const verticalPenalty = algorithm === 'vertical' ? 1.15 : 1
    const duration = Math.max(0.25, (Math.max(cpuSeconds, ioSeconds) * verticalPenalty) / 1)

    slot.active = true
    slot.table = table
    slot.reason = candidate.reason
    slot.algorithm = algorithm
    slot.partition = candidate.partition
    slot.sourceParts = inputs.map((p) => p.name)
    slot.sourceSlots = inputs.map((p) => p.slot)
    // The output part's name says exactly what happened: the union block range,
    // and one level above the deepest input.
    slot.resultPart = partName(
      partitionId(candidate.partition),
      minBlock,
      maxBlock,
      level + 1,
      inputs[0].mutation,
    )
    slot.progress = 0
    slot.rowsRead = 0
    slot.totalRows = rows
    slot.bytesRead = 0
    slot.totalBytes = bytes
    slot.memoryBytes = memoryBytes
    slot.elapsed = 0
    slot.verticalColumn = -1
    slot.duration = duration

    mergeResultRows.set(slot.slot + node * N_MERGE_SLOTS, resultRows)
    mergeMinBlock.set(slot.slot + node * N_MERGE_SLOTS, minBlock)
    mergeMaxBlock.set(slot.slot + node * N_MERGE_SLOTS, maxBlock)
    mergeLevel.set(slot.slot + node * N_MERGE_SLOTS, level + 1)

    // One pod per input part, each as big as that part. Several small pods going
    // in and one large pod coming back out IS the merge.
    flow(rid.yardToMerge(node), Math.min(4, inputs.length), 'merge', flowSize(rows / inputs.length), 0.2)
    bus.emit('merge:start', { node, table, reason: candidate.reason })

    // A merge decided on one replica is not repeated independently on the other:
    // it is written to `/log` as `MERGE_PARTS`, and the sibling performs THE SAME
    // merge locally. Both replicas therefore end up with byte-identical parts
    // without ever transferring the result — which is why replication traffic
    // does not grow with merge volume.
    if (announce && def.engine !== 'MergeTree') {
      appendKeeperLog(node, table, 'MERGE_PARTS', slot.resultPart)
    }

    return true
  }

  const mergeResultRows = new Map<number, number>()
  const mergeMinBlock = new Map<number, number>()
  const mergeMaxBlock = new Map<number, number>()
  const mergeLevel = new Map<number, number>()

  function tickMerges(node: number, dt: number): void {
    const n = nodes[node]
    const key = (m: MergeSim) => m.slot + node * N_MERGE_SLOTS

    for (const m of n.merges) {
      if (!m.active) continue
      const table = m.table
      const def = TABLES[table]
      const nt = n.tables[table]

      // A slow replica is slow at everything, merges included, and that is what
      // makes its queue grow rather than merely its lag.
      const rate = slowNode(node) ? 0.18 : 1
      m.elapsed += dt * rate
      const p = clamp01(m.elapsed / m.duration)
      m.progress = p
      m.rowsRead = Math.round(m.totalRows * p)
      m.bytesRead = Math.round(m.totalBytes * p)

      // The vertical algorithm's second phase is visible: the sorting-key
      // columns go first, then one payload column at a time.
      if (m.algorithm === 'vertical') {
        const keyCols = def.columns.filter((c) => c.keyPos >= 0).length
        m.verticalColumn = p < 0.35 ? -1 : Math.min(def.columns.length - 1, keyCols + Math.floor((p - 0.35) / 0.65 * (def.columns.length - keyCols)))
      }

      mergeRowsAcc[node] += m.totalRows * (dt * rate / m.duration)
      if (rng() < dt * 6) {
        flow(rid.yardToMerge(node), 1, 'merge', flowSize(m.totalRows / Math.max(1, m.sourceParts.length)))
      }

      if (p < 1) continue

      /* --- commit ------------------------------------------------------- */
      const resultRows = mergeResultRows.get(key(m)) ?? m.totalRows
      const minBlock = mergeMinBlock.get(key(m)) ?? 0
      const maxBlock = mergeMaxBlock.get(key(m)) ?? 0
      const level = mergeLevel.get(key(m)) ?? 1

      // The inputs become `outdated` — not deleted. A SELECT that started before
      // this moment is still reading them, and `old_parts_lifetime` is how long
      // they are kept for that reason.
      let inputTtlBase = state.t
      let droppedRows = 0
      for (const p2 of nt.parts) {
        // By NAME, not by slot. A part beyond the yard's window has slot -1, and
        // so does every other part beyond it — matching on the slot retired every
        // unslotted part in the table the moment one of them was merged.
        if (!m.sourceParts.includes(p2.name)) continue
        p2.reserved = false
        if (p2.ttlMin < inputTtlBase) inputTtlBase = p2.ttlMin
        droppedRows += p2.rows
        setPartState(node, table, p2, 'outdated')
      }
      droppedRows -= resultRows

      if (resultRows > 0) {
        const volume = m.reason === 'ttl_recompress' ? 1 : 0
        const out = createPart(node, table, m.partition, minBlock, maxBlock, level, resultRows, {
          volume,
          mutation: 0,
          // The merged part inherits the OLDEST surviving row's TTL, not a fresh
          // one. Resetting it here would make a TTL merge immortalise the data
          // it was supposed to be expiring.
          ttlBase: def.ttlSeconds ? Math.max(state.t - def.ttlSeconds, inputTtlBase - def.ttlSeconds) : undefined,
        })
        if (out) {
          // A merge output is already complete on disk when it is renamed in, so
          // it skips `temporary` and only pays the commit.
          setPartState(node, table, out, 'preactive')
          if (m.reason === 'ttl_delete' || m.reason === 'ttl_recompress') {
            ttlMergedAt.set(out.name, state.t)
          }
          if (volume === 1) flow(rid.hotToCold(node), 2, 'move', flowSize(resultRows / 2), 0.2)
        }
        flow(rid.mergeToYard(node), 2, 'merge', flowSize(resultRows / 2), 0.15)
      } else {
        // Everything in it had expired. With `ttl_only_drop_parts` this is the
        // whole of the TTL: no rewrite, no new part, just one `rmdir`.
        flow(rid.ttlDrop(node), 3, 'ttl', flowSize(m.totalRows / 3), 0.2)
      }

      if (droppedRows > 0 && (m.reason === 'ttl_delete' || m.reason === 'ttl_recompress')) {
        bus.emit('ttl:drop', { node, table, rows: droppedRows })
        flow(rid.yardToTtl(node), 2, 'ttl', flowSize(droppedRows / 2), 0.15)
      }

      nt.partsMerged++
      bus.emit('merge:end', { node, table, rows: resultRows })

      m.active = false
      m.progress = 0
      m.sourceParts = []
      m.sourceSlots = []
      m.verticalColumn = -1
      m.memoryBytes = 0
    }

    /* --- run the selector, on a timer, exactly as the pool does --------- */
    selectorTimer[node] += dt
    if (selectorTimer[node] < SELECTOR_PERIOD) return
    selectorTimer[node] = 0
    if (n.status === 'down') return
    // Order matters: the table under the most insert pressure gets first refusal
    // on a slot, which is `background_pool_size` being a shared resource.
    const order = [0, 1, 2].sort((a, b) => n.tables[b].activeParts - n.tables[a].activeParts)
    for (const t of order) {
      if (!startMerge(node, t)) continue
      break
    }
  }

  /* ======================================================================
   * MUTATIONS — `system.mutations`
   *
   * An `ALTER TABLE … UPDATE` is not an update. It is a MUTATION: a background
   * job that rewrites every part that could contain a matching row, producing a
   * new part with a `_<mutation_version>` suffix. It uses the SAME background
   * pool as merges, which is why a large mutation makes the part count climb —
   * the merges it displaces are not happening.
   * ====================================================================*/

  let mutationSeq = 42

  function startMutation(node: number, table: number, command: string): void {
    const n = nodes[node]
    if (n.mutations.some((m) => m.state === 'running')) return
    const nt = n.tables[table]
    n.mutations.push({
      id: `mutation_${mutationSeq++}.txt`,
      command,
      state: 'running',
      partsToDo: nt.activeParts,
      partsDone: 0,
      createdAt: state.t,
      failReason: '',
    })
    if (TABLES[table].engine !== 'MergeTree') appendKeeperLog(node, table, 'MUTATE_PART', `mutation ${command}`)
  }

  const mutationTimer = new Float64Array(N_NODES)

  function tickMutations(node: number, dt: number): void {
    const n = nodes[node]
    for (let i = n.mutations.length - 1; i >= 0; i--) {
      const mut = n.mutations[i]
      if (mut.state !== 'running') {
        if (state.t - mut.createdAt > 20) n.mutations.splice(i, 1)
        continue
      }
      if (!K.keeperConnected && TABLES[0].engine !== 'MergeTree') {
        // The classic stuck mutation: the entry is in Keeper, the replica cannot
        // read it, and `system.mutations.latest_fail_reason` is where you find out.
        mut.failReason = 'Cannot read mutation entry: Keeper session expired'
        continue
      }
      mut.failReason = ''

      mutationTimer[node] += dt
      // One part at a time, and each one competes with the merges for a slot.
      const perPart = 0.9
      if (mutationTimer[node] < perPart) continue
      mutationTimer[node] = 0

      const nt = n.tables[0]
      const target = nt.parts.find((p) => p.state === 'active' && p.mutation === 0 && !p.reserved)
      if (!target) {
        mut.state = 'done'
        continue
      }
      // The rewritten part keeps its block range and level and gains a mutation
      // version, which is why `20260701_1_9_2` and `20260701_1_9_2_43` are the
      // same rows at two different mutation versions.
      target.reserved = true
      const out = createPart(node, 0, target.partition, target.minBlock, target.maxBlock, target.level, target.rows, {
        mutation: mutationSeq,
      })
      target.reserved = false
      setPartState(node, 0, target, 'outdated')
      if (out) setPartState(node, 0, out, 'preactive')
      mut.partsDone++
      if (mut.partsDone >= mut.partsToDo) mut.state = 'done'
      flow(rid.yardToMerge(node), 1, 'merge', flowSize(target.rows))
    }
  }

  /* ======================================================================
   * REPLICATION
   *
   * `ReplicatedMergeTree` has no primary. Every replica watches
   * `/clickhouse/tables/{shard}/{table}/log` in Keeper, copies new entries into
   * its own `/replicas/{name}/queue`, and executes them in order. Everything
   * follows from that:
   *
   *   - A `GET_PART` entry makes the replica FETCH the part over HTTP from
   *     whichever replica has it. Keeper never carries data.
   *   - A `MERGE_PARTS` entry makes the replica perform the merge ITSELF, so the
   *     result is byte-identical on both without being transferred.
   *   - A replica that cannot keep up has a growing `queue_size`, and
   *     `absolute_delay` is how far behind the oldest unexecuted entry is.
   *   - No Keeper session means no block numbers, which means READ-ONLY.
   * ====================================================================*/

  /** `/log` per shard per table. Every replica of that shard reads this. */
  const keeperLog: { index: number; type: LogEntryType; part: string; source: number; at: number }[][][] = []
  for (let s = 0; s < N_SHARDS; s++) {
    const perTable: { index: number; type: LogEntryType; part: string; source: number; at: number }[][] = []
    for (let t = 0; t < N_TABLES; t++) perTable.push([])
    keeperLog.push(perTable)
  }

  function appendKeeperLog(node: number, table: number, type: LogEntryType, part: string): void {
    if (!K.keeperConnected) return
    const shard = shardOf(node)
    const log = keeperLog[shard][table]
    state.keeperLogIndex++
    log.push({ index: state.keeperLogIndex, type, part, source: node, at: state.t })
    // `/log` is trimmed once every replica has read past an entry. A replica
    // that never catches up is what makes Keeper's znode count explode.
    if (log.length > 512) log.shift()
    keeperRequestAcc++
    flow(rid.nodeToKeeper(node), 1, 'keeper', 0.9)
    for (const k of keepers) if (k.role !== 'down') k.activity = Math.min(1, k.activity + 0.3)
  }

  function enqueue(node: number, type: LogEntryType, table: number, partName_: string): boolean {
    const q = nodes[node].replication.queue
    for (const e of q) {
      if (e.partName !== '') continue
      e.type = type
      e.table = table
      e.partName = partName_
      e.tries = 0
      e.createdAt = state.t
      e.executing = false
      e.progress = 0
      e.lastException = ''
      return true
    }
    return false
  }

  function slowNode(node: number): boolean {
    // Replica 1 of shard 0 is the designated straggler, so the lesson always
    // appears in the same place and can be pointed at.
    return K.slowReplica && node === nodeIndex(0, 1)
  }

  function tickReplication(node: number, dt: number): void {
    const n = nodes[node]
    const rep = n.replication
    const shard = shardOf(node)

    rep.connected = K.keeperConnected && n.status !== 'down'
    // No Keeper, no block numbers, no INSERTs. Reads keep working from whatever
    // is already on local disk, which is why a Keeper outage looks like a
    // "writes are failing" incident and not an outage.
    rep.readOnly = !rep.connected && TABLES[0].engine !== 'MergeTree'
    if (rep.readOnly) {
      rep.absoluteDelay = state.t - (lastLogRead[node] || state.t)
      return
    }

    /* --- pull new entries out of /log into the local queue -------------- */
    let maxIndex = 0
    for (let t = 0; t < N_TABLES; t++) {
      const log = keeperLog[shard][t]
      for (const e of log) {
        if (e.index > maxIndex) maxIndex = e.index
        if (e.index <= rep.logPointer) continue
        // A replica does not queue its own entries — it already did the work.
        if (e.source === node) {
          rep.logPointer = e.index
          continue
        }
        if (!enqueue(node, e.type, t, e.part)) break // queue slots full; try next tick
        rep.logPointer = e.index
        lastLogRead[node] = state.t
        flow(rid.keeperToNode(node), 1, 'keeper', 0.9)
        keeperRequestAcc++
      }
    }
    rep.logMaxIndex = Math.max(maxIndex, rep.logPointer)

    /* --- execute the queue --------------------------------------------- */
    const rate = slowNode(node) ? 0.14 : 1
    let oldest = state.t
    let queued = 0
    let insertsQ = 0
    let mergesQ = 0

    for (const e of rep.queue) {
      if (e.partName === '') continue
      queued++
      if (e.createdAt < oldest) oldest = e.createdAt
      if (e.type === 'GET_PART') insertsQ++
      else if (e.type === 'MERGE_PARTS') mergesQ++
    }
    rep.queueSize = queued
    rep.insertsInQueue = insertsQ
    rep.mergesInQueue = mergesQ

    // `absolute_delay`: the age of the oldest entry this replica has not
    // executed. It is a TIME, not a byte count, and it is the number an alert
    // should fire on.
    rep.absoluteDelay = queued > 0 ? state.t - oldest : 0

    /* Several entries at once, in queue order.
     *
     * ClickHouse executes INDEPENDENT queue entries concurrently — bounded by
     * `max_replicated_merges_in_queue` and by
     * `max_replicated_fetches_network_bandwidth` — and only serialises where
     * there is a real dependency, such as a `GET_PART` for a merge result that
     * must not overtake the `MERGE_PARTS` producing it.
     *
     * An earlier version executed strictly one at a time, which made the queue
     * permanently saturated on a HEALTHY cluster: entries arrived faster than one
     * serial worker could ever drain them, so `queue_size` pinned at its maximum
     * and `absolute_delay` grew without bound whether or not anything was wrong.
     * A metric that is always red measures nothing. */
    let started = 0
    for (const head of rep.queue) {
      if (head.partName === '') continue
      if (started >= QUEUE_CONCURRENCY) break
      started++

      head.executing = true
      // A fetch is network-bound and pays the round trip; a merge is CPU-bound
      // and does not.
      const cost = head.type === 'GET_PART' ? 0.12 + (K.networkLatencyMs / 1000) * 2 : 0.7
      head.progress = clamp01(head.progress + (dt * rate) / cost)

      if (head.type === 'GET_PART' && head.progress > 0.05 && head.progress < 0.95 && rng() < dt * 4) {
        const from = siblingOf(node)
        flow(rid.fetchPart(from, node), 1, 'fetch', 1.3)
      }

      if (head.progress < 1) continue
      executeEntry(node, head)
    }
  }

  /** Apply one completed queue entry. */
  function executeEntry(node: number, head: QueueEntrySim): void {
    const rep = nodes[node].replication
    switch (head.type) {
      case 'GET_PART': {
        // The part is copied from a replica that has it — over HTTP, directly,
        // never through Keeper. This is why a large backfill saturates the
        // network between replicas and leaves Keeper idle.
        const from = siblingOf(node)
        const srcTable = nodes[from].tables[head.table].parts.some((p) => p.name === head.partName)
          ? head.table
          : findTableForPart(from, head.partName)
        if (srcTable >= 0) {
          const src = nodes[from].tables[srcTable].parts.find((p) => p.name === head.partName)
          if (src) {
            const copy = createPart(node, srcTable, src.partition, src.minBlock, src.maxBlock, src.level, src.rows, {
              fetched: true,
              mutation: src.mutation,
              volume: src.volume,
              ttlBase: TABLES[srcTable].ttlSeconds ? src.ttlMin - TABLES[srcTable].ttlSeconds! : undefined,
            })
            if (copy) {
              nodes[node].tables[srcTable].nextBlock = Math.max(
                nodes[node].tables[srcTable].nextBlock,
                src.maxBlock + 1,
              )
            }
          }
        }
        rep.partsFetched++
        nodes[from].replication.partsSent++
        break
      }
      case 'MERGE_PARTS':
        /* The replica performs the merge ITSELF — nothing is fetched, which is
         * the whole point of this entry type. Both replicas hold identical parts,
         * so running this replica's own selector on the same table produces the
         * same consolidation.
         *
         * SIMPLIFICATION, and it matters: a real entry names the exact input
         * parts, and the replica waits (raising `num_tries`) until it has every
         * one of them. Here the entry is satisfied whether or not a merge
         * actually started, because the model's two replicas cannot disagree
         * about which parts exist. Retrying forever instead — which an earlier
         * version did — produced a queue that never drained on a healthy
         * cluster and made `absolute_delay` meaningless. */
        startMerge(node, head.table, false)
        break
      default:
        break
    }

    head.partName = ''
    head.executing = false
    head.progress = 0
    head.tries = 0
    head.lastException = ''
  }

  const lastLogRead = new Float64Array(N_NODES)

  function findTableForPart(node: number, name: string): number {
    for (let t = 0; t < N_TABLES; t++) {
      if (nodes[node].tables[t].parts.some((p) => p.name === name)) return t
    }
    return -1
  }

  /* ======================================================================
   * KEEPER
   *
   * Three nodes, raft, one leader. Keeper holds no user data at all — only
   * metadata: block numbers, the replication log, part checksums, mutation
   * entries. Its cost is znodes and its risk is that everything replicated
   * stops when it is unreachable.
   * ====================================================================*/

  let keeperRequestAcc = 0

  function tickKeeper(dt: number): void {
    let znodes = 0
    for (let s = 0; s < N_SHARDS; s++) {
      for (let t = 0; t < N_TABLES; t++) {
        // One znode per log entry, plus one per part per replica for the
        // checksum, plus the block-number sequence. The part count dominates,
        // which is the real reason "too many parts" is also a Keeper problem.
        znodes += keeperLog[s][t].length
        for (let r = 0; r < N_REPLICAS; r++) {
          znodes += nodes[nodeIndex(s, r)].tables[t].parts.length * 2 + 8
        }
      }
    }

    for (const k of keepers) {
      if (!K.keeperConnected) {
        k.role = 'down'
        k.activity = damp(k.activity, 0, 3, dt)
        k.requestsPerSec = damp(k.requestsPerSec, 0, 3, dt)
        continue
      }
      if (k.role === 'down') k.role = k.slot === 1 ? 'leader' : 'follower'
      k.znodes = znodes
      k.sessions = N_NODES + 2
      k.commitIndex = state.keeperLogIndex
      k.activity = damp(k.activity, 0, 2.2, dt)
      // Only the leader serves writes; followers serve reads and vote. So the
      // leader's request rate is higher, and the raft traffic below is the
      // difference.
      const share = k.role === 'leader' ? 0.6 : 0.2
      k.requestsPerSec = damp(k.requestsPerSec, keeperRateSmoothed * share, 2, dt)
    }

    if (K.keeperConnected) {
      raftTimer += dt
      if (raftTimer > 0.5) {
        raftTimer = 0
        for (let i = 0; i < N_KEEPERS; i++) {
          if (i === 1) continue
          flow(`keeper.raft.${i}`, 1, 'keeper', 0.8)
        }
      }
    }
  }

  let raftTimer = 0
  let keeperRateSmoothed = 0

  /* ======================================================================
   * STORAGE VOLUMES
   * ====================================================================*/

  /** Share of a table's active bytes that live on the cold volume. */
  function coldFraction(node: number, table: number): number {
    const nt = nodes[node].tables[table]
    let cold = 0
    let all = 0
    for (const p of nt.parts) {
      if (p.state !== 'active') continue
      all += p.bytesOnDisk
      if (p.volume === 1) cold += p.bytesOnDisk
    }
    return all > 0 ? cold / all : 0
  }

  const ioLoad = new Float64Array(N_NODES).fill(1)

  function tickVolumes(node: number, dt: number): void {
    const n = nodes[node]
    for (const v of n.volumes) {
      let bytes = 0
      for (let t = 0; t < N_TABLES; t++) {
        for (const p of n.tables[t].parts) {
          if (p.volume !== v.id) continue
          if (p.state === 'active' || p.state === 'outdated') bytes += p.bytesOnDisk
        }
      }
      v.usedBytes = bytes
      v.load = damp(v.load, clamp01(mergeBytesRate[node] / v.throughputBytesPerSec), 2, dt)
    }
    // Writeback pressure, quadratic because a device does not degrade linearly:
    // it is fine until it is not.
    ioLoad[node] = 1 + 2.5 * Math.pow(clamp01(mergeBytesRate[node] / HOT_WRITE_BYTES_PER_SEC), 2)
  }

  /* ======================================================================
   * NODE TICK
   * ====================================================================*/

  const insertRowsAcc = new Float64Array(N_NODES)
  const selectRowsAcc = new Float64Array(N_NODES)
  const mergeRowsAcc = new Float64Array(N_NODES)
  const mergeBytesRate = new Float64Array(N_NODES)

  function tickNode(node: number, dt: number): void {
    const n = nodes[node]

    // `nodeDown` takes the last node offline: shard 1's second replica. Its
    // shard survives on the sibling, and every SELECT quietly starts reading
    // from that one replica instead — which is what makes a replica loss
    // invisible until the second one goes too.
    const shouldBeDown = K.nodeDown && node === N_NODES - 1
    if (shouldBeDown && n.status !== 'down') {
      n.status = 'down'
      toast(`${n.host} is unreachable — shard ${n.shard + 1} is down to one replica`, 'warn', 6000)
      /* `wait_for_async_insert = 0` is the one setting in this model that can
       * lose acknowledged data. The rows are in a buffer in the server's memory
       * and the client has already been told the INSERT succeeded; when the
       * server goes away, so do they. With it on, the client was still waiting,
       * so it learns about the failure and can retry. */
      if (K.asyncInsert && !K.waitForAsyncInsert && n.asyncInsertBytes > 0) {
        const lost = n.asyncInsertBytes
        asyncBuffer[node].rows.fill(0)
        asyncBuffer[node].timer.fill(0)
        n.asyncInsertBytes = 0
        if (state.t - asyncLossWarnT > 15) {
          asyncLossWarnT = state.t
          toast(
            `${n.host} lost ${fmtBytesShort(lost)} of async-insert buffer — wait_for_async_insert was off, so the clients were told those INSERTs succeeded`,
            'warn',
            8000,
          )
        }
      }
    } else if (!shouldBeDown && n.status === 'down') {
      n.status = 'starting'
      startingT[node] = 0
    }
    if (n.status === 'starting') {
      startingT[node] += dt
      if (startingT[node] > 2.2) n.status = 'up'
    }

    if (n.status === 'down') {
      // Nothing runs. The queue still grows, because Keeper keeps accepting
      // entries from the sibling and this replica is simply not reading them.
      for (const r of n.readers) r.state = 'idle'
      n.queries.length = 0
      n.cpu = damp(n.cpu, 0, 3, dt)
      n.replication.absoluteDelay += dt
      return
    }

    if (K.asyncInsert) tickAsyncInsert(node, dt)
    tickParts(node, dt)
    tickMerges(node, dt)
    tickMutations(node, dt)
    tickReplication(node, dt)
    tickReaders(node, dt)
    tickQueries(node, dt)
    tickCaches(node, dt)
    tickVolumes(node, dt)

    /* --- memory ------------------------------------------------------- */
    // `MemoryTracking`. Three consumers, and this ranking is the real one on a
    // busy server: the caches are a fixed reservation, the merges are the
    // variable cost that kills you, and the queries are usually smallest.
    let mergeMem = 0
    for (const m of n.merges) if (m.active) mergeMem += m.memoryBytes
    let queryMem = 0
    for (const q of n.queries) queryMem += q.memoryBytes
    const cacheMem = n.markCache.usedBytes + n.uncompressedCache.usedBytes
    n.memoryBytes = cacheMem + mergeMem + queryMem + n.asyncInsertBytes + 180 * MIB
    if (n.memoryBytes > n.memoryPeakBytes) n.memoryPeakBytes = n.memoryBytes

    /* --- cpu ---------------------------------------------------------- */
    let busyReaders = 0
    for (const r of n.readers) if (r.state !== 'idle') busyReaders++
    let runningMerges = 0
    for (const m of n.merges) if (m.active) runningMerges++
    n.cpu = damp(
      n.cpu,
      clamp01(busyReaders / N_READ_THREADS * 0.6 + runningMerges / Math.max(1, K.mergePoolSize) * 0.5),
      4,
      dt,
    )
  }

  const startingT = new Float64Array(N_NODES)

  /* ======================================================================
   * STATS
   * ====================================================================*/

  let rateT = 0
  let histT = 0
  let queryMsAcc = 0
  let queryMsCount = 0
  let insertCountAcc = 0
  let selectCountAcc = 0

  function tickStats(dt: number): void {
    rateT += dt
    if (rateT >= 0.25) {
      const iv = rateT
      rateT = 0

      let activeParts = 0
      let runningMerges = 0
      let totalRows = 0
      let onDisk = 0
      let uncompressed = 0
      let insertRows = 0
      let selectRows = 0
      let mergeRows = 0
      let maxDelay = 0
      let maxQueue = 0
      let markHits = 0
      let markSeen = 0

      for (let i = 0; i < N_NODES; i++) {
        const n = nodes[i]
        n.insertRowsPerSec = damp(n.insertRowsPerSec, insertRowsAcc[i] / iv, 3, iv)
        n.selectRowsPerSec = damp(n.selectRowsPerSec, selectRowsAcc[i] / iv, 3, iv)
        mergeBytesRate[i] = damp(
          mergeBytesRate[i],
          (mergeRowsAcc[i] / iv) * rowCompressed[0],
          3,
          iv,
        )
        insertRows += n.insertRowsPerSec
        selectRows += n.selectRowsPerSec
        mergeRows += mergeRowsAcc[i] / iv
        insertRowsAcc[i] = 0
        selectRowsAcc[i] = 0
        mergeRowsAcc[i] = 0

        for (const m of n.merges) if (m.active) runningMerges++
        // Only replica 0 of each shard is counted for row and byte totals, or
        // the cluster would appear to hold twice its data — which is a real
        // reporting mistake people make with `system.parts` on a Distributed
        // deployment.
        const counts = replicaOf(i) === 0
        for (let t = 0; t < N_TABLES; t++) {
          const nt = n.tables[t]
          activeParts += nt.activeParts
          if (counts) {
            totalRows += nt.rows
            onDisk += nt.bytesOnDisk
            uncompressed += nt.bytesUncompressed
          }
        }
        if (n.replication.absoluteDelay > maxDelay) maxDelay = n.replication.absoluteDelay
        if (n.replication.queueSize > maxQueue) maxQueue = n.replication.queueSize
        markHits += n.markCache.hits
        markSeen += n.markCache.hits + n.markCache.misses
      }

      stats.activeParts = activeParts
      stats.runningMerges = runningMerges
      stats.mergeRowsPerSec = damp(stats.mergeRowsPerSec, mergeRows, 3, iv)
      stats.totalRows = totalRows
      stats.totalBytesOnDisk = onDisk
      stats.totalBytesUncompressed = uncompressed
      stats.compressionRatio = onDisk > 0 ? uncompressed / onDisk : 1
      stats.insertRowsPerSec = insertRows
      stats.selectRowsPerSec = selectRows
      stats.maxReplicaDelay = maxDelay
      stats.maxQueueSize = maxQueue
      stats.markCacheHitPct = markSeen > 0 ? (markHits / markSeen) * 100 : 0
      stats.insertsPerSec = damp(stats.insertsPerSec, insertCountAcc / iv, 3, iv)
      stats.selectsPerSec = damp(stats.selectsPerSec, selectCountAcc / iv, 3, iv)
      stats.meanQueryMs = queryMsCount > 0 ? damp(stats.meanQueryMs, queryMsAcc / queryMsCount, 3, iv) : stats.meanQueryMs
      keeperRateSmoothed = damp(keeperRateSmoothed, keeperRequestAcc / iv, 3, iv)

      insertCountAcc = 0
      selectCountAcc = 0
      queryMsAcc = 0
      queryMsCount = 0
      keeperRequestAcc = 0

      /* --- the warnings that matter ------------------------------------- */
      if (maxQueue >= N_QUEUE_SLOTS && state.t - queueWarnT > 20) {
        queueWarnT = state.t
        toast(
          `replication_queue is full on a replica — absolute_delay ${maxDelay.toFixed(0)} s and climbing`,
          'warn',
          6000,
        )
      }
      let maxDelayed = 0
      for (const n of nodes) if (n.insertDelay > maxDelayed) maxDelayed = n.insertDelay
      if (maxDelayed > 0.5 && state.t - delayWarnT > 25) {
        delayWarnT = state.t
        toast('INSERTs are being delayed: the merge pool cannot keep up with the part count', 'warn', 6000)
      }
    }

    histT += dt
    if (histT >= 0.25) {
      histT = 0
      const h = stats.history
      pushHistory(h.parts, stats.activeParts)
      pushHistory(h.merges, stats.runningMerges)
      pushHistory(h.insertRows, stats.insertRowsPerSec)
      pushHistory(h.selectRows, stats.selectRowsPerSec)
      pushHistory(h.delay, stats.maxReplicaDelay)
      pushHistory(h.markCache, stats.markCacheHitPct)
    }
  }

  /* ======================================================================
   * SCENARIOS
   * ====================================================================*/

  const savedKnobs: Partial<Knobs> = {}
  let savedKeys: (keyof Knobs)[] = []
  let beatIdx = 0

  /**
   * Reading and writing a knob whose key is a *union* of keys collapses its
   * value type to `never` under `strict`, because TypeScript has to satisfy
   * every member of the union at once. These two casts are the one place that is
   * bridged, and they are why every other knob path in this file stays generic
   * over a single key.
   */
  type LooseKnobs = Record<keyof Knobs, unknown>
  const rememberKnob = (k: keyof Knobs): void => {
    ;(savedKnobs as LooseKnobs)[k] = (K as LooseKnobs)[k]
  }
  const restoreKnob = (k: keyof Knobs, v: unknown): void => {
    ;(setKnob as unknown as (key: keyof Knobs, value: unknown) => void)(k, v)
  }

  function endScenario(silent: boolean): void {
    if (!state.scenario) return
    for (const k of savedKeys) {
      const v = savedKnobs[k]
      if (v !== undefined) restoreKnob(k, v)
    }
    savedKeys = []
    state.scenario = null
    state.scenarioT = 0
    beatIdx = 0
    bus.emit('scenario', { id: null })
    bus.emit('narrate', null)
    if (!silent) toast('Scenario finished — settings restored', 'good')
  }

  function runScenario(id: string | null): void {
    if (!id) {
      endScenario(false)
      return
    }
    const def = SCENARIOS.find((s) => s.id === id)
    if (!def) {
      console.warn(`[sim] unknown scenario "${id}"`)
      return
    }
    if (state.scenario) endScenario(true)
    savedKeys = Object.keys(def.knobs) as (keyof Knobs)[]
    for (const k of savedKeys) rememberKnob(k)
    for (const k of savedKeys) {
      const v = def.knobs[k]
      if (v !== undefined) restoreKnob(k, v)
    }
    state.scenario = def.id
    state.scenarioT = 0
    beatIdx = 0
    bus.emit('scenario', { id: def.id })
    if (def.focus) bus.emit('focus', { id: def.focus })
    if (def.beats && def.beats.length && def.beats[0][0] <= 0) {
      bus.emit('narrate', { title: def.beats[0][1], body: def.beats[0][2], seconds: SCENARIO_NARRATION_SECONDS })
      beatIdx = 1
    }
  }

  function tickScenario(dt: number): void {
    if (!state.scenario) return
    const def = SCENARIOS.find((s) => s.id === state.scenario)
    if (!def) {
      state.scenario = null
      return
    }
    state.scenarioT += dt
    const beats = def.beats
    if (beats) {
      while (beatIdx < beats.length && state.scenarioT >= beats[beatIdx][0]) {
        const b = beats[beatIdx]
        bus.emit('narrate', { title: b[1], body: b[2], seconds: SCENARIO_NARRATION_SECONDS })
        beatIdx++
      }
    }
    if (def.duration > 0 && state.scenarioT >= def.duration) endScenario(false)
  }

  /* ======================================================================
   * KNOBS
   * ====================================================================*/

  function setKnob<Key extends keyof Knobs>(key: Key, value: Knobs[Key]): void {
    K[key] = value

    switch (key) {
      case 'insertsPerSec':
        K.insertsPerSec = Math.max(0, K.insertsPerSec)
        nextInsertArrival = 0
        break
      case 'selectsPerSec':
        K.selectsPerSec = Math.max(0, K.selectsPerSec)
        nextSelectArrival = 0
        break
      case 'markCacheMib':
        for (const n of nodes) {
          n.markCache.capacityBytes = K.markCacheMib * MIB
          n.markCache.usedBytes = Math.min(n.markCache.usedBytes, n.markCache.capacityBytes)
        }
        break
      case 'uncompressedCacheMib':
        for (const n of nodes) {
          n.uncompressedCache.capacityBytes = K.uncompressedCacheMib * MIB
          n.uncompressedCache.usedBytes = Math.min(
            n.uncompressedCache.usedBytes,
            n.uncompressedCache.capacityBytes,
          )
        }
        if (K.uncompressedCacheMib > 0) {
          toast(
            'uncompressed_cache_size > 0 — only worth it when the same granules are read repeatedly',
            'info',
            5200,
          )
        }
        break
      case 'keeperConnected':
        if (!K.keeperConnected) {
          toast('Keeper is unreachable — every ReplicatedMergeTree table is now read-only', 'warn', 6500)
        } else {
          toast('Keeper session re-established — replicas are catching up', 'good', 4500)
        }
        break
      case 'runningMutation':
        if (K.runningMutation) {
          for (let n = 0; n < N_NODES; n++) {
            startMutation(n, 0, 'ALTER TABLE hits UPDATE RegionID = 0 WHERE CounterID = …')
          }
          toast('ALTER … UPDATE started — it rewrites whole parts and it uses the merge pool', 'warn', 6000)
        }
        break
      case 'ttlEnabled':
        if (!K.ttlEnabled) toast('TTL disabled — expired rows will accumulate until you re-enable it', 'warn')
        break
      case 'asyncInsert':
        if (K.asyncInsert) {
          toast('async_insert on — small INSERTs are batched in the server before a part is written', 'good', 5200)
        }
        break
      case 'timeScale':
        K.timeScale = clamp(K.timeScale, 0.05, 20)
        break
      default:
        break
    }

    if (!applying) {
      applying = true
      bus.emit('knob', { key, value })
      applying = false
    }
  }

  /** `OPTIMIZE TABLE … [FINAL]` — a merge somebody asked for by hand. */
  function optimize(node: number, table: number, final: boolean): void {
    const n = nodes[node]
    const slot = freeMergeSlot(node)
    if (!slot) {
      toast('No free slot in the background pool — OPTIMIZE will wait', 'warn')
      return
    }
    // `FINAL` ignores the size limits and merges every part of a partition into
    // one. On a large table that is a full rewrite of the whole partition, which
    // is why it is a maintenance operation and not a tuning knob.
    const nt = n.tables[table]
    const partition = final ? largestPartition(nt, TABLES[table].partitions) : -1
    if (final && partition >= 0) {
      const ps = activeInPartition(nt, partition, selectorParts)
      if (ps.length < 2) {
        toast('Nothing to do: that partition is already a single part', 'info')
        return
      }
      candidate.parts.length = 0
      for (const p of ps) candidate.parts.push(p)
      candidate.partition = partition
      candidate.reason = 'final'
      candidate.score = 1e9
      startMerge(node, table, true, true)
      return
    }
    startMerge(node, table)
  }

  /**
   * The partition OPTIMIZE should take, which is the one with the most parts it
   * can actually have. A part another merge has already reserved is not
   * available — counting it would pick a partition and then merge a different
   * number of parts from it than the count promised.
   */
  function largestPartition(nt: NodeTableSim, partitions: number): number {
    let best = -1
    let bestN = 1
    for (let p = 0; p < partitions; p++) {
      let n = 0
      for (const q of nt.parts) if (q.state === 'active' && !q.reserved && q.partition === p) n++
      if (n > bestN) {
        bestN = n
        best = p
      }
    }
    return best
  }

  /* ======================================================================
   * STEP
   * ====================================================================*/

  function step(dt: number): void {
    state.t += dt
    flowTokens = Math.min(120, flowTokens + FLOW_BUDGET_PER_SEC * dt)

    tickScenario(dt)

    // The counter is incremented per INSERT statement inside
    // `tickDistributedInsert`. It used to be inferred here from whether the
    // routed-rows total had moved, which counted a whole tick's worth of
    // statements as one.
    tickDistributedInsert(dt)

    const before = state.nextQueryId
    tickClientSelect(dt)
    selectCountAcc += Math.max(0, state.nextQueryId - before) / Math.max(1, N_SHARDS)

    for (let i = 0; i < N_NODES; i++) tickNode(i, dt)

    /* `fan_out` is how many shard queries this server has OUTSTANDING right now,
     * so it is derived from the queries that actually exist rather than
     * remembered from the last time the server initiated one. Assigning it once
     * at fan-out and never clearing it left a server that had stopped being an
     * initiator — because the connection policy changed, say — permanently
     * claiming a fan-out it no longer had. */
    for (let i = 0; i < N_NODES; i++) nodes[i].distributed.fanOut = 0
    for (let i = 0; i < N_NODES; i++) {
      for (const q of nodes[i].queries) nodes[q.initiator].distributed.fanOut++
    }

    tickKeeper(dt)
    tickStats(dt)
  }

  function update(dt: number): void {
    if (!isFinite(dt) || dt <= 0) return
    if (K.paused) return
    // The frame timebase normally sends fixed wall-clock steps multiplied by the
    // speed knob. Re-clamping to 1/30 would make higher speeds a silent no-op,
    // so subdivide instead; MAX_STEPS still bounds direct API callers.
    const cap = STEP_MAX * MAX_STEPS
    const d = dt > cap ? cap : dt
    state.realT += d / Math.max(0.05, K.timeScale)
    const steps = d > STEP_MAX ? Math.ceil(d / STEP_MAX) : 1
    const sd = d / steps
    for (let i = 0; i < steps; i++) step(sd)
  }

  /* ======================================================================
   * RESET / WARM-UP
   * ====================================================================*/

  function hardReset(): void {
    Object.assign(K, DEFAULT_KNOBS)
    state.t = 0
    state.realT = 0
    state.nextQueryId = 1
    state.keeperLogIndex = 0
    state.scenario = null
    state.scenarioT = 0

    // The spool is cleared per server further down, where the rest of each
    // server's Distributed state is. Truncating `spool[s]` here — which is what
    // this loop used to do, from when the spool was indexed by shard alone —
    // deleted the per-shard arrays instead of emptying them.
    for (let s = 0; s < N_SHARDS; s++) {
      for (let t = 0; t < N_TABLES; t++) keeperLog[s][t].length = 0
    }

    for (let i = 0; i < N_NODES; i++) {
      const n = nodes[i]
      n.status = 'up'
      n.insertRowsPerSec = 0
      n.selectRowsPerSec = 0
      n.insertDelay = 0
      n.tooManyPartsErrors = 0
      n.memoryBytes = 0
      n.memoryPeakBytes = 0
      n.asyncInsertBytes = 0
      n.queriesServed = 0
      n.blocksWritten = 0
      n.cpu = 0
      n.queries.length = 0
      n.mutations.length = 0
      startingT[i] = 0
      lastLogRead[i] = 0
      ioLoad[i] = 1
      mergeBytesRate[i] = 0
      insertRowsAcc[i] = 0
      selectRowsAcc[i] = 0
      mergeRowsAcc[i] = 0
      selectorTimer[i] = 0
      mutationTimer[i] = 0

      for (const m of n.merges) {
        m.active = false
        m.progress = 0
        m.sourceParts = []
        m.sourceSlots = []
        m.memoryBytes = 0
        m.verticalColumn = -1
      }
      for (const r of n.readers) {
        r.state = 'idle'
        r.taskCount = 0
        r.marksTotal = 0
        r.stolenFrom = -1
        r.query = -1
        r.progress = 0
        r.marksDone = 0
      }
      for (const e of n.replication.queue) {
        e.partName = ''
        e.table = 0
        e.executing = false
        e.progress = 0
        e.tries = 0
        e.lastException = ''
      }
      const rep = n.replication
      rep.connected = true
      rep.readOnly = false
      rep.logPointer = 0
      rep.logMaxIndex = 0
      rep.absoluteDelay = 0
      rep.queueSize = 0
      rep.insertsInQueue = 0
      rep.mergesInQueue = 0
      rep.partsFetched = 0
      rep.partsSent = 0

      n.markCache = Object.assign(n.markCache, makeCache(K.markCacheMib))
      n.uncompressedCache = Object.assign(n.uncompressedCache, makeCache(K.uncompressedCacheMib))
      for (const v of n.volumes) {
        v.usedBytes = 0
        v.load = 0
      }
      asyncBuffer[i].rows.fill(0)
      asyncBuffer[i].timer.fill(0)

      /* --- the initial data ------------------------------------------- */
      for (let t = 0; t < N_TABLES; t++) {
        const nt = n.tables[t]
        // Drop every part and hand every slot back, so the free list matches.
        while (nt.parts.length > 0) removePart(i, t, nt.parts[nt.parts.length - 1])
        nt.nextBlock = 1
        nt.partsInserted = 0
        nt.partsMerged = 0
        nt.partsDropped = 0
        nt.heat = 0
        seedTable(i, t)
      }
    }

    for (let i = 0; i < N_KEEPERS; i++) {
      const k = keepers[i]
      k.role = i === 1 ? 'leader' : 'follower'
      k.term = 1
      k.commitIndex = 0
      k.sessions = N_NODES + 2
      k.znodes = 0
      k.requestsPerSec = 0
      k.activity = 0
    }

    // Every server's own Distributed table, and its own spool directory.
    for (let n = 0; n < N_NODES; n++) {
      const d = nodes[n].distributed
      d.pendingBlocks.fill(0)
      d.pendingBytes.fill(0)
      d.rowsToShard.fill(0)
      d.readShard.fill(-1)
      d.lastShard = 0
      d.fanOut = 0
      d.rowsMerged = 0
      d.bytesFromRemote = 0
      d.queriesInitiated = 0
      d.insertsInitiated = 0
      d.activity = 0
      for (let s = 0; s < N_SHARDS; s++) spool[n][s].length = 0
    }
    state.clients.sentToNode.fill(0)
    state.clients.lastInsertTarget = 0
    state.clients.lastSelectTarget = 0
    state.clients.reachable = N_NODES
    state.clients.activity = 0
    clientRoundRobin = 0

    stats.insertsPerSec = 0
    stats.selectsPerSec = 0
    stats.insertRowsPerSec = 0
    stats.selectRowsPerSec = 0
    stats.activeParts = 0
    stats.runningMerges = 0
    stats.mergeRowsPerSec = 0
    stats.totalRows = 0
    stats.totalBytesOnDisk = 0
    stats.totalBytesUncompressed = 0
    stats.compressionRatio = 1
    stats.markCacheHitPct = 0
    stats.meanQueryMs = 0
    stats.maxReplicaDelay = 0
    stats.maxQueueSize = 0
    stats.history.parts.length = 0
    stats.history.merges.length = 0
    stats.history.insertRows.length = 0
    stats.history.selectRows.length = 0
    stats.history.delay.length = 0
    stats.history.markCache.length = 0

    pendingInserts = 0
    pendingSelects = 0
    nextInsertArrival = 0
    nextSelectArrival = 0
    blockSeq = 1
    mutationSeq = 42
    keeperRequestAcc = 0
    keeperRateSmoothed = 0
    queryMsAcc = 0
    queryMsCount = 0
    insertCountAcc = 0
    selectCountAcc = 0
    rateT = 0
    histT = 0
    raftTimer = 0
    ttlMergedAt.clear()
    mergeResultRows.clear()
    mergeMinBlock.clear()
    mergeMaxBlock.clear()
    mergeLevel.clear()
    quorumFailures = 0
    quorumWarnT = -100
    connWarnT = -100
    asyncLossWarnT = -100
    tooManyPartsWarnT = -100
    readOnlyWarnT = -100
    delayWarnT = -100
    queueWarnT = -100
    savedKeys = []
    beatIdx = 0
  }

  /**
   * Seed one table on one node with the parts a server that has been up for a
   * while would have: a few large merged parts per partition, and a handful of
   * small recent ones. An empty yard would teach the wrong thing about what a
   * healthy `system.parts` looks like.
   */
  function seedTable(node: number, table: number): void {
    const def = TABLES[table]
    const nt = nodes[node].tables[table]
    const rowsPerPartition = def.initialRows / def.partitions
    let block = 1

    for (let p = 0; p < def.partitions; p++) {
      // One large part that many merges produced — level 4 or 5, exactly what a
      // mature partition looks like.
      const bigRows = Math.round(rowsPerPartition * 0.86)
      const bigBlocks = 64
      const big = createPart(node, table, p, block, block + bigBlocks - 1, 5, bigRows, {
        volume: p === 0 && def.ttlSeconds ? 0 : 0,
        ttlBase: def.ttlSeconds ? state.t - def.ttlSeconds * 0.5 : undefined,
      })
      if (big) setPartState(node, table, big, 'active')
      block += bigBlocks

      // Two mid-sized ones a recent merge produced.
      for (let m = 0; m < 2; m++) {
        const midRows = Math.round(rowsPerPartition * 0.05)
        const midBlocks = 6
        const mid = createPart(node, table, p, block, block + midBlocks - 1, 2, midRows, {
          ttlBase: def.ttlSeconds ? state.t - def.ttlSeconds * 0.3 : undefined,
        })
        if (mid) setPartState(node, table, mid, 'active')
        block += midBlocks
      }

      // And the small level-0 parts a recent INSERT left behind.
      const small = p === def.partitions - 1 ? 5 : 2
      for (let s = 0; s < small; s++) {
        const part = createPart(node, table, p, block, block, 0, Math.round(rowsPerPartition * 0.008), {
          ttlBase: def.ttlSeconds ? state.t - def.ttlSeconds * 0.1 : undefined,
        })
        if (part) setPartState(node, table, part, 'active')
        block++
      }
    }
    nt.nextBlock = block
  }

  function reset(): void {
    hardReset()
    // Warm up silently so the cluster is never inert on load: caches partly
    // warm, a merge or two under way, the replication log already moving.
    quiet = true
    for (let i = 0; i < 300; i++) step(1 / 30)
    quiet = false
    bus.emit('sim:reset', {})
  }

  /* ---- bus plumbing: tolerate a UI that drives us through events -------- */

  bus.on('knob', (p) => {
    if (applying) return
    applying = true
    setKnob(p.key, p.value as Knobs[keyof Knobs])
    applying = false
  })
  bus.on('scenario', (p) => {
    if (applying) return
    if (p.id === state.scenario) return
    applying = true
    runScenario(p.id)
    applying = false
  })

  reset()

  // `keeperPos` is imported for its side-effect-free placement contract; the
  // world uses it, and referencing it here keeps the import honest under
  // `noUnusedLocals` if that is ever turned on.
  void keeperPos

  return { state, update, setKnob, runScenario, reset, optimize }
}
