import * as THREE from 'three'
import { COLOR } from '../core/theme'
import {
  INDEX_GRANULARITY,
  N_KEEPERS,
  N_MERGE_SLOTS,
  N_NODES,
  N_PART_SLOTS,
  N_READ_THREADS,
  N_REPLICAS,
  N_SHARDS,
} from '../core/types'
import type { RouteDef, TableDef } from '../core/types'

/* ============================================================================
 * THE CLUSTER PLAN
 *
 * One coordinate system for everybody. Y is up, ground plane is y = 0.
 * North is -Z, east is +X. One world unit ≈ one metre; a person would be ~1.8.
 *
 *                                 ▲ -Z  (north)
 *                CLIENT TERMINAL   z ≈ -430    (outside the cluster)
 *                DISTRIBUTED       z ≈ -300    the initiator node
 *
 *   ┌───────── shard 0 ─────────┐             ┌───────── shard 1 ─────────┐
 *   ch-s1r1        ch-s1r2                    ch-s2r1        ch-s2r2
 *   x = +515       x = +225                   x = -225       x = -515
 *                              all four at z = +30
 *
 * Those x run east to WEST, because the establishing shot looks south and this
 * is the order the row is read on screen, left to right. See `SHARD_X`.
 *
 *                KEEPER QUORUM     z ≈ +330    three raft nodes
 *                                 ▼ +Z  (south)
 *
 * The four servers stand in ONE ROW, paired. They used to sit in a 2x2 square,
 * where the horizontal split was the shard and the vertical split the replica —
 * two axes carrying two different meanings, which is a thing a viewer has to be
 * told rather than see. A row carries one: distance. Two islands 40 units apart
 * are the replicas of one shard, and the 200-unit channel is the shard boundary,
 * the only line in this world that data does not cross by replication.
 *
 * Each data node is an island built entirely in LOCAL coordinates inside its own
 * group. Anything that needs a world position — a route, a camera focus, a
 * cross-district label — asks `nodeLocal()` for it. No district hard-codes a
 * coordinate another district also needs.
 *
 * INSIDE ONE NODE ISLAND (local coordinates, +x east, +z south):
 *
 *              INSERT DOCK  z = -78          the write path lands here
 *   PRIMARY INDEX  x = -104                  primary.cidx, held in RAM
 *   SKIP INDEX SHEDS x = -104 z = 44         skp_idx_*.idx2
 *          CACHE DECK  z = -52               mark cache + uncompressed cache
 *              PARTS YARD  x = -46..46  z = -30..30      system.parts
 *                                            READ POOL  x = 104 z = -30
 *              MERGE GANTRY  z = 52          system.merges
 *                                            TTL WORKS  x = 104 z = 52
 *   REPLICATION QUEUE  x = -104 z = 84       system.replication_queue
 *              STORAGE VOLUMES  y = -34      hot (SSD) above cold (HDD/S3)
 * ==========================================================================*/

export const CITY = {
  /** One node island's footprint. Nothing may be placed outside it. */
  node: { w: 250, d: 210, deckTop: 2.6, deckThickness: 2.2 },
  /**
   * The parts yard: one BAND per table, because `system.parts` is per table and
   * a merge can never cross a table any more than it can cross a partition.
   * Each band is `cols x rows` slots wide, which is the whole of N_PART_SLOTS.
   */
  yard: {
    cols: 32,
    rows: 3,
    pitchX: 3.0,
    pitchZ: 3.2,
    /** Distance between one table's band and the next. */
    bandPitch: 15,
    baseY: 2.6,
    /** Tallest a part tower ever gets, at the largest row count in the model. */
    maxRise: 15,
    /** The deck the bands stand on. */
    deckW: 106,
    deckD: 52,
  },
  /** The cache deck above the yard's north side. */
  cacheDeck: { w: 96, d: 20, y: 9 },
  /** Storage volumes, excavated under each island. */
  storage: { hotY: -20, coldY: -40, w: 120, d: 90 },
  /** The pit cut under each island so the volumes are visible from the surface. */
  pit: { w: 132, d: 100, wallDepth: 48 },
  /**
   * How far the ground plane and its grid extend.
   *
   * Deliberately well beyond `fog.far`: at 2200 the plate's own edge was visible
   * from the establishing shot as a hard line against the sky, which reads as a
   * missing polygon rather than as a horizon. The plate has to run out past the
   * distance at which the haze has already taken it.
   */
  ground: 4400,
  fog: { near: 320, far: 1500 },
} as const

/* --------------------------------------------------------------------------
 * Node placement.
 * ------------------------------------------------------------------------*/

/**
 * The row, as it is read on screen. Both spacings are centre-to-centre between islands
 * `CITY.node.w` = 250 wide, so what the eye reads is the GAP: 40 units inside a
 * shard, 200 between them. The ratio is the whole point of the arrangement and
 * the reason neither number is merely "wide enough" — a replica pair has to look
 * like one thing, and the channel between the shards like a boundary.
 */
const REPLICA_PITCH = 290
const SHARD_GAP = 200

/** Half the span of one shard's pair, edge to edge. */
const HALF_PAIR = (REPLICA_PITCH + CITY.node.w) / 2

/**
 * A shard's CENTRE — the empty channel between its two replicas, not either
 * island.
 *
 * Shard 0 is the EASTERN one, and inside a shard replica 0 is the eastern too,
 * which looks backwards written down and is right on screen. The establishing
 * shot stands north of the clients looking SOUTH, so +x is to the viewer's LEFT,
 * and this ordering is what makes the row read `ch-s1r1 ch-s1r2 | ch-s2r1
 * ch-s2r2` from left to right. With the indices running west-to-east the row
 * arrived reversed, and a viewer reading it in order was walking the cluster
 * backwards.
 */
export const SHARD_X: readonly number[] = [HALF_PAIR + SHARD_GAP / 2, -(HALF_PAIR + SHARD_GAP / 2)]
/** Replicas sit either side of their shard's centre; replica 0 is the eastern. */
export const REPLICA_DX: readonly number[] = [REPLICA_PITCH / 2, -REPLICA_PITCH / 2]

/** How far the outermost island's CENTRE is from the cluster axis. */
export const ROW_HALF_SPAN = HALF_PAIR + SHARD_GAP / 2 + REPLICA_PITCH / 2
/**
 * Every island is on one line. The row is centred between the clients at
 * z ≈ -430 and the Keeper quorum at z ≈ +330, so both stay in the establishing
 * shot at equal depth from it.
 */
export const NODE_Z = 30

export const shardOf = (node: number): number => Math.floor(node / N_REPLICAS)
export const replicaOf = (node: number): number => node % N_REPLICAS
export const nodeIndex = (shard: number, replica: number): number => shard * N_REPLICAS + replica

/** `hostname()` as the cluster config would name it. */
export function nodeHost(node: number): string {
  return `ch-s${shardOf(node) + 1}r${replicaOf(node) + 1}`
}

/** The sibling replica of the same shard. */
export function siblingOf(node: number): number {
  const s = shardOf(node)
  const r = replicaOf(node)
  return nodeIndex(s, (r + 1) % N_REPLICAS)
}

/** World origin of node `i`'s island. Its group sits here. */
export function nodeOrigin(node: number): [number, number, number] {
  return [SHARD_X[shardOf(node)] + REPLICA_DX[replicaOf(node)], 0, NODE_Z]
}

/** Turn a node-local coordinate into a world coordinate. */
export function nodeLocal(node: number, lx: number, ly: number, lz: number): [number, number, number] {
  const o = nodeOrigin(node)
  return [o[0] + lx, o[1] + ly, o[2] + lz]
}

/* --------------------------------------------------------------------------
 * Node-local anchors. Every district inside an island reads these.
 * ------------------------------------------------------------------------*/

export const LOCAL = {
  /* --- the Distributed table, on the island's north face ------------------
   * Every server has one, so it is drawn on every island, and it faces the
   * application tier because that is the direction clients arrive from. This
   * row is the server's front door: the client connects here, this is where the
   * sharding expression is evaluated, this is whose disk the spool sits on, and
   * this is where the partial results are merged back into an answer. */

  /** The `Distributed` table itself — the port the client connects to. */
  distTable: [0, 0, -97],
  /** The sharding-expression hash wheel. */
  shardWheel: [-40, 0, -97],
  /** `system.clusters` — this server's view of the cluster definition. */
  clustersBoard: [40, 0, -97],
  /** `data/<cluster>/shard<N>_replica<M>/` — the background insert spool. */
  insertSpool: [-92, 0, -95],
  /** Where partial results from the other shards are merged into an answer. */
  resultMerge: [92, 0, -95],

  /** Where an INSERT block lands: MergeTreeDataWriter's dock. */
  insertDock: [0, 0, -78],
  /** The sort table: the block is sorted by the ORDER BY key here. */
  sortTable: [-30, 0, -78],
  /** The compressor and the column writers. */
  columnWriters: [30, 0, -78],
  /** primary.cidx — the sparse primary index, one entry per granule. */
  primaryIndex: [-104, 0, -6],
  /** skp_idx_*.idx2 — the secondary (data skipping) indexes. */
  skipIndexes: [-104, 0, 44],
  /** The mark cache and the uncompressed cache, on one deck. */
  cacheDeck: [0, CITY.cacheDeck.y, -52],
  markCache: [-26, CITY.cacheDeck.y, -52],
  uncompressedCache: [26, CITY.cacheDeck.y, -52],
  /** system.parts — the yard itself. */
  partsYard: [0, 0, 0],
  /** MergeTreeReadPool: the dispatcher plus its reader bays. */
  readPool: [104, 0, -34],
  readPoolDispatcher: [104, 0, -56],
  /** system.merges — the gantry that straddles the yard's south side. */
  mergeGantry: [0, 0, 54],
  /** The TTL works: where expired rows are dropped or moved. */
  ttlWorks: [104, 0, 56],
  /** system.mutations — ALTER UPDATE / DELETE. */
  mutationShed: [58, 0, 84],
  /** system.replication_queue and the Keeper session. */
  replicationQueue: [-104, 0, 84],
  /** The two storage volumes, underground. */
  hotVolume: [0, CITY.storage.hotY, 6],
  coldVolume: [0, CITY.storage.coldY, 6],
} as const satisfies Record<string, readonly [number, number, number]>

export type LocalAnchorId = keyof typeof LOCAL

/** World position of a node-local anchor. */
export function anchorAt(node: number, id: LocalAnchorId): [number, number, number] {
  const a = LOCAL[id]
  return nodeLocal(node, a[0], a[1], a[2])
}

/* --------------------------------------------------------------------------
 * Cluster-scale anchors.
 * ------------------------------------------------------------------------*/

export const ANCHOR = {
  clusterCenter: [0, 8, 20],
  /**
   * The application tier, outside the cluster.
   *
   * There is deliberately no `distributed` anchor beside it. `Distributed` is a
   * table on every server, not a place between the clients and the shards, and
   * an anchor here would put it back. It lives in `LOCAL`, four times over.
   */
  clientTerminal: [0, 6, -430],
  /** The Keeper ensemble. */
  keeper: [0, 0, 330],
  keeperLeader: [0, 0, 306],
  /** `/clickhouse/tables/{shard}/{table}/log` — the shared replication log. */
  keeperLog: [0, 14, 356],
} as const satisfies Record<string, readonly [number, number, number]>

export type AnchorId = keyof typeof ANCHOR

export const v3 = (a: readonly [number, number, number]) => new THREE.Vector3(a[0], a[1], a[2])
export const at = (id: AnchorId) => v3(ANCHOR[id])

/** World position of Keeper node `i`. */
export function keeperPos(i: number): [number, number, number] {
  const step = 62
  const x = -((N_KEEPERS - 1) * step) / 2 + i * step
  // The leader stands one row forward of its followers, which is the only
  // visible difference between them — raft has no other.
  return [ANCHOR.keeper[0] + x, 0, ANCHOR.keeper[2] + (i === 1 ? -22 : 8)]
}

/**
 * Node-local position of part slot `i` of table `table` in the yard.
 *
 * Slots run west to east along a band, then wrap to the next row of the same
 * band — so a partition's parts, whose slots are handed out in order, read as a
 * run rather than as scattered towers.
 */
export function partSlotLocal(table: number, i: number): [number, number, number] {
  const { cols, rows, pitchX, pitchZ, bandPitch, baseY } = CITY.yard
  const col = i % cols
  const row = Math.floor(i / cols) % rows
  const halfX = ((cols - 1) * pitchX) / 2
  const halfZ = ((rows - 1) * pitchZ) / 2
  const bandZ = (table - (N_TABLES - 1) / 2) * bandPitch
  return [-halfX + col * pitchX, baseY, bandZ - halfZ + row * pitchZ]
}

/** Node-local z of table `table`'s band centre line. */
export function bandZLocal(table: number): number {
  return (table - (N_TABLES - 1) / 2) * CITY.yard.bandPitch
}

/** Node-local position of reader thread `i`'s bay. */
export function readerBayLocal(i: number): [number, number, number] {
  const step = 9
  const z = LOCAL.readPool[2] + 12 + i * step
  return [LOCAL.readPool[0], 0, z]
}

/** Node-local position of merge slot `i` on the gantry. */
export function mergeSlotLocal(i: number): [number, number, number] {
  const step = 26
  const x = -((N_MERGE_SLOTS - 1) * step) / 2 + i * step
  return [x, 15, LOCAL.mergeGantry[2]]
}

/** Node-local position of replication-queue slot `i`. */
export function queueSlotLocal(i: number): [number, number, number] {
  const step = 4.6
  return [LOCAL.replicationQueue[0] - 12 + (i % 6) * step, 3.2 + Math.floor(i / 6) * 4.4, LOCAL.replicationQueue[2]]
}

/* --------------------------------------------------------------------------
 * THE DATA. Three tables, chosen so every MergeTree lesson has a home:
 *
 *   hits      wide, high-cardinality, the classic web-analytics table. Teaches
 *             ORDER BY, compression ratio per column, and skip indexes.
 *   metrics   narrow and append-only with a short TTL. Teaches TTL DELETE, the
 *             TTL merge, and `ttl_only_drop_parts`.
 *   sessions  ReplacingMergeTree with frequent small INSERTs. Teaches
 *             "too many parts" and why a merge is not optional.
 * ------------------------------------------------------------------------*/

/**
 * Bytes per row and compression ratio are the two numbers that decide
 * everything about a `MergeTree` table's footprint, and the ratio is not a
 * property of the column type — it is a property of the column's *order*. A
 * `DateTime` in a table sorted by time is a monotone sequence and `Delta, ZSTD`
 * takes it to a few bits per row; the same column in a table sorted by
 * something else is nearly incompressible. That asymmetry is why the codec
 * column below is worth reading next to the ratio.
 */
export const TABLES: TableDef[] = [
  {
    id: 'hits',
    name: 'hits',
    engine: 'ReplicatedMergeTree',
    blurb:
      'Wide web-analytics fact table. Sorted by (CounterID, EventDate, UserID), so a query that names a counter reads a handful of granules and one that does not reads the lot.',
    partitionBy: 'toYYYYMM(EventDate)',
    orderBy: '(CounterID, EventDate, intHash32(UserID))',
    partitions: 3,
    initialRows: 480_000_000,
    insertWeight: 3,
    selectWeight: 3,
    color: COLOR.node,
    columns: [
      {
        id: 'CounterID',
        name: 'CounterID',
        type: 'UInt32',
        kind: 'int',
        bytesPerRow: 4,
        // First in the sorting key, so it arrives in long runs of one value.
        ratio: 120,
        codec: 'Delta, LZ4',
        keyPos: 0,
        color: COLOR.primaryIndex,
      },
      {
        id: 'EventDate',
        name: 'EventDate',
        type: 'Date',
        kind: 'date',
        bytesPerRow: 2,
        ratio: 90,
        codec: 'DoubleDelta, LZ4',
        keyPos: 1,
        color: COLOR.primaryIndex,
      },
      {
        id: 'UserID',
        name: 'UserID',
        type: 'UInt64',
        kind: 'int',
        bytesPerRow: 8,
        // Hashed into the key, so it is sorted but has enormous cardinality.
        ratio: 1.4,
        codec: 'LZ4',
        keyPos: 2,
        color: COLOR.primaryIndex,
      },
      {
        id: 'EventTime',
        name: 'EventTime',
        type: 'DateTime',
        kind: 'datetime',
        bytesPerRow: 4,
        ratio: 14,
        codec: 'Delta, ZSTD(1)',
        keyPos: -1,
        color: COLOR.reader,
      },
      {
        id: 'URL',
        name: 'URL',
        type: 'String',
        kind: 'string',
        bytesPerRow: 78,
        // The column that dominates the table. Long, varied, and only
        // moderately compressible — which is why it also dominates every merge.
        ratio: 4.2,
        codec: 'ZSTD(3)',
        keyPos: -1,
        color: COLOR.crit,
      },
      {
        id: 'Referer',
        name: 'Referer',
        type: 'String',
        kind: 'string',
        bytesPerRow: 44,
        ratio: 6.5,
        codec: 'ZSTD(3)',
        keyPos: -1,
        color: COLOR.warn,
      },
      {
        id: 'Browser',
        name: 'Browser',
        type: 'LowCardinality(String)',
        kind: 'lowcardinality',
        bytesPerRow: 1,
        // LowCardinality stores a dictionary once per part and an index per row.
        // The index is tiny and repetitive, hence the ratio.
        ratio: 40,
        codec: 'LZ4',
        keyPos: -1,
        color: COLOR.skipIndex,
      },
      {
        id: 'RegionID',
        name: 'RegionID',
        type: 'UInt16',
        kind: 'int',
        bytesPerRow: 2,
        ratio: 22,
        codec: 'T64, LZ4',
        keyPos: -1,
        color: COLOR.blockCache,
      },
      {
        id: 'Params',
        name: 'Params',
        type: 'Map(String, String)',
        kind: 'map',
        bytesPerRow: 36,
        // A Map is two Arrays behind the scenes: keys and values, each with its
        // own offsets stream. Three streams, three sets of marks.
        ratio: 5.5,
        codec: 'ZSTD(1)',
        keyPos: -1,
        color: COLOR.mutation,
      },
      {
        id: 'Title',
        name: 'Title',
        type: 'String',
        kind: 'string',
        bytesPerRow: 52,
        ratio: 7.8,
        codec: 'ZSTD(3)',
        keyPos: -1,
        color: COLOR.warn,
      },
      {
        id: 'IsMobile',
        name: 'IsMobile',
        type: 'UInt8',
        kind: 'int',
        bytesPerRow: 1,
        ratio: 55,
        codec: 'LZ4',
        keyPos: -1,
        color: COLOR.skipIndex,
      },
      {
        id: 'ResolutionWidth',
        name: 'ResolutionWidth',
        type: 'UInt16',
        kind: 'int',
        bytesPerRow: 2,
        ratio: 26,
        codec: 'T64, LZ4',
        keyPos: -1,
        color: COLOR.blockCache,
      },
    ],
    skipIndexes: [
      {
        id: 'hits_url_bf',
        name: 'idx_url',
        kind: 'tokenbf_v1',
        expr: 'URL',
        granularity: 4,
        // A token bloom filter on URLs is genuinely good: most granules do not
        // contain the token you are searching for.
        selectivity: 0.92,
      },
      {
        id: 'hits_region_set',
        name: 'idx_region',
        kind: 'set',
        expr: 'RegionID',
        granularity: 2,
        // A `set(100)` on a 200-value column degrades to "every granule might
        // match" as soon as the set overflows, and it does.
        selectivity: 0.35,
      },
      {
        id: 'hits_time_minmax',
        name: 'idx_event_time',
        kind: 'minmax',
        expr: 'EventTime',
        granularity: 1,
        // EventTime is correlated with EventDate, which IS in the sorting key —
        // so minmax on it is nearly free and nearly perfect. Correlation with
        // the sorting key is the whole reason a minmax index ever works.
        selectivity: 0.88,
      },
    ],
  },
  {
    id: 'metrics',
    name: 'metrics',
    engine: 'ReplicatedMergeTree',
    blurb:
      'Narrow append-only time series with a two-minute TTL. Every row that ages out has to be physically removed by a TTL merge — or, if the whole part expired, by simply dropping the directory.',
    partitionBy: 'toStartOfHour(ts)',
    orderBy: '(metric, ts)',
    partitions: 4,
    initialRows: 90_000_000,
    insertWeight: 4,
    selectWeight: 1.6,
    ttl: 'ts + INTERVAL 2 MINUTE DELETE',
    // Two simulated minutes. Real TTLs are days; this is the one place the model
    // compresses a duration rather than a rate, because a TTL you cannot watch
    // expire teaches nothing.
    ttlSeconds: 120,
    ttlOnlyDropParts: false,
    color: COLOR.blockCache,
    columns: [
      {
        id: 'metric',
        name: 'metric',
        type: 'LowCardinality(String)',
        kind: 'lowcardinality',
        bytesPerRow: 1,
        ratio: 60,
        codec: 'LZ4',
        keyPos: 0,
        color: COLOR.primaryIndex,
      },
      {
        id: 'ts',
        name: 'ts',
        type: 'DateTime',
        kind: 'datetime',
        bytesPerRow: 4,
        ratio: 80,
        codec: 'DoubleDelta, ZSTD(1)',
        keyPos: 1,
        color: COLOR.primaryIndex,
      },
      {
        id: 'value',
        name: 'value',
        type: 'Float64',
        kind: 'float',
        bytesPerRow: 8,
        // Gorilla is built for exactly this: slowly-varying floating point.
        ratio: 11,
        codec: 'Gorilla, ZSTD(1)',
        keyPos: -1,
        color: COLOR.reader,
      },
      {
        id: 'labels',
        name: 'labels',
        type: 'Array(LowCardinality(String))',
        kind: 'array',
        bytesPerRow: 12,
        ratio: 24,
        codec: 'LZ4',
        keyPos: -1,
        color: COLOR.skipIndex,
      },
    ],
    skipIndexes: [
      {
        id: 'metrics_value_minmax',
        name: 'idx_value',
        kind: 'minmax',
        expr: 'value',
        granularity: 1,
        selectivity: 0.42,
      },
    ],
  },
  {
    id: 'sessions',
    name: 'sessions',
    engine: 'ReplacingMergeTree',
    blurb:
      'Session state rewritten constantly by many small INSERTs. A ReplacingMergeTree only collapses duplicates during a merge, so until the merge happens you have every version — and a lot of parts.',
    partitionBy: 'toDate(started)',
    orderBy: '(session_id)',
    partitions: 2,
    initialRows: 30_000_000,
    // Deliberately the noisiest writer in the cluster: this is the table that
    // reaches `parts_to_delay_insert` first.
    insertWeight: 6,
    selectWeight: 1.2,
    color: COLOR.mutation,
    columns: [
      {
        id: 'session_id',
        name: 'session_id',
        type: 'UUID',
        kind: 'int',
        bytesPerRow: 16,
        // Sorted, but random: a UUID sorting key is the worst case for
        // compression and for the primary index's usefulness alike.
        ratio: 1.05,
        codec: 'LZ4',
        keyPos: 0,
        color: COLOR.primaryIndex,
      },
      {
        id: 'started',
        name: 'started',
        type: 'DateTime',
        kind: 'datetime',
        bytesPerRow: 4,
        ratio: 3.2,
        codec: 'Delta, LZ4',
        keyPos: -1,
        color: COLOR.reader,
      },
      {
        id: 'version',
        name: 'version',
        type: 'UInt32',
        kind: 'int',
        bytesPerRow: 4,
        ratio: 18,
        codec: 'T64, LZ4',
        keyPos: -1,
        color: COLOR.warn,
      },
      {
        id: 'state',
        name: 'state',
        type: 'JSON',
        kind: 'json',
        bytesPerRow: 96,
        // A `JSON` column is a whole subtree of typed subcolumns, each with its
        // own stream and its own marks. Wide, and it is what makes a vertical
        // merge on this table so much cheaper than a horizontal one.
        ratio: 7.5,
        codec: 'ZSTD(3)',
        keyPos: -1,
        color: COLOR.crit,
      },
    ],
    skipIndexes: [
      {
        id: 'sessions_state_bf',
        name: 'idx_state',
        kind: 'bloom_filter',
        expr: 'state.status',
        granularity: 2,
        selectivity: 0.6,
      },
    ],
  },
]

export const N_TABLES = TABLES.length

/** Uncompressed bytes one row of table `t` occupies. */
export function rowBytesUncompressed(t: number): number {
  let n = 0
  for (const c of TABLES[t].columns) n += c.bytesPerRow
  return n
}

/** Compressed bytes one row of table `t` occupies, per column ratio. */
export function rowBytesCompressed(t: number): number {
  let n = 0
  for (const c of TABLES[t].columns) n += c.bytesPerRow / c.ratio
  return n
}

/**
 * Streams one part of table `t` writes. Not one per column: an `Array` adds an
 * offsets stream, a `Map` adds two, a `LowCardinality` adds its dictionary, and
 * a `JSON` adds one per discovered subcolumn. Each stream is its own `.bin` and
 * its own `.mrk3`, which is why a wide table's part directory has hundreds of
 * files and why `min_bytes_for_wide_part` exists at all.
 */
export function streamCount(t: number): number {
  let n = 0
  for (const c of TABLES[t].columns) {
    switch (c.kind) {
      case 'array':
        n += 2
        break
      case 'map':
        n += 3
        break
      case 'lowcardinality':
        n += 2
        break
      case 'json':
        n += 8
        break
      default:
        n += 1
    }
  }
  return n
}

export { INDEX_GRANULARITY }

/* --------------------------------------------------------------------------
 * ROUTES — the road network.
 *
 * Every animated packet in the cluster travels along one of these. Districts
 * emit onto a route by id; engine/flows.ts owns the particles. Routes whose
 * `visible` flag is set also get a faint static road line.
 * ------------------------------------------------------------------------*/

const R: Record<string, RouteDef> = {}

function route(
  id: string,
  points: [number, number, number][],
  opts: Partial<Omit<RouteDef, 'id' | 'points'>> = {},
): RouteDef {
  R[id] = {
    id,
    points,
    color: opts.color ?? COLOR.node,
    speed: opts.speed ?? 110,
    size: opts.size ?? 1.1,
    visible: opts.visible ?? false,
    roadOpacity: opts.roadOpacity ?? 0.16,
    tension: opts.tension ?? 0.5,
  }
  return R[id]
}

export const rid = {
  /**
   * client → one server, and the answer back.
   *
   * Four of each, because the application chooses which server to connect to
   * and that server becomes the initiator of its statement. A single road to a
   * single front door would be a picture of a cluster that does not exist.
   */
  clientToNode: (node: number) => `client.to.${node}`,
  nodeToClient: (node: number) => `client.from.${node}`,
  /**
   * server → server, for every ordered pair. Three families along one duct,
   * because a forwarded INSERT block, a fanned-out SELECT and a partial result
   * coming home really do share one connection pool between two machines — but
   * each keeps its own colour, and colour here is never decorative.
   *
   * Only one of the three draws the road, so the pair reads as a single cable.
   */
  fanInsert: (from: number, to: number) => `fan.insert.${from}.${to}`,
  fanQuery: (from: number, to: number) => `fan.query.${from}.${to}`,
  fanResult: (from: number, to: number) => `fan.result.${from}.${to}`,
  /** inside one node: the write path */
  sortBlock: (node: number) => `node.sort.${node}`,
  writeColumns: (node: number) => `node.write.${node}`,
  commitPart: (node: number) => `node.commit.${node}`,
  /** inside one node: the read path */
  probeIndex: (node: number) => `node.probe.${node}`,
  probeSkip: (node: number) => `node.skip.${node}`,
  markToPool: (node: number) => `node.marks.${node}`,
  poolToReader: (node: number, thread: number) => `node.reader.${node}.${thread}`,
  readerToResult: (node: number) => `node.result.${node}`,
  /** inside one node: merges, TTL, volumes */
  yardToMerge: (node: number) => `node.merge.${node}`,
  mergeToYard: (node: number) => `node.merged.${node}`,
  yardToTtl: (node: number) => `node.ttl.${node}`,
  ttlDrop: (node: number) => `node.ttldrop.${node}`,
  toHotVolume: (node: number) => `node.hot.${node}`,
  hotToCold: (node: number) => `node.cold.${node}`,
  /** replication */
  nodeToKeeper: (node: number) => `keeper.up.${node}`,
  keeperToNode: (node: number) => `keeper.down.${node}`,
  fetchPart: (from: number, to: number) => `fetch.${from}.${to}`,
} as const

/* --- clients → every server ----------------------------------------------
 * The application tier has four roads out of it, one to each server's
 * `Distributed` table, because choosing which one to use is the application's
 * only decision and the thing that decides which server initiates.
 *
 * The clients still know nothing about shards — no road from here reaches a
 * parts yard. What changed is that the front door is not a place of its own:
 * there are four of them, one on each machine. */

for (let n = 0; n < N_NODES; n++) {
  const door = anchorAt(n, 'distTable')
  const res = anchorAt(n, 'resultMerge')
  // Statements out on the west lane of the corridor, answers home on the east,
  // so a busy server reads as two streams rather than one confused one.
  const lane = 30 + 14 * n

  route(
    rid.clientToNode(n),
    [
      [-26 + n * 17, 4, ANCHOR.clientTerminal[2] + 22],
      [-26 + n * 17, 4, -392],
      [door[0] - lane * 0.25, 5, -300],
      [door[0] - 10, 5, door[2] - 40],
      [door[0] - 4, 4, door[2] - 10],
    ],
    { color: COLOR.client, speed: 125, size: 1.35, visible: true, roadOpacity: 0.15 },
  )

  route(
    rid.nodeToClient(n),
    [
      [res[0], 6, res[2] - 8],
      [res[0] + 8, 7, res[2] - 44],
      [res[0] * 0.4, 7, -300],
      [40 - n * 17, 6, -392],
      [40 - n * 17, 6, ANCHOR.clientTerminal[2] + 22],
    ],
    { color: COLOR.ok, speed: 150, size: 1.0 },
  )
}

/* --- server → server: the whole cluster, all to all -----------------------
 * `system.clusters` is the same on every server, so every server can reach
 * every other one, and one duct per ordered pair is what that actually looks
 * like. A forwarded INSERT block, a fanned-out SELECT and a partial result
 * coming home all travel the same metal — it is one connection pool — and only
 * their colour distinguishes them.
 *
 * The road is drawn once per PAIR, on the from < to direction. Drawing both
 * would put two lines in the same place, which is not more information, and
 * the reverse duct still carries flows. */

for (let from = 0; from < N_NODES; from++) {
  for (let to = 0; to < N_NODES; to++) {
    if (from === to) continue
    const a = anchorAt(from, 'distTable')
    const b = anchorAt(to, 'distTable')
    /* Every front door is now on ONE LINE — same z, four x — so a duct drawn
     * straight between any two of them lies exactly on top of the ducts between
     * every other pair. The six of them are therefore drawn as an arc diagram:
     * each pair bows north in front of the row, by an amount fixed by how far
     * apart in the row its two ends are. The two shortest arcs are the two
     * replica pairs, the longest spans the whole cluster, and no two share a
     * plane. `rank` orders the six pairs by that span:
     *   gap 1 → 0,1,2   gap 2 → 3,4   gap 3 → 5 */
    const lo = Math.min(from, to)
    const gap = Math.abs(from - to)
    const rank = (gap - 1) * N_NODES - ((gap - 1) * gap) / 2 + lo
    // A duct must clear the tallest thing on an island; ranking it again in y
    // is what keeps the two equal-span arcs (0↔2 and 1↔3) off each other, since
    // their x ranges overlap through the middle of the row.
    const y = 9 + rank * 4
    const bow = (dy: number): [number, number, number][] => {
      const mid: [number, number, number] = [
        (a[0] + b[0]) / 2,
        y + dy + 4,
        (a[2] + b[2]) / 2 - (40 + 24 * rank),
      ]
      return [
        [a[0], y + dy, a[2] + 6],
        [(a[0] + mid[0]) / 2, y + dy + 2, (a[2] + mid[2]) / 2],
        mid,
        [(b[0] + mid[0]) / 2, y + dy + 2, (b[2] + mid[2]) / 2],
        [b[0], y + dy, b[2] + 6],
      ]
    }

    // The road belongs to the duct, not to any one of the three things on it,
    // so exactly one family draws it and only in the from < to direction —
    // otherwise six cables would be drawn as twelve lines in six places.
    const drawsRoad = from < to

    route(rid.fanInsert(from, to), bow(0), {
      color: COLOR.client,
      speed: 140,
      size: 1.25,
      visible: drawsRoad,
      roadOpacity: drawsRoad ? 0.13 : 0,
    })
    route(rid.fanQuery(from, to), bow(1.6), {
      color: COLOR.reader,
      speed: 155,
      size: 1.1,
    })
    route(rid.fanResult(from, to), bow(3.2), {
      color: COLOR.ok,
      speed: 165,
      size: 1.0,
    })
  }
}

/* --- inside one node: the write path -------------------------------------
 * INSERT → sort by the ORDER BY key → split by partition → compress each
 * column into its own .bin → write marks → rename tmp_insert_ into place.
 * These are separate roads because they are separate, sequential pieces of
 * work: a block is fully sorted before a single byte is compressed. */

for (let n = 0; n < N_NODES; n++) {
  const dock = anchorAt(n, 'insertDock')
  const sort = anchorAt(n, 'sortTable')
  const writers = anchorAt(n, 'columnWriters')
  const yard = anchorAt(n, 'partsYard')
  const hot = anchorAt(n, 'hotVolume')
  const cold = anchorAt(n, 'coldVolume')

  route(
    rid.sortBlock(n),
    [
      [dock[0], 6, dock[2]],
      [(dock[0] + sort[0]) / 2, 8, dock[2] - 2],
      [sort[0], 6, sort[2]],
    ],
    { color: COLOR.partTemporary, speed: 70, size: 1.2 },
  )

  route(
    rid.writeColumns(n),
    [
      [sort[0], 6, sort[2] + 2],
      [dock[0], 9, dock[2] + 6],
      [writers[0], 6, writers[2]],
    ],
    { color: COLOR.partPreactive, speed: 80, size: 1.15 },
  )

  route(
    rid.commitPart(n),
    [
      [writers[0], 6, writers[2] + 4],
      [writers[0] * 0.5, 10, -52],
      [yard[0] + 8, 8, yard[2] - 26],
      [yard[0], 5, yard[2] - 12],
    ],
    { color: COLOR.partActive, speed: 90, size: 1.3, visible: true, roadOpacity: 0.12 },
  )

  route(
    rid.toHotVolume(n),
    [
      [yard[0] - 10, 4, yard[2] + 8],
      [hot[0] - 20, -8, hot[2] - 4],
      [hot[0], hot[1] + 5, hot[2]],
    ],
    { color: COLOR.hot, speed: 70, size: 1.15 },
  )

  route(
    rid.hotToCold(n),
    [
      [hot[0] + 18, hot[1] + 4, hot[2]],
      [cold[0] + 26, (hot[1] + cold[1]) / 2, cold[2] + 6],
      [cold[0], cold[1] + 5, cold[2]],
    ],
    { color: COLOR.cold, speed: 52, size: 1.2 },
  )
}

/* --- inside one node: the read path --------------------------------------
 * This is the sequence the whole project exists to make visible:
 *
 *   1. partition pruning throws away whole partitions
 *   2. the primary index (primary.cidx) is binary-searched to mark ranges
 *   3. skip indexes throw away granules inside those ranges
 *   4. MergeTreeReadPool hands the surviving ranges to max_threads readers
 *   5. each reader resolves marks (mark cache), reads and decompresses blocks
 *      (uncompressed cache), and streams columns up
 *
 * Each step is its own road because each step is a different *decision*, and
 * because you can watch which one is doing the work. */

for (let n = 0; n < N_NODES; n++) {
  const disp = anchorAt(n, 'readPoolDispatcher')
  const pk = anchorAt(n, 'primaryIndex')
  const skip = anchorAt(n, 'skipIndexes')
  const mc = anchorAt(n, 'markCache')
  const yard = anchorAt(n, 'partsYard')
  const pool = anchorAt(n, 'readPool')

  route(
    rid.probeIndex(n),
    [
      [disp[0], 8, disp[2]],
      [30, 20, -68],
      [pk[0] + 14, 18, pk[2] - 12],
      [pk[0], 12, pk[2]],
    ],
    { color: COLOR.primaryIndex, speed: 170, size: 1.0, visible: true, roadOpacity: 0.1 },
  )

  route(
    rid.probeSkip(n),
    [
      [pk[0], 10, pk[2] + 6],
      [pk[0] - 4, 8, (pk[2] + skip[2]) / 2],
      [skip[0], 7, skip[2]],
    ],
    { color: COLOR.skipIndex, speed: 140, size: 0.95 },
  )

  route(
    rid.markToPool(n),
    [
      [skip[0] + 6, 8, skip[2] - 4],
      [-40, 14, -20],
      [mc[0], mc[1], mc[2]],
      [30, 12, -46],
      [disp[0] - 6, 8, disp[2] + 4],
    ],
    { color: COLOR.markCache, speed: 160, size: 0.9 },
  )

  for (let th = 0; th < N_READ_THREADS; th++) {
    const bay = nodeLocal(n, readerBayLocal(th)[0], 0, readerBayLocal(th)[2])
    route(
      rid.poolToReader(n, th),
      [
        [disp[0], 6, disp[2] + 4],
        [bay[0] + 6, 6, (disp[2] + bay[2]) / 2],
        [bay[0], 4, bay[2]],
      ],
      { color: COLOR.reader, speed: 120, size: 0.85 },
    )
  }

  route(
    rid.readerToResult(n),
    [
      [yard[0] + 40, 5, yard[2] + 4],
      [pool[0] - 24, 7, pool[2] + 10],
      [pool[0], 6, pool[2]],
    ],
    { color: COLOR.blockCache, speed: 130, size: 1.0 },
  )
}

/* --- inside one node: merges and TTL -------------------------------------
 * A merge is not a background nicety, it is the mechanism that makes a
 * MergeTree readable: without it, the number of parts grows without bound and
 * every SELECT has to open all of them. So the road from the yard to the gantry
 * is drawn, and drawn wide. */

for (let n = 0; n < N_NODES; n++) {
  const yard = anchorAt(n, 'partsYard')
  const gantry = anchorAt(n, 'mergeGantry')
  const ttl = anchorAt(n, 'ttlWorks')

  route(
    rid.yardToMerge(n),
    [
      [yard[0] - 24, 5, yard[2] + 22],
      [gantry[0] - 14, 12, gantry[2] - 12],
      [gantry[0], 14, gantry[2]],
    ],
    { color: COLOR.merge, speed: 80, size: 1.3, visible: true, roadOpacity: 0.16 },
  )

  route(
    rid.mergeToYard(n),
    [
      [gantry[0] + 12, 14, gantry[2]],
      [yard[0] + 24, 11, yard[2] + 20],
      [yard[0] + 30, 5, yard[2] + 6],
    ],
    { color: COLOR.partActive, speed: 90, size: 1.4 },
  )

  route(
    rid.yardToTtl(n),
    [
      [yard[0] + 34, 5, yard[2] + 20],
      [(yard[0] + ttl[0]) / 2 + 14, 9, ttl[2] - 6],
      [ttl[0], 7, ttl[2]],
    ],
    { color: COLOR.ttl, speed: 85, size: 1.2, visible: true, roadOpacity: 0.14 },
  )

  route(
    rid.ttlDrop(n),
    [
      [ttl[0], 6, ttl[2] + 8],
      [ttl[0] + 12, 3, ttl[2] + 26],
      [ttl[0] + 18, 0.6, ttl[2] + 38],
    ],
    { color: COLOR.partExpired, speed: 70, size: 1.1 },
  )
}

/* --- replication ---------------------------------------------------------
 * Two kinds of traffic, and conflating them is the single most common
 * misunderstanding about ClickHouse replication:
 *
 *   Keeper carries METADATA. A log entry saying "part 20260727_9_9_0 exists" is
 *   a few hundred bytes and it goes through the ensemble.
 *
 *   The PART ITSELF goes replica-to-replica over HTTP, and never through
 *   Keeper. That is why a Keeper node needs no disk throughput and why a
 *   replica fetch saturates a network card. */

for (let n = 0; n < N_NODES; n++) {
  const q = anchorAt(n, 'replicationQueue')
  // One lane per SERVER, not per shard, and it follows the server's own place
  // in the row so no two sessions cross. Keeper is an ensemble every server
  // talks to individually; two servers sharing a lane drew one wire where the
  // model has two sessions.
  const lane = nodeOrigin(n)[0] / ROW_HALF_SPAN

  route(
    rid.nodeToKeeper(n),
    [
      [q[0], 8, q[2] + 8],
      [q[0] + 30 * lane * -1, 6, q[2] + 60],
      [ANCHOR.keeper[0] + 90 * lane, 5, 272],
      [ANCHOR.keeper[0] + 30 * lane, 6, ANCHOR.keeper[2] - 20],
    ],
    { color: COLOR.keeper, speed: 180, size: 0.9, visible: true, roadOpacity: 0.13 },
  )

  route(
    rid.keeperToNode(n),
    [
      [ANCHOR.keeper[0] + 40 * lane, 7, ANCHOR.keeper[2] - 24],
      [ANCHOR.keeper[0] + 100 * lane, 6, 268],
      [q[0] - 26 * lane * -1, 6, q[2] + 56],
      [q[0] + 4, 8, q[2] + 6],
    ],
    { color: COLOR.replication, speed: 180, size: 0.95 },
  )
}

/* The part-transfer wires: one per ordered pair of replicas inside a shard. */
for (let s = 0; s < N_SHARDS; s++) {
  for (let a = 0; a < N_REPLICAS; a++) {
    for (let b = 0; b < N_REPLICAS; b++) {
      if (a === b) continue
      const from = nodeIndex(s, a)
      const to = nodeIndex(s, b)
      const fy = anchorAt(from, 'partsYard')
      const ty = anchorAt(to, 'insertDock')
      /* The two replicas are now side by side, so a straight wire between them
       * would run through both islands. It goes around instead: south out of the
       * yard, west or east along a lane behind the pair, then up the DESTINATION's
       * outer flank to its dock. Which flank is decided by the direction of
       * travel, so the two wires of a pair are mirror images and neither hides
       * the other — the old pair shared one lane and read as a single cable. */
      const flank = ty[0] > fy[0] ? 1 : -1
      const laneZ = NODE_Z + CITY.node.d / 2 + 34
      const flankX = ty[0] + flank * (CITY.node.w / 2 + 22)
      route(
        rid.fetchPart(from, to),
        [
          [fy[0], 6, fy[2] + 34],
          [fy[0] + (flankX - fy[0]) * 0.2, 7, laneZ],
          [flankX, 7, laneZ],
          [flankX, 7, ty[2] - 22],
          [ty[0] + flank * 10, 6, ty[2] - 8],
        ],
        { color: COLOR.fetch, speed: 100, size: 1.35, visible: true, roadOpacity: 0.15 },
      )
    }
  }
}

/* Raft: the leader replicates its log to the followers and gets a quorum back.
 * There is no data on these wires at all, only agreement. */
for (let i = 0; i < N_KEEPERS; i++) {
  if (i === 1) continue // node 1 is the leader in the resting configuration
  const l = keeperPos(1)
  const f = keeperPos(i)
  route(
    `keeper.raft.${i}`,
    [
      [l[0], 9, l[2] + 4],
      [(l[0] + f[0]) / 2, 11, (l[2] + f[2]) / 2],
      [f[0], 9, f[2] - 4],
    ],
    { color: COLOR.keeper, speed: 200, size: 0.8, visible: true, roadOpacity: 0.14 },
  )
}

/* --- exports ------------------------------------------------------------- */

export const ROUTES: Readonly<Record<string, RouteDef>> = R
export const ROUTE_IDS = Object.keys(R)

const curveCache = new Map<string, THREE.CatmullRomCurve3>()

/**
 * Memoised curve for a route. Districts can use this to move *meshes* along a
 * road (a part travelling to the merge gantry) — not just particles.
 */
export function routeCurve(id: string): THREE.CatmullRomCurve3 | null {
  const cached = curveCache.get(id)
  if (cached) return cached
  const def = ROUTES[id]
  if (!def) {
    console.warn(`[layout] unknown route "${id}"`)
    return null
  }
  const curve = new THREE.CatmullRomCurve3(
    def.points.map((p) => new THREE.Vector3(p[0], p[1], p[2])),
    false,
    'catmullrom',
    def.tension ?? 0.5,
  )
  curveCache.set(id, curve)
  return curve
}

const _tmp = new THREE.Vector3()

export function routePoint(id: string, t: number, out = new THREE.Vector3()): THREE.Vector3 {
  const c = routeCurve(id)
  if (!c) return out.set(0, 0, 0)
  return c.getPointAt(Math.max(0, Math.min(1, t)), out)
}

export function routeTangent(id: string, t: number, out = _tmp): THREE.Vector3 {
  const c = routeCurve(id)
  if (!c) return out.set(0, 0, 1)
  return c.getTangentAt(Math.max(0, Math.min(1, t)), out)
}

export function routeLength(id: string): number {
  const c = routeCurve(id)
  return c ? c.getLength() : 1
}

export interface Bounds {
  x: [number, number]
  z: [number, number]
}

/* The node row is DERIVED. Transcribing it was survivable while the islands sat
 * in a square whose corners never moved; the moment the row's spacing became two
 * named constants, a hand-written box here is a second, silently stale answer to
 * a question `nodeOrigin` already answers. `margin` covers the fetch wires that
 * loop around the outer flank of the end islands. */
const NODES_BOUNDS: Bounds = (() => {
  const margin = 60
  const halfD = CITY.node.d / 2 + margin
  const x = ROW_HALF_SPAN + CITY.node.w / 2 + margin
  return { x: [-x, x], z: [NODE_Z - halfD, NODE_Z + halfD] }
})()

/** Every district's bounding footprint. */
export const DISTRICT_BOUNDS: Record<string, Bounds> = {
  clients: { x: [-90, 90], z: [-470, -390] },
  distributed: { x: [-120, 120], z: [-360, -250] },
  nodes: NODES_BOUNDS,
  keeper: { x: [-140, 140], z: [280, 380] },
  world: { x: [NODES_BOUNDS.x[0] - 120, NODES_BOUNDS.x[1] + 120], z: [-560, 480] },
}
