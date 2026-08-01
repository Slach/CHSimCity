import * as THREE from 'three'
import { COLOR } from '../core/theme'
import {
  INDEX_GRANULARITY,
  N_KEEPERS,
  N_LEVEL_LANES,
  N_MERGE_SLOTS,
  N_NODES,
  N_READ_THREADS,
  N_REPLICAS,
  N_SHARDS,
} from '../core/types'
import type { RouteDef, RouteEnd, RouteTraffic, TableDef } from '../core/types'

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
   * The parts yard, which is `system.parts` drawn as a place. Three axes, and
   * every one of them is a column of that table:
   *
   *   BAND (z, coarse)   the TABLE. A merge can never cross a table.
   *   GROUP (x)          the PARTITION. A merge can never cross one of those
   *                      either, which is the whole of what PARTITION BY buys
   *                      you and is invisible unless the partitions stand apart.
   *   LANE (z, fine)     the merge LEVEL, 0 at the front. A merge takes several
   *                      parts out of one lane and puts ONE part into the lane
   *                      behind it, so background merging is a visible march
   *                      away from the viewer: many thin towers at the front,
   *                      few wide ones at the back.
   *
   * A cell — one (table, partition, level) — holds `cols` parts at full pitch
   * and then SQUEEZES rather than overflowing. That squeeze is deliberate: a
   * level-0 cell packed with sixty slivers is what "too many parts" looks like.
   */
  yard: {
    /** Parts per cell at full pitch. Beyond this the cell squeezes. */
    cols: 8,
    pitchX: 2.6,
    /** Distance between merge-level lanes within a band. */
    pitchZ: 3.0,
    /** Gap between one partition's group of lanes and the next. */
    partitionGap: 6.5,
    /** Distance between one table's band and the next. */
    bandPitch: 19,
    baseY: 2.6,
    /** Tallest a part tower ever gets, at the largest row count in the model. */
    maxRise: 15,
    /** The deck the bands stand on. */
    deckW: 120,
    deckD: 58,
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
  /** The background INSERT queue on this disk — what `system.distribution_queue` reports. */
  insertSpool: [-92, 0, -95],
  /** Where partial results from the other shards are merged into an answer. */
  resultMerge: [92, 0, -95],

  /** Where an INSERT block lands: MergeTreeDataWriter's dock. */
  insertDock: [0, 0, -78],
  /** The sort table: the block is sorted by the ORDER BY key here. */
  sortTable: [-30, 0, -78],
  /** The compressor and the column writers. */
  columnWriters: [30, 0, -78],
  /**
   * `primary.cidx` — the west end of the yard, ONE RACK PER TABLE BAND. The
   * z here is only the strip's reference line; the band's own z comes from
   * `indexGateAt`, because the index is a property of the DATA and not a
   * building the data visits. See that function for why it moved.
   */
  primaryIndex: [-104, 0, 0],
  /** skp_idx_*.idx2 — between its table's primary rack and its table's band. */
  skipIndexes: [-82, 0, 0],
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

/* --------------------------------------------------------------------------
 * The yard's addressing: (table, partition, level, position in that cell).
 *
 * A part's place in the yard is derived from what the part IS, not from the
 * order it happened to be created in. That is the point: two parts stand next
 * to each other because they are in the same partition at the same merge level
 * and could therefore be merged together, and a part stands one lane back
 * because it has been merged one more time.
 * ------------------------------------------------------------------------*/

/** Width of one (partition, level) cell at full pitch. */
export function yardCellWidth(): number {
  return CITY.yard.cols * CITY.yard.pitchX
}

/** Half-width of one table's whole row of partition groups. */
export function yardTableHalfWidth(table: number): number {
  const n = Math.max(1, TABLES[table].partitions)
  return (n * yardCellWidth() + (n - 1) * CITY.yard.partitionGap) / 2
}

/** The widest table's half-width — what the deck and the nameplates clear. */
export function yardHalfWidth(): number {
  let w = 0
  for (let t = 0; t < N_TABLES; t++) w = Math.max(w, yardTableHalfWidth(t))
  return w
}

/** Node-local x of the centre line of one partition's group of lanes. */
export function partitionGroupX(table: number, partition: number): number {
  const n = Math.max(1, TABLES[table].partitions)
  const step = yardCellWidth() + CITY.yard.partitionGap
  return (partition - (n - 1) / 2) * step
}

/**
 * The lane a part of this level stands in. The last lane is "this deep or
 * deeper", so the yard's depth does not grow with the cluster's age — a
 * long-running table reaches level 9 and the yard still has five lanes.
 */
export function partLevelLane(level: number): number {
  return level < 0 ? 0 : level < N_LEVEL_LANES ? level : N_LEVEL_LANES - 1
}

/** Node-local z of merge-level lane `lane` in table `table`'s band. */
export function partLaneZ(table: number, lane: number): number {
  const { pitchZ, bandPitch } = CITY.yard
  const bandZ = (table - (N_TABLES - 1) / 2) * bandPitch
  return bandZ - ((N_LEVEL_LANES - 1) * pitchZ) / 2 + lane * pitchZ
}

/**
 * The spacing a cell holding `count` parts uses. Full pitch up to `cols`, and
 * then the cell squeezes so everything still fits inside its own partition
 * group — a part must never wander into the neighbouring partition, because
 * standing in a partition is a factual claim about what it can be merged with.
 */
export function partCellPitch(count: number): number {
  const { cols, pitchX } = CITY.yard
  return count <= cols ? pitchX : yardCellWidth() / count
}

/**
 * Node-local position of the `index`-th of `count` parts in one cell.
 *
 * `index` is the part's rank within its cell in block order, so a partition's
 * parts read left to right in the order their rows arrived.
 */
export function partPlaceLocal(
  table: number,
  partition: number,
  lane: number,
  index: number,
  count: number,
): [number, number, number] {
  const pitch = partCellPitch(count)
  const x = partitionGroupX(table, partition) + (index - (count - 1) / 2) * pitch
  return [x, CITY.yard.baseY, partLaneZ(table, lane)]
}

/**
 * The index racks, ONE PER TABLE BAND, at the west end of that band.
 *
 * They used to be two lone towers in the middle of the west strip, one per node,
 * with the whole read path detouring to them — which drew the primary index as
 * a building the query walks to, shared by every table. It is neither. In
 * ClickHouse `primary.cidx` is a file inside EVERY PART, loaded lazily into that
 * part's own memory (`IMergeTreeDataPart::index`), and the search runs once per
 * part, in parallel, over the parts of ONE table. So the honest place for it is
 * beside its own table's parts: three racks per island, each answering only for
 * the band it stands at, and the doc says the file is per part.
 */
export function indexGateAt(node: number, table: number): [number, number, number] {
  return nodeLocal(node, LOCAL.primaryIndex[0], 0, bandZLocal(table))
}

/** The skip-index plates for one table, between its rack and its band. */
export function skipGateAt(node: number, table: number): [number, number, number] {
  return nodeLocal(node, LOCAL.skipIndexes[0], 0, bandZLocal(table))
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

/**
 * The `system.distribution_queue` silos: ONE PER DESTINATION SHARD, because the
 * real directory tree is one per destination — `data/<db>/<table>/shard1_…`,
 * `shard2_…` — and a block waiting in one of them is waiting for that shard and
 * no other. Which is why the ducts fork before they arrive rather than after.
 */
export const SPOOL_SILO = {
  /** Centre-to-centre. 15 against a radius of 5 leaves a duct's width between them. */
  spacing: 15,
  radius: 5,
  height: 15,
  /** Plinth top. */
  baseY: 2.4,
} as const

/** World position of the floor centre of node `n`'s queue silo for shard `s`. */
export function spoolSiloAt(node: number, shard: number): [number, number, number] {
  const a = anchorAt(node, 'insertSpool')
  return [a[0] + (shard - (N_SHARDS - 1) / 2) * SPOOL_SILO.spacing, a[1], a[2]]
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

/**
 * `traffic` is a required argument and not part of `opts`, so a route cannot be
 * added without saying what runs on it and between where. Click a packet and
 * this is what the inspector reads back; a duct with nothing to say here would
 * be a lit box moving between two unnamed places.
 */
function route(
  id: string,
  points: [number, number, number][],
  traffic: RouteTraffic,
  opts: Partial<Omit<RouteDef, 'id' | 'points' | 'traffic'>> = {},
): RouteDef {
  R[id] = {
    id,
    points,
    traffic,
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
  /**
   * The background-insert path. With `distributed_foreground_insert = 0` a
   * remote shard's slice is not sent: it is PARKED in the initiator's own
   * `system.distribution_queue` directory, and a background thread later
   * flushes it over the wire into the underlying MergeTree table of one live
   * replica of the target shard (`spoolFlush`). The receiving server's
   * `Distributed` table is not involved in either. There is no queue→own-dock
   * route on purpose: the initiator's own shard never enters the queue
   * (`prefer_localhost_replica` writes it synchronously), and a remote shard's
   * queue cannot flush to this server.
   *
   * The parking path is TWO legs, because the sharding expression is a step and
   * not a label: the whole block goes `Distributed` → the hash wheel
   * (`distToWheel`), and what leaves the wheel is a per-destination slice
   * (`wheelToSpool`), one duct to each shard's silo. A single door→queue duct
   * bypassing the wheel drew the queue as the thing that decides where rows go.
   * It is not. The wheel decides; the queue only holds what was decided.
   */
  distToWheel: (node: number) => `node.shardkey.${node}`,
  wheelToSpool: (node: number, shard: number) => `node.spool.${node}.${shard}`,
  spoolFlush: (from: number, to: number) => `spool.flush.${from}.${to}`,
  /** inside one node: the write path */
  distToDock: (node: number) => `node.split.${node}`,
  sortBlock: (node: number) => `node.sort.${node}`,
  writeColumns: (node: number) => `node.write.${node}`,
  /**
   * ONE PER TABLE. The rename that commits a part puts it in `system.parts` for
   * a particular table, and the tower it becomes stands in that table's band —
   * so a single duct into "the yard" was a claim the yard does not make. With
   * one duct per band you can watch which table is actually being written.
   */
  commitPart: (node: number, table: number) => `node.commit.${node}.${table}`,
  /** inside one node: the read path */
  /**
   * The analysis legs are PER TABLE, because the index is per table's parts and
   * a statement names one table. One duct per node meant a query on `sessions`
   * lit the same tube as a query on `hits`, and the tube ended at a building
   * that stood for all three at once.
   */
  probeIndex: (node: number, table: number) => `node.probe.${node}.${table}`,
  probeSkip: (node: number, table: number) => `node.skip.${node}.${table}`,
  markToPool: (node: number, table: number) => `node.marks.${node}.${table}`,
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
  const lane = 30 + 14 * n

  /* ONE corridor per server, travelled in both directions, because it is one
   * TCP connection: the statement goes up it and the answer comes back down
   * the same metal. Two separate lanes — statements west, answers east — were
   * a picture of two connections that do not exist. */
  const corridor: [number, number, number][] = [
    [-26 + n * 17, 4, ANCHOR.clientTerminal[2] + 22],
    [-26 + n * 17, 4, -392],
    [door[0] - lane * 0.25, 5, -300],
    [door[0] - 10, 5, door[2] - 40],
    [door[0] - 4, 4, door[2] - 10],
  ]

  route(
    rid.clientToNode(n),
    corridor,
    {
      what: 'a statement from the application',
      from: { label: 'application tier', id: 'clients' },
      to: { label: `${nodeHost(n)} · Distributed`, id: `node.${n}.dist` },
      note: `The application picked ${nodeHost(n)} out of the four, so ${nodeHost(n)} is the initiator for this statement. Any of them would have done, and that choice is the only thing the client decides.`,
    },
    { color: COLOR.client, speed: 125, size: 1.35, visible: true, roadOpacity: 0.15 },
  )

  /* The answer rides the SAME control points, reversed — Catmull-Rom is
   * symmetric under reversal, so the two directions trace one curve — with a
   * short approach from the result merge, where the one answer was assembled,
   * down to the front door. The duct's road is drawn once, by the statement
   * route above, exactly as the server-to-server ducts do it. */
  route(
    rid.nodeToClient(n),
    [[res[0], 6, res[2] - 8], ...[...corridor].reverse()],
    {
      what: 'the answer to a statement',
      from: { label: `${nodeHost(n)} · result merge`, id: `node.${n}.resultmerge` },
      to: { label: 'application tier', id: 'clients' },
      note: `The initiator combined its own rows with the partial results the other shards sent it, and this is the one answer the client sees — going home over the same connection the statement arrived on. It never learns how many machines were involved.`,
    },
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
    /* ONE arc for all three families and both directions — a forwarded block,
     * a fanned-out SELECT and a partial result share one connection pool, so
     * they ride one duct, and lane jitter keeps them apart inside it. The
     * per-family vertical offsets this used to have predate the tube roads:
     * they lifted the query and result families 1.6 and 3.2 units above the
     * drawn duct, which put their packets visibly OUTSIDE the pipe. */
    const mid: [number, number, number] = [
      (a[0] + b[0]) / 2,
      y + 4,
      (a[2] + b[2]) / 2 - (40 + 24 * rank),
    ]
    const bow: [number, number, number][] = [
      [a[0], y, a[2] + 6],
      [(a[0] + mid[0]) / 2, y + 2, (a[2] + mid[2]) / 2],
      mid,
      [(b[0] + mid[0]) / 2, y + 2, (b[2] + mid[2]) / 2],
      [b[0], y, b[2] + 6],
    ]
    /* An INSERT does not stop at the receiving server's Distributed table —
     * the sender opened a connection and is inserting into the *MergeTree*
     * table itself, so its duct rides the same bow and then keeps going, east
     * around the hall (which tops out at y ≈ 11.4) and down to the insert
     * dock. Ending this route at the far door was the old, wrong picture: it
     * drew a Distributed→Distributed hop that does not exist. */
    const dockB = anchorAt(to, 'insertDock')
    const dropToDock: [number, number, number][] = [
      [b[0] + 24, Math.max(8, y * 0.55), b[2] + 10],
      [dockB[0] + 6, 6, dockB[2] - 4],
    ]

    // The road belongs to the duct, not to any one of the three things on it,
    // so exactly one family draws it and only in the from < to direction —
    // otherwise six cables would be drawn as twelve lines in six places.
    const drawsRoad = from < to

    /* All three name the same two machines, because they share one connection
     * pool — the duct is the metal and the colour is the errand. */
    const a1 = nodeHost(from)
    const b1 = nodeHost(to)
    const doorFrom: RouteEnd = { label: `${a1} · Distributed`, id: `node.${from}.dist` }
    const doorTo: RouteEnd = { label: `${b1} · Distributed`, id: `node.${to}.dist` }
    const dockTo: RouteEnd = { label: `${b1} · insert dock`, id: `node.${to}.insertdock` }

    route(
      rid.fanInsert(from, to),
      [...bow, ...dropToDock],
      {
        what: 'a block being forwarded to the shard that owns it',
        from: doorFrom,
        to: dockTo,
        note: `${a1} evaluated the sharding expression over the rows it was given, and these are the ones that hashed to ${b1}'s shard. They were never ${a1}'s to keep — and they land in ${b1}'s underlying MergeTree table itself: ${b1}'s own Distributed table never sees them.`,
      },
      {
        color: COLOR.client,
        speed: 140,
        size: 1.25,
        visible: drawsRoad,
        roadOpacity: drawsRoad ? 0.13 : 0,
      },
    )
    /* The background flush rides the same corridor but starts at the QUEUE —
     * `system.distribution_queue` on the sender's own disk — because that is
     * what actually holds the block once the client has already been told ok.
     * No road of its own: in background mode (the default) the constant
     * traffic makes the path evident, and a second static line from the spool
     * would draw the six-pair arc diagram twice. */
    /* Out of the silo that actually holds it: the one for the DESTINATION
     * shard. Leaving from the centre of the pair drew a queue with one drain,
     * which is the thing the per-destination directories are not. */
    const spoolA = spoolSiloAt(from, shardOf(to))
    route(
      rid.spoolFlush(from, to),
      [
        [spoolA[0], 5, spoolA[2] - 2],
        [(spoolA[0] + mid[0]) / 2, y + 3, (spoolA[2] + mid[2]) / 2],
        [mid[0], mid[1] + 1.5, mid[2]],
        [(b[0] + mid[0]) / 2, y + 2, (b[2] + mid[2]) / 2],
        [b[0], y, b[2] + 6],
        ...dropToDock,
      ],
      {
        what: 'a queued block being flushed to its shard',
        from: { label: `${a1} · system.distribution_queue`, id: `node.${from}.spool` },
        to: dockTo,
        note: `The client that inserted this block got its ok when the block reached ${a1}'s disk. Only now does ${a1}'s background thread connect to one live replica of the target shard — ${b1} — and insert it into the underlying MergeTree table there, with retries until it works.`,
      },
      { color: COLOR.client, speed: 140, size: 1.25 },
    )
    route(
      rid.fanQuery(from, to),
      bow,
      {
        what: 'a SELECT being fanned out',
        from: doorFrom,
        to: doorTo,
        note: `${a1} is the initiator and cannot answer alone, so it asks one replica of every other shard the same question. This is the question, not the data — it is a few hundred bytes.`,
      },
      { color: COLOR.reader, speed: 155, size: 1.1 },
    )
    route(
      rid.fanResult(from, to),
      bow,
      {
        what: 'a partial result coming home',
        from: doorFrom,
        to: doorTo,
        note: `${a1} read its own parts and is sending ${b1}, the initiator, as little as the query allows — an aggregate state rather than rows, wherever the query can be split that way.`,
      },
      { color: COLOR.ok, speed: 165, size: 1.0 },
    )
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
  const host = nodeHost(n)
  const dockEnd: RouteEnd = { label: `${host} · insert dock`, id: `node.${n}.insertdock` }
  const yardEnd: RouteEnd = { label: `${host} · parts yard`, id: `node.${n}.yard` }
  const volEnd: RouteEnd = { label: `${host} · storage volumes`, id: `node.${n}.volumes` }
  const door = anchorAt(n, 'distTable')

  /* THE SPLIT, in three pieces of duct: the whole block goes door → wheel, and
   * what leaves the wheel is one slice per destination — down to this server's
   * own dock, or into the queue silo of the shard that owns it. One pod in, two
   * pods out, and the difference in their bulk is the sharding key doing its
   * job. Drawing the door as the fork instead put the decision in the table and
   * left the wheel as scenery; drawing no fork at all made the incoming freight
   * vanish at the door and parts appear from nowhere. */
  const wheelAt = anchorAt(n, 'shardWheel')
  /* Overhead, in one clear bow ABOVE the wheel (its ring sits at y ≈ 8–10),
   * ending just over the hub lamp rather than running through it at plinth
   * height: down there the duct was unreadable and could not be clicked,
   * because the wheel and the silos swallowed every ray before it reached the
   * tube. Every leg of the split starts or ends at this one point, so the fork
   * is a fork and not three ducts that happen to pass near each other. */
  const wheelTop: [number, number, number] = [wheelAt[0], 12.5, wheelAt[2]]
  const wheelEnd: RouteEnd = { label: `${host} · sharding key`, id: `node.${n}.wheel` }
  /* The split runs ELEVATED — a gantry above the strip, not a line along it.
   * At plinth height these three ducts crossed the wheel's plate, the silos and
   * the cluster board, and every one of those surfaces is lighter than a duct
   * at 0.12: from anywhere but straight overhead the path simply was not there.
   * Held at SPLIT_Y with only short vertical stubs into the wheel and the silo
   * caps, it reads as pipework against the sky. */
  const SPLIT_Y = 25
  /* Four times the network's usual 0.13. These three are the only ducts in the
   * city that carry the whole INSERT story in one span, and at road opacity
   * they read as haze against a daylit plate — the tube has to be the thing
   * you follow, not something you notice once you already know it is there. */
  const SPLIT_OPACITY = 0.55

  route(
    rid.distToWheel(n),
    [
      [door[0] - 10, 9, door[2] - 1],
      [door[0] - 15, SPLIT_Y - 4, door[2] - 1],
      [(door[0] + wheelAt[0]) / 2, SPLIT_Y, door[2] - 1],
      [wheelAt[0] + 5, SPLIT_Y - 3, wheelAt[2]],
      wheelTop,
    ],
    {
      what: 'a whole INSERT block, on its way to be cut up',
      from: { label: `${host} · Distributed`, id: `node.${n}.dist` },
      to: wheelEnd,
      note: `The block is still whole here. \`Distributed(cluster, db, table, key)\` evaluates the sharding key per ROW, takes it modulo the shard weights, and the block leaves this wheel cut into one slice per destination — which is why the duct in does not fork and the ducts out do.`,
    },
    { color: COLOR.client, speed: 90, size: 1.2, visible: true, roadOpacity: SPLIT_OPACITY },
  )

  route(
    rid.distToDock(n),
    [
      wheelTop,
      [wheelAt[0] + 8, 15, wheelAt[2] + 3],
      [(wheelAt[0] + dock[0]) / 2, 12, (wheelAt[2] + dock[2]) / 2 - 4],
      [dock[0] - 12, 8, dock[2] - 7],
      [dock[0], 6, dock[2] - 4],
    ],
    {
      what: "the slice for this server's own shard",
      from: wheelEnd,
      to: dockEnd,
      note: `These are the rows the sharding key sent to this server's OWN shard. They never enter the queue and never cross the network: they go straight down into the local table, synchronously, even when the rest of the block is being deferred. That short-cut is \`prefer_localhost_replica\`, and it is on by default.`,
    },
    { color: COLOR.client, speed: 95, size: 1.2, visible: true, roadOpacity: SPLIT_OPACITY },
  )

  /* One duct per destination shard, because there is one DIRECTORY per
   * destination shard — `data/<database>/<table>/shard1_…`, `shard2_…` — and
   * one silo already stands for each. The duct into this server's OWN shard's
   * silo is drawn and stays empty for the whole run, which is the visible form
   * of `prefer_localhost_replica`: that slice is written locally and
   * synchronously, so nothing is ever queued for it. */
  for (let s = 0; s < N_SHARDS; s++) {
    const silo = spoolSiloAt(n, s)
    const capY = SPOOL_SILO.baseY + SPOOL_SILO.height
    /* The two ducts run the same 45–60 units west along the same strip, so
     * they are separated in z rather than in height — one bowing to the plate's
     * north edge, one to its south. Stacked vertically instead, the near duct
     * hid the far one from every camera angle the strip is ever viewed from. */
    const zBow = wheelAt[2] + (s % 2 === 0 ? -7 : 9)
    route(
      rid.wheelToSpool(n, s),
      [
        wheelTop,
        [wheelAt[0] - 10, SPLIT_Y - 2, zBow],
        [(wheelAt[0] + silo[0]) / 2, SPLIT_Y, zBow],
        [silo[0] + 9, SPLIT_Y - 2, silo[2]],
        [silo[0], capY + 1.2, silo[2]],
      ],
      {
        what: `a slice for shard ${s + 1}, parked in the initiator's own queue`,
        from: wheelEnd,
        to: { label: `${host} · system.distribution_queue`, id: `node.${n}.spool` },
        note: `With \`distributed_foreground_insert = 0\` — the default — a slice bound for another shard is not sent now. It becomes a .bin file on THIS server's disk, under the directory for shard ${s + 1} and no other, the client is told ok, and a background thread flushes it later. Until that flush lands, no shard has this data.`,
      },
      { color: COLOR.client, speed: 90, size: 1.2, visible: true, roadOpacity: SPLIT_OPACITY },
    )
  }

  route(
    rid.sortBlock(n),
    [
      [dock[0], 6, dock[2]],
      [(dock[0] + sort[0]) / 2, 8, dock[2] - 2],
      [sort[0], 6, sort[2]],
    ],
    {
      what: 'a block on its way to be sorted',
      from: dockEnd,
      to: { label: `${host} · sort table`, id: `node.${n}.insertdock` },
      note: 'The rows arrived in whatever order the client sent them. A part is sorted by the ORDER BY key by definition, so this happens before anything is written, in memory, at insert time.',
    },
    { color: COLOR.partTemporary, speed: 70, size: 1.2 },
  )

  route(
    rid.writeColumns(n),
    [
      [sort[0], 6, sort[2] + 2],
      [dock[0], 9, dock[2] + 6],
      [writers[0], 6, writers[2]],
    ],
    {
      what: 'a sorted block going to the column writers',
      from: { label: `${host} · sort table`, id: `node.${n}.insertdock` },
      to: { label: `${host} · column writers`, id: `node.${n}.insertdock` },
      note: 'Split by the partition expression first — one part per partition, never one part spanning two — then each column is compressed into its own `.bin` with a `.mrk3` beside it.',
    },
    { color: COLOR.partPreactive, speed: 80, size: 1.15 },
  )

  /* Every point is derived from THIS island's anchors. The previous version
   * had `writers[0] * 0.5` — half of a WORLD x, which pulled the curve toward
   * world zero and across the neighbouring island — and a raw `-52` used as a
   * world z that was really a node-local one. It rides OVER the strip between
   * the writers and the yard (the cache deck plate is at y ≈ 9), because a
   * ground-level shortcut reads as a road through buildings it has nothing to
   * do with. */
  /* One duct per TABLE, ending over that table's own band at the level-0 lane —
   * the exact strip of ground where the tower is about to appear. A single duct
   * into the middle of the yard left the towers arriving from nowhere: you saw
   * a pod reach "the yard", and then a level-0 part stood up in a band the pod
   * had never pointed at. Held high and at COMMIT_OPACITY for the same reason
   * the split ducts are: this is the last leg of the INSERT and it has to be
   * followable across the whole island. */
  const COMMIT_Y = 26
  const COMMIT_OPACITY = 0.5
  for (let t = 0; t < N_TABLES; t++) {
    const laneZ = nodeLocal(n, 0, 0, partLaneZ(t, 0))[2]
    // Its own lane in x on the way over, so three ducts crossing the same
    // island read as three and not as one thick one.
    const xLane = yard[0] + (t - (N_TABLES - 1) / 2) * 15
    route(
      rid.commitPart(n, t),
      [
        [writers[0], 7, writers[2] + 3],
        [writers[0] - 3, COMMIT_Y - 6, writers[2] + 12],
        [xLane, COMMIT_Y, (writers[2] + laneZ) / 2],
        [xLane, COMMIT_Y - 5, laneZ - 16],
        [yard[0], CITY.yard.baseY + 4.5, laneZ - 4.5],
      ],
      {
        what: `a finished part being committed into ${TABLES[t].name}`,
        from: { label: `${host} · column writers`, id: `node.${n}.insertdock` },
        to: yardEnd,
        note: `The directory was written under a \`tmp_insert_\` name and is renamed into place here. That rename is the commit: the part becomes visible as a unit, and no query ever sees half of it. It lands in \`${TABLES[t].name}\`'s band at level 0 — every part in that front lane arrived exactly this way.`,
      },
      { color: COLOR.partActive, speed: 90, size: 1.3, visible: true, roadOpacity: COMMIT_OPACITY },
    )
  }

  route(
    rid.toHotVolume(n),
    [
      [yard[0] - 10, 4, yard[2] + 8],
      [hot[0] - 20, -8, hot[2] - 4],
      [hot[0], hot[1] + 5, hot[2]],
    ],
    {
      what: 'part bytes landing on the hot volume',
      from: yardEnd,
      to: volEnd,
      note: 'The yard is what `system.parts` knows about; this is where the directory physically is. A new part goes to the first volume of the storage policy, which here is local SSD.',
    },
    { color: COLOR.hot, speed: 70, size: 1.15 },
  )

  route(
    rid.hotToCold(n),
    [
      [hot[0] + 18, hot[1] + 4, hot[2]],
      [cold[0] + 26, (hot[1] + cold[1]) / 2, cold[2] + 6],
      [cold[0], cold[1] + 5, cold[2]],
    ],
    {
      what: 'a part being moved down to cold storage',
      from: volEnd,
      to: volEnd,
      note: 'A `TO VOLUME` move under the storage policy, or the hot volume crossing `move_factor`. The part is unchanged — same rows, same name, different disk — and it is a byte-for-byte copy followed by a delete, not a rewrite.',
    },
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
  const mc = anchorAt(n, 'markCache')
  const yard = anchorAt(n, 'partsYard')
  const pool = anchorAt(n, 'readPool')
  const host = nodeHost(n)
  const poolEnd: RouteEnd = { label: `${host} · read pool`, id: `node.${n}.readpool` }

  /* THE ANALYSIS LEGS, ONE SET PER TABLE.
   *
   * Every point below goes through `anchorAt`/`nodeLocal`. The previous version
   * had raw `[30, 20, -68]`, `[-40, 14, -20]` and `[30, 12, -46]` in the middle
   * of these curves — node-LOCAL numbers used as WORLD ones — so on every island
   * but the (nonexistent) one at world origin the duct left the plate, crossed
   * open ground towards x = 0 and came back. That is the "просто ужас": not the
   * idea, the arithmetic.
   *
   * Held at READ_Y over the cache deck (its plate is at y ≈ 9) so the long haul
   * from the pool to the west end reads as pipework and not as a road through
   * the yard. */
  const READ_Y = 24
  for (let t = 0; t < N_TABLES; t++) {
    const gate = indexGateAt(n, t)
    const skipG = skipGateAt(n, t)
    const tbl = TABLES[t].name
    const pkEnd: RouteEnd = { label: `${host} · ${tbl} · primary.cidx`, id: `node.${n}.primaryindex` }
    const skEnd: RouteEnd = { label: `${host} · ${tbl} · skip indexes`, id: `node.${n}.skipindexes` }

    route(
      rid.probeIndex(n, t),
      [
        [disp[0], 8, disp[2]],
        nodeLocal(n, 74, READ_Y, -66),
        nodeLocal(n, 0, READ_Y, bandZLocal(t) - 34),
        nodeLocal(n, -86, READ_Y - 8, bandZLocal(t) - 10),
        [gate[0], 13, gate[2]],
      ],
      {
        what: `a query looking for granules in ${tbl}`,
        from: poolEnd,
        to: pkEnd,
        note: `Once per PART of ${tbl}, in parallel, and never once for the table: each part carries its own \`primary.cidx\` with one sorting-key row per granule. What comes back is MARK RANGES — \`[begin × index_granularity, end × index_granularity)\` inside that one part — and a range in one part has nothing to do with the same numbers in another. Only a predicate that is one continuous key interval gets a true binary search; anything with \`IN\` or \`OR\` gets a coarse recursive exclusion search instead, which is why those leave many disjoint ranges behind.`,
      },
      { color: COLOR.primaryIndex, speed: 170, size: 1.0, visible: true, roadOpacity: 0.3 },
    )

    route(
      rid.probeSkip(n, t),
      [
        [gate[0] + 3, 11, gate[2] - 3],
        [(gate[0] + skipG[0]) / 2, 15, gate[2] - 6],
        [skipG[0], 10, skipG[2]],
      ],
      {
        what: `mark ranges being narrowed inside ${tbl}'s parts`,
        from: pkEnd,
        to: skEnd,
        note: `The primary index chose the ranges; \`skp_idx_*.idx2\` now throws granules away INSIDE them. Its unit is its own \`GRANULARITY n\` — n data granules per index granule — so the ranges are mapped into index-mark space, filtered, and expanded back. A part the primary index already emptied is never consulted, and a part missing the index file is passed through untouched. A skip index can only ever remove work, never add rows.`,
      },
      { color: COLOR.skipIndex, speed: 140, size: 0.95, visible: true, roadOpacity: 0.26 },
    )

    route(
      rid.markToPool(n, t),
      [
        [skipG[0] + 3, 10, skipG[2] + 3],
        nodeLocal(n, -60, 17, bandZLocal(t) + 8),
        [mc[0], mc[1] + 4, mc[2] + 4],
        nodeLocal(n, 70, 14, -62),
        [disp[0] - 6, 8, disp[2] + 4],
      ],
      {
        what: 'the surviving ranges, and the marks that locate them',
        from: skEnd,
        to: poolEnd,
        note: 'What reaches the pool is a list of (part, mark ranges) — the work the query has left after both indexes. A mark is the `.mrk3` entry holding the offset of the granule in the compressed `.bin` and the offset inside the decompressed block; the mark cache holds whole marks FILES, per part and stream, so a miss costs a disk read before the read has even begun. Adjacent ranges closer together than `merge_tree_min_rows_for_seek` were already coalesced here, so a few of the granules on their way in were never matched at all — seeking past them was not worth it.',
      },
      { color: COLOR.markCache, speed: 160, size: 0.9 },
    )
  }

  for (let th = 0; th < N_READ_THREADS; th++) {
    const bay = nodeLocal(n, readerBayLocal(th)[0], 0, readerBayLocal(th)[2])
    route(
      rid.poolToReader(n, th),
      [
        [disp[0], 6, disp[2] + 4],
        [bay[0] + 6, 6, (disp[2] + bay[2]) / 2],
        [bay[0], 4, bay[2]],
      ],
      {
        what: 'a batch of mark ranges handed to one reader thread',
        from: poolEnd,
        to: { label: `${host} · reader thread ${th + 1}`, id: `node.${n}.readpool` },
        note: '`MergeTreeReadPool` hands out work in batches rather than splitting the query up front, so a thread that finishes early comes back for more instead of idling while another finishes a hot range. `max_threads` is how many of these bays exist.',
      },
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
    {
      what: 'decompressed column data streaming up',
      from: { label: `${host} · parts yard`, id: `node.${n}.yard` },
      to: poolEnd,
      note: 'The bytes actually read. Every one of them was in a granule some earlier step failed to eliminate, which is why a query that names the wrong column can read a hundred times more than one that names the right one.',
    },
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
  const host = nodeHost(n)
  const yardEnd: RouteEnd = { label: `${host} · parts yard`, id: `node.${n}.yard` }
  const gantryEnd: RouteEnd = { label: `${host} · system.merges`, id: `node.${n}.merges` }
  const ttlEnd: RouteEnd = { label: `${host} · TTL works`, id: `node.${n}.ttl` }

  route(
    rid.yardToMerge(n),
    [
      [yard[0] - 24, 5, yard[2] + 22],
      [gantry[0] - 14, 12, gantry[2] - 12],
      [gantry[0], 14, gantry[2]],
    ],
    {
      what: 'a part entering a merge',
      from: yardEnd,
      to: gantryEnd,
      note: 'Several parts of ONE partition of ONE table, selected together and reserved. A merge never crosses a partition boundary, which is why a partition key with too many values leaves a cluster unable to merge its way out of trouble.',
    },
    { color: COLOR.merge, speed: 80, size: 1.3, visible: true, roadOpacity: 0.16 },
  )

  route(
    rid.mergeToYard(n),
    [
      [gantry[0] + 12, 14, gantry[2]],
      [yard[0] + 24, 11, yard[2] + 20],
      [yard[0] + 30, 5, yard[2] + 6],
    ],
    {
      what: 'the merged part going back to the yard',
      from: gantryEnd,
      to: yardEnd,
      note: 'One new part in place of its inputs, written out in sorted order in a single pass. The inputs do not disappear: they turn OUTDATED and stay on disk until no running query is still reading them.',
    },
    { color: COLOR.partActive, speed: 90, size: 1.4 },
  )

  route(
    rid.yardToTtl(n),
    [
      [yard[0] + 34, 5, yard[2] + 20],
      [(yard[0] + ttl[0]) / 2 + 14, 9, ttl[2] - 6],
      [ttl[0], 7, ttl[2]],
    ],
    {
      what: 'a part with expired rows going to the TTL works',
      from: yardEnd,
      to: ttlEnd,
      note: 'A TTL merge takes exactly ONE input part and rewrites it without the expired rows. It is a merge in every respect except that it does not consolidate anything, and `merge_with_ttl_timeout` is how often a part is even considered for it.',
    },
    { color: COLOR.ttl, speed: 85, size: 1.2, visible: true, roadOpacity: 0.14 },
  )

  route(
    rid.ttlDrop(n),
    [
      [ttl[0], 6, ttl[2] + 8],
      [ttl[0] + 12, 3, ttl[2] + 26],
      [ttl[0] + 18, 0.6, ttl[2] + 38],
    ],
    {
      what: 'expired rows being dropped',
      from: ttlEnd,
      to: { label: 'nowhere — they are gone', },
      note: 'The rewritten part does not contain them and the old part is superseded. This is the only traffic in the cluster with no destination, because deleting rows in a MergeTree means writing a part that lacks them.',
    },
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
    {
      what: 'a metadata write to Keeper',
      from: { label: `${nodeHost(n)} · replication queue`, id: `node.${n}.queue` },
      to: { label: 'Keeper quorum', id: 'keeper.ensemble' },
      note: 'A few hundred bytes saying a part exists — never the part. Nothing on this wire is user data, and yet no block is written anywhere in the cluster without it: lose the session and the replica goes read-only.',
    },
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
    {
      what: 'a log entry arriving from Keeper',
      from: { label: 'Keeper quorum', id: 'keeper.ensemble' },
      to: { label: `${nodeHost(n)} · replication queue`, id: `node.${n}.queue` },
      note: 'The other replica wrote a part and said so; this replica now has an entry in `system.replication_queue` telling it to go and get it. This wire carries the INSTRUCTION. The part itself comes over the coral wire, directly from the other replica.',
    },
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
        {
          what: 'a whole part directory over HTTP',
          from: { label: `${nodeHost(from)} · parts yard`, id: `node.${from}.yard` },
          to: { label: `${nodeHost(to)} · insert dock`, id: `node.${to}.insertdock` },
          note: `The biggest thing that moves in this cluster, and it goes replica to replica — never through Keeper, which only said the part existed. Both machines are in shard ${s + 1} and hold the same rows; that is what a replica is.`,
        },
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
    {
      what: 'a raft log entry, and the vote back',
      from: { label: 'Keeper leader', id: 'keeper.1' },
      to: { label: `Keeper follower ${i + 1}`, id: `keeper.${i}` },
      note: 'Agreement, not data. The leader is not allowed to consider an entry committed until a majority has it, and a majority of three is two — which is the whole reason the ensemble is an odd number.',
    },
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
