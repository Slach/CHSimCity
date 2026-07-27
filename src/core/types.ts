/* ============================================================================
 * CHSimCity — shared contracts.
 *
 * Everything in this file is API surface consumed by more than one module.
 * The simulation (src/sim) never imports three.js; the world (src/world) never
 * mutates simulation state. They meet here.
 * ==========================================================================*/

import type * as THREE from 'three'

/* ---------------------------------------------------------------------------
 * Cluster shape — geometry and simulation must agree on these counts.
 * -------------------------------------------------------------------------*/

/** Shards in the cluster. */
export const N_SHARDS = 2
/** Replicas per shard. `ReplicatedMergeTree` needs at least two to be a lesson. */
export const N_REPLICAS = 2
/** Total data nodes. Node index is `shard * N_REPLICAS + replica`. */
export const N_NODES = N_SHARDS * N_REPLICAS
/** `ClickHouse Keeper` ensemble. Three is the smallest quorum that survives one loss. */
export const N_KEEPERS = 3

/**
 * Visible part slots per node, per table. A real node holds thousands of parts;
 * the yard is a window onto the newest `N_PART_SLOTS` of them, ordered the way
 * `system.parts` orders them (partition, then min_block).
 */
export const N_PART_SLOTS = 96

/** `index_granularity` — rows per mark, and ClickHouse's real default. */
export const INDEX_GRANULARITY = 8192

/**
 * `MergeTreeReadPool` reader threads drawn per node. Mirrors `max_threads`,
 * whose default on a real server is the core count.
 */
export const N_READ_THREADS = 8

/** Background merge slots per node — `background_pool_size`. */
export const N_MERGE_SLOTS = 4

/** Visible replication-queue slots per node. */
export const N_QUEUE_SLOTS = 12

/** Mark cache size range exposed by the console, in MiB. */
export const MARK_CACHE_MIN_MIB = 32
export const MARK_CACHE_MAX_MIB = 8 * 1024

/** Uncompressed cache size range exposed by the console, in MiB. */
export const UNCOMPRESSED_CACHE_MIN_MIB = 0
export const UNCOMPRESSED_CACHE_MAX_MIB = 32 * 1024

/**
 * `MergeTree` compresses in blocks of at most this many bytes before
 * compression — `max_compress_block_size`. One entry in `.mrk3` addresses one
 * of these, which is why a mark is a *pair* of offsets.
 */
export const COMPRESS_BLOCK_BYTES = 1024 * 1024

/* ---------------------------------------------------------------------------
 * Tables and their columns — the data the whole cluster moves around.
 * -------------------------------------------------------------------------*/

export type ColumnKind =
  | 'date'
  | 'datetime'
  | 'int'
  | 'float'
  | 'string'
  | 'lowcardinality'
  | 'array'
  | 'map'
  | 'json'

export interface ColumnDef {
  id: string
  name: string
  /** SQL type as it would appear in `SHOW CREATE TABLE`. */
  type: string
  kind: ColumnKind
  /** Uncompressed bytes per row, on average. */
  bytesPerRow: number
  /**
   * Compression ratio this column actually achieves. A sorted `DateTime` in a
   * table ordered by time compresses to almost nothing with `Delta`; a random
   * `String` barely compresses at all. This is the single number that explains
   * why ORDER BY choice is a storage decision, not only a query one.
   */
  ratio: number
  /** Codec chain, e.g. `Delta, ZSTD(1)`. Cosmetic, but it explains `ratio`. */
  codec: string
  /** Part of the sorting key, in ORDER BY position. -1 = not a key column. */
  keyPos: number
  /** Accent colour (hex int) used by the parts yard and the read pool. */
  color: number
}

export type SkipIndexKind = 'minmax' | 'set' | 'bloom_filter' | 'tokenbf_v1' | 'ngrambf_v1'

export interface SkipIndexDef {
  id: string
  name: string
  kind: SkipIndexKind
  /** Expression the index is built on. */
  expr: string
  /** `GRANULARITY n` — how many index granules one index granule covers. */
  granularity: number
  /**
   * Share of granules this index can prove irrelevant for a query that uses it,
   * 0..1. A `minmax` on a column correlated with the sorting key is nearly
   * perfect; a `bloom_filter` on a high-cardinality column is good; a `set` on
   * a low-cardinality column that appears in every granule is worthless.
   */
  selectivity: number
}

export interface TableDef {
  id: string
  name: string
  /** `MergeTree` family engine this table uses. */
  engine: 'MergeTree' | 'ReplicatedMergeTree' | 'ReplacingMergeTree' | 'SummingMergeTree'
  /** Human blurb shown in the inspector. */
  blurb: string
  /** `PARTITION BY` expression. */
  partitionBy: string
  /** `ORDER BY` expression, rendered from the key columns. */
  orderBy: string
  /** How many partitions exist. Parts never merge across a partition boundary. */
  partitions: number
  /** Rows this table starts life with. */
  initialRows: number
  /** Share of the cluster's INSERT traffic that lands here (relative weight). */
  insertWeight: number
  /** Share of the cluster's SELECT traffic (relative weight). */
  selectWeight: number
  /** `TTL` expression, if any. */
  ttl?: string
  /** Seconds of data a row survives before its TTL expires. */
  ttlSeconds?: number
  /** `ttl_only_drop_parts` — drop a wholly-expired part instead of rewriting it. */
  ttlOnlyDropParts?: boolean
  columns: ColumnDef[]
  skipIndexes: SkipIndexDef[]
  /** Accent colour for the whole table. */
  color: number
}

/* ---------------------------------------------------------------------------
 * Knobs — user-facing settings and workload dials.
 * -------------------------------------------------------------------------*/

/** `distributed_foreground_insert` (formerly `insert_distributed_sync`). */
export type DistributedInsertMode = 'background' | 'foreground'

/** `insert_quorum` on a `ReplicatedMergeTree` write. */
export type InsertQuorum = 'none' | 'one' | 'majority' | 'all'

/** Which replicas a distributed SELECT reads from. */
export type LoadBalancing = 'random' | 'nearest_hostname' | 'in_order' | 'round_robin'

/**
 * How the APPLICATION picks which server to connect to. This is not a
 * ClickHouse setting — it is a property of the driver's configuration or of the
 * load balancer in front of the cluster, and it decides which server becomes
 * the initiator of each statement.
 *
 * `single` is the one worth watching: it is what you get from one hostname in a
 * connection string, and it makes one server do every fan-out and every result
 * merge in the cluster while the other three only ever serve their own shard.
 */
export type ClientBalancing = 'round_robin' | 'random' | 'single'

export interface Knobs {
  /** INSERT statements per second offered by the clients. */
  insertsPerSec: number
  /** Rows in one INSERT block, before ClickHouse splits it by partition. */
  insertBlockRows: number
  /** SELECT statements per second offered by the clients. */
  selectsPerSec: number
  /** 0..1 — share of SELECTs whose WHERE prefix matches the sorting key. */
  primaryKeyHitRatio: number
  /** 0..1 — share of SELECTs that filter on a column a skip index covers. */
  skipIndexUseRatio: number
  /** 0..1 — share of SELECTs restricted to one partition. */
  partitionPruneRatio: number

  /** `async_insert` — batch small INSERTs in the server before writing a part. */
  asyncInsert: boolean
  /** `async_insert_max_data_size`, in KiB. */
  asyncInsertMaxDataKib: number
  /** `async_insert_busy_timeout_ms`. */
  asyncInsertBusyTimeoutMs: number
  /** `wait_for_async_insert` — does the client block until the part is written? */
  waitForAsyncInsert: boolean

  /** How the application picks the server it connects to — not a server setting. */
  clientBalancing: ClientBalancing
  distributedInsert: DistributedInsertMode
  insertQuorum: InsertQuorum
  loadBalancing: LoadBalancing
  /** `parallel_replicas` — split one shard's read across its replicas. */
  parallelReplicas: boolean

  /** `mark_cache_size`, MiB. */
  markCacheMib: number
  /** `uncompressed_cache_size`, MiB. 0 disables it, which is the default. */
  uncompressedCacheMib: number
  /** `max_threads` — reader threads one query may use per node. */
  maxThreads: number

  /** `background_pool_size` — concurrent merges per node. */
  mergePoolSize: number
  /** `max_bytes_to_merge_at_max_space_in_pool`, GiB. */
  maxBytesToMergeGib: number
  /** `parts_to_delay_insert`. */
  partsToDelayInsert: number
  /** `parts_to_throw_insert`. */
  partsToThrowInsert: number
  /** `merge_with_ttl_timeout`, seconds between TTL merges of one part. */
  mergeWithTtlTimeout: number
  /** Whether the TTL rules are enforced at all. */
  ttlEnabled: boolean
  /** Move expired parts to the cold volume instead of deleting them. */
  ttlMoveToCold: boolean

  /** Is the Keeper ensemble reachable? Off means read-only tables. */
  keeperConnected: boolean
  /** One-way network delay to Keeper and to the sibling replica, ms. */
  networkLatencyMs: number
  /** One replica cannot keep up: its queue grows and `absolute_delay` climbs. */
  slowReplica: boolean
  /** A long-running `ALTER UPDATE`/`DELETE` mutation is in flight. */
  runningMutation: boolean
  /** One node is down. Its shard survives on the sibling replica. */
  nodeDown: boolean

  /** Simulation speed multiplier. */
  timeScale: number
  paused: boolean
}

export const DEFAULT_KNOBS: Knobs = {
  insertsPerSec: 4,
  insertBlockRows: 100000,
  selectsPerSec: 6,
  primaryKeyHitRatio: 0.7,
  skipIndexUseRatio: 0.35,
  partitionPruneRatio: 0.6,

  asyncInsert: false,
  asyncInsertMaxDataKib: 1024,
  asyncInsertBusyTimeoutMs: 200,
  waitForAsyncInsert: true,

  clientBalancing: 'round_robin',
  distributedInsert: 'background',
  insertQuorum: 'none',
  loadBalancing: 'random',
  parallelReplicas: false,

  markCacheMib: 5 * 1024,
  uncompressedCacheMib: 0,
  maxThreads: N_READ_THREADS,

  mergePoolSize: N_MERGE_SLOTS,
  maxBytesToMergeGib: 150,
  partsToDelayInsert: 150,
  partsToThrowInsert: 300,
  // ClickHouse's own default is 14400 s (four hours). At that setting the TTL
  // works would sit idle for an entire visit, so the city ships a value a
  // real operator would use on a table whose TTL matters minute to minute.
  mergeWithTtlTimeout: 20,
  ttlEnabled: true,
  ttlMoveToCold: false,

  keeperConnected: true,
  networkLatencyMs: 20,
  slowReplica: false,
  runningMutation: false,
  nodeDown: false,

  timeScale: 1,
  paused: false,
}

/* ---------------------------------------------------------------------------
 * Parts — the single most important object in the whole model.
 * -------------------------------------------------------------------------*/

/**
 * `IMergeTreeDataPart::State`. The names are ClickHouse's own, and the
 * transitions are what `system.parts` shows you:
 *
 *   temporary  written under `tmp_insert_…`, not yet visible to anybody
 *   preactive  renamed into place, being committed into the data-part set
 *   active     visible to SELECTs — the only state that answers a query
 *   outdated   superseded by a merge, still referenced by running queries
 *   deleting   reference count hit zero; the directory is going away
 */
export type PartState = 'temporary' | 'preactive' | 'active' | 'outdated' | 'deleting'

export interface PartSim {
  /**
   * Stable identity for the visual slot, or -1.
   *
   * The parts yard is a WINDOW onto the newest `N_PART_SLOTS` parts per table.
   * A part beyond that window is fully simulated — it merges, it expires, it is
   * fetched, it counts in every total — it simply has nowhere to stand, and the
   * world skips it. That is what keeps the counters true when the yard is full
   * rather than silently dropping the part.
   */
  slot: number
  /** `system.parts.name`, e.g. `20260727_412_418_2`. */
  name: string
  /** Which partition this part belongs to. Merges never cross this line. */
  partition: number
  /** `min_block_number` / `max_block_number` — the block range this part covers. */
  minBlock: number
  maxBlock: number
  /** Merge level. 0 = straight out of an INSERT; each merge adds one. */
  level: number
  /** Mutation version, the trailing `_N` a mutated part carries. */
  mutation: number
  rows: number
  /** `bytes_on_disk` — after compression. */
  bytesOnDisk: number
  /** `data_uncompressed_bytes`. The ratio between the two is the whole point. */
  bytesUncompressed: number
  /** `marks_count` = ceil(rows / index_granularity) + 1. */
  marks: number
  state: PartState
  /** Which storage volume the part lives on. 0 = hot, 1 = cold. */
  volume: number
  /** Simulated time this part was created. */
  createdAt: number
  /** Simulated time it entered its current state. Drives the state machine. */
  stateSince: number
  /** Simulated time the oldest row in this part expires. */
  ttlMin: number
  /** …and the newest. A part is wholly expired once `t > ttlMax`. */
  ttlMax: number
  /** True while a merge or mutation has this part as an input. */
  reserved: boolean
  /** 0..1 — how recently this part was read. Drives the yard's heat. */
  heat: number
  /** True if this part arrived by fetch from the sibling replica, not by INSERT. */
  fetched: boolean
}

/* ---------------------------------------------------------------------------
 * Merges and mutations — `system.merges` and `system.mutations`.
 * -------------------------------------------------------------------------*/

/**
 * Why the merge selector picked this set of parts. These are the real reasons
 * `MergeTreeDataMergerMutator` reports, and they are not interchangeable: a
 * TTL merge runs even when the parts are already large, and a `FINAL` merge
 * ignores the size limits entirely.
 */
export type MergeReason = 'regular' | 'ttl_delete' | 'ttl_recompress' | 'final' | 'mutation'

/**
 * Which of the two merge algorithms is running. `Horizontal` reads every column
 * of every input part at once; `Vertical` merges the sorting-key columns first,
 * records the row permutation, then applies it one column at a time. Vertical
 * needs far less memory on a wide table, and it is what
 * `enable_vertical_merge_algorithm` turns on.
 */
export type MergeAlgorithm = 'horizontal' | 'vertical'

export interface MergeSim {
  slot: number
  node: number
  table: number
  active: boolean
  reason: MergeReason
  algorithm: MergeAlgorithm
  /** `result_part_name` — the name the output part will take. */
  resultPart: string
  /** Names of the input parts, in sorting order. */
  sourceParts: string[]
  /** Slots of the input parts, so the world can draw the gantry over them. */
  sourceSlots: number[]
  partition: number
  /** 0..1, and it is `rows_written / rows_read`, exactly as ClickHouse reports. */
  progress: number
  rowsRead: number
  totalRows: number
  bytesRead: number
  totalBytes: number
  /** `memory_usage` — a horizontal merge on a wide table is the memory story. */
  memoryBytes: number
  elapsed: number
  /** Which column the vertical phase is on, or -1 during the horizontal phase. */
  verticalColumn: number
  /** Seconds this merge is expected to take at the current I/O pressure. */
  duration: number
}

export type MutationState = 'idle' | 'running' | 'done' | 'failed'

export interface MutationSim {
  /** `mutation_id`, e.g. `mutation_43.txt`. */
  id: string
  command: string
  state: MutationState
  /** Parts still carrying the old version. */
  partsToDo: number
  partsDone: number
  createdAt: number
  /** Set when a mutation cannot proceed — the classic "stuck mutation". */
  failReason: string
}

/* ---------------------------------------------------------------------------
 * The read path — `MergeTreeReadPool` and the caches.
 * -------------------------------------------------------------------------*/

export type ReaderState = 'idle' | 'seeking' | 'reading' | 'decompressing' | 'filtering' | 'aggregating'

export interface ReaderSim {
  slot: number
  state: ReaderState
  /** Which part this thread is currently reading, by slot. -1 = none. */
  part: number
  /** Mark range handed out by the pool: [begin, end). */
  markBegin: number
  markEnd: number
  /** Marks consumed so far inside the range. */
  marksDone: number
  /** Which column of the part this thread is on. */
  column: number
  /** 0..1 progress through its task. */
  progress: number
  /** Did the last mark come out of the mark cache? */
  markCacheHit: boolean
  /** Did the last block come out of the uncompressed cache? */
  blockCacheHit: boolean
}

export interface CacheSim {
  /** Configured capacity, bytes. */
  capacityBytes: number
  /** Bytes currently held. */
  usedBytes: number
  hits: number
  misses: number
  /** Smoothed 0..1. */
  hitRatio: number
  /** Entries evicted since boot. */
  evictions: number
}

/**
 * One SELECT in flight on one node. This is what `system.query_log` and
 * `system.processes` describe, and it is where the read-path lesson lives:
 * `granulesTotal` vs `granulesAfterKey` vs `granulesAfterSkip` is the entire
 * story of why a ClickHouse query is fast or slow.
 */
export interface QuerySim {
  id: number
  /** The server doing this piece of the reading. */
  node: number
  /**
   * The server the client connected to, which fanned this query out and will
   * merge the partial results. Equal to `node` for the initiator's own share of
   * the work — a server reads its own shard as well as asking the others.
   */
  initiator: number
  table: number
  active: boolean
  sql: string
  /** Partitions the query could touch, before and after pruning. */
  partsTotal: number
  partsSelected: number
  /** Index granules, before the primary key, after it, and after skip indexes. */
  granulesTotal: number
  granulesAfterKey: number
  granulesAfterSkip: number
  rowsRead: number
  bytesRead: number
  /** Reader threads assigned. */
  threads: number
  elapsed: number
  duration: number
  /** Peak memory this query has held. */
  memoryBytes: number
  /** True once the initiator has all shards' partial results. */
  merged: boolean
}

/* ---------------------------------------------------------------------------
 * Replication — the Keeper log and one node's queue.
 * -------------------------------------------------------------------------*/

/**
 * `ReplicatedMergeTreeLogEntry::Type`. Everything a replica does to its data,
 * it does because one of these appeared in `/log` and it copied the entry into
 * its own `/queue`. That is the whole of ClickHouse replication.
 */
export type LogEntryType = 'GET_PART' | 'MERGE_PARTS' | 'MUTATE_PART' | 'DROP_RANGE' | 'ATTACH_PART'

export interface QueueEntrySim {
  slot: number
  type: LogEntryType
  /** Which table the entry belongs to. A log is per table per shard. */
  table: number
  /** `new_part_name`. */
  partName: string
  /** `system.replication_queue.num_tries`. */
  tries: number
  createdAt: number
  /** True while this replica is actually executing the entry. */
  executing: boolean
  /** 0..1 for a fetch or a merge that is under way. */
  progress: number
  /** Set when the entry keeps failing — a stuck queue. */
  lastException: string
}

export interface NodeReplicationSim {
  /** Is this replica able to talk to Keeper? Otherwise the table is read-only. */
  connected: boolean
  readOnly: boolean
  /** `system.replicas.log_pointer` — how far this replica has read `/log`. */
  logPointer: number
  /** `system.replicas.log_max_index` — how far `/log` goes. */
  logMaxIndex: number
  /** `system.replicas.absolute_delay`, seconds. */
  absoluteDelay: number
  queue: QueueEntrySim[]
  /** `queue_size`, including entries beyond the visible slots. */
  queueSize: number
  /** Entries of each kind still queued. */
  insertsInQueue: number
  mergesInQueue: number
  /** Parts fetched from a sibling since boot. */
  partsFetched: number
  /** Parts sent to a sibling since boot. */
  partsSent: number
}

export type KeeperRole = 'leader' | 'follower' | 'observer' | 'down'

export interface KeeperSim {
  slot: number
  role: KeeperRole
  /** Raft term. Bumped by every election. */
  term: number
  /** Last committed raft index. */
  commitIndex: number
  /** Open sessions — one per ClickHouse server, plus watchers. */
  sessions: number
  /** znodes held. This is the number that eats a Keeper's heap. */
  znodes: number
  /** Requests per second this node is serving. */
  requestsPerSec: number
  /** 0..1 activity heat. */
  activity: number
}

/* ---------------------------------------------------------------------------
 * Storage volumes — `storage_policy`, hot and cold.
 * -------------------------------------------------------------------------*/

export interface VolumeSim {
  id: number
  name: string
  /** Disk type as `system.disks` would name it. */
  kind: 'local_ssd' | 'local_hdd' | 's3'
  totalBytes: number
  usedBytes: number
  /** Bytes per second this volume sustains before writes start queueing. */
  throughputBytesPerSec: number
  /** 0..1 — how saturated the device is right now. */
  load: number
}

/* ---------------------------------------------------------------------------
 * One data node.
 * -------------------------------------------------------------------------*/

export type NodeStatus = 'up' | 'starting' | 'readonly' | 'down'

/** Per-table state on one node. */
export interface NodeTableSim {
  table: number
  parts: PartSim[]
  /** Live counts, recomputed every tick from `parts`. */
  activeParts: number
  outdatedParts: number
  rows: number
  bytesOnDisk: number
  bytesUncompressed: number
  /** Next block number this replica will allocate. */
  nextBlock: number
  /** Parts whose TTL has wholly expired and are waiting for a TTL merge. */
  expiredParts: number
  /** 0..1 activity heat, decays. */
  heat: number
  /** Cumulative `system.part_log` counters. */
  partsInserted: number
  partsMerged: number
  partsDropped: number
}

export interface NodeSim {
  index: number
  shard: number
  replica: number
  /** `hostname()` as the cluster config would name it. */
  host: string
  status: NodeStatus
  tables: NodeTableSim[]
  /** Merges in flight — `system.merges`. */
  merges: MergeSim[]
  mutations: MutationSim[]
  readers: ReaderSim[]
  queries: QuerySim[]
  markCache: CacheSim
  uncompressedCache: CacheSim
  replication: NodeReplicationSim
  volumes: VolumeSim[]
  /** Rows per second this node is writing. */
  insertRowsPerSec: number
  /** Rows per second this node is reading. */
  selectRowsPerSec: number
  /** 0..1 — how much of the insert path is being delayed by `parts_to_delay_insert`. */
  insertDelay: number
  /** INSERTs rejected with `TOO_MANY_PARTS`. */
  tooManyPartsErrors: number
  /** Total memory this node has committed, bytes. */
  memoryBytes: number
  /** `MemoryTracking` peak. */
  memoryPeakBytes: number
  /** Bytes sitting in the async-insert buffer, if `async_insert` is on. */
  asyncInsertBytes: number
  /** Queries this node has served since boot. */
  queriesServed: number
  /** Blocks this node has written since boot. */
  blocksWritten: number
  /** 0..1 CPU heat. */
  cpu: number
  /**
   * This server's own `Distributed` table. Every server has one; whether it is
   * currently acting as an initiator depends only on where the clients pointed.
   */
  distributed: DistributedSim
}

/* ---------------------------------------------------------------------------
 * The Distributed table — ONE PER SERVER.
 *
 * `Distributed` is a table engine, not a machine. `CREATE TABLE … ENGINE =
 * Distributed(cluster, db, local_table, key)` is executed on every server in
 * the cluster, so every server has the table, every server knows the whole
 * cluster from `system.clusters`, and every server can serve the query. The
 * server that becomes the INITIATOR of a query is simply the one the client
 * happened to connect to; it fans the query out to one replica per shard,
 * merges what comes back, and answers. The next query can be initiated by a
 * different server, and usually is.
 *
 * This state is therefore per node. `nodes[i].distributed` is server `i`'s own
 * copy of the table, its own spool directory on its own disk, and its own share
 * of the result-merging work.
 * -------------------------------------------------------------------------*/

export interface DistributedSim {
  /**
   * Blocks waiting in `data/<cluster>/shard<N>_replica<M>/` for a background
   * flush — on THIS server's disk. Indexed by shard.
   */
  pendingBlocks: number[]
  pendingBytes: number[]
  /** Which shard the last INSERT through this server hashed to. */
  lastShard: number
  /** Cumulative rows this server routed to each shard — the skew story. */
  rowsToShard: number[]
  /** Reads in flight to each shard, and which replica each one picked. */
  readShard: number[]
  /** How many SELECTs this server is currently fanning out as initiator. */
  fanOut: number
  /** Rows this server has merged from other shards' partial results. */
  rowsMerged: number
  /** Bytes this server has read from remote shards. */
  bytesFromRemote: number
  /** SELECTs the application has initiated here since boot. */
  queriesInitiated: number
  /** INSERTs the application has initiated here since boot. */
  insertsInitiated: number
  /** 0..1 activity. */
  activity: number
}

/* ---------------------------------------------------------------------------
 * The application tier.
 *
 * The clients are not part of the cluster and hold no data. Their one decision
 * is which server to open a connection to, and that decision is what makes
 * that server the initiator. A driver with four hostnames in it spreads the
 * initiator role; a driver with one hostname — or one load balancer that always
 * picks the same backend — makes one server do all the fan-out and all the
 * result merging for the whole cluster.
 * -------------------------------------------------------------------------*/

export interface ClientsSim {
  /** The server the last INSERT was sent to. */
  lastInsertTarget: number
  /** The server the last SELECT was sent to. */
  lastSelectTarget: number
  /** Statements the application has sent to each server since boot. */
  sentToNode: number[]
  /** Servers the driver currently believes it can reach. */
  reachable: number
  /** 0..1 activity. */
  activity: number
}

/* ---------------------------------------------------------------------------
 * Aggregate statistics.
 * -------------------------------------------------------------------------*/

export interface SimStats {
  insertsPerSec: number
  selectsPerSec: number
  insertRowsPerSec: number
  selectRowsPerSec: number
  /** Total parts across the whole cluster, active only. */
  activeParts: number
  /** Merges running cluster-wide. */
  runningMerges: number
  /** Rows per second all merges together are rewriting. */
  mergeRowsPerSec: number
  totalRows: number
  totalBytesOnDisk: number
  totalBytesUncompressed: number
  /** `bytesUncompressed / bytesOnDisk`. */
  compressionRatio: number
  markCacheHitPct: number
  /** Mean seconds a SELECT takes, cluster-wide. */
  meanQueryMs: number
  /** Worst `absolute_delay` across all replicas. */
  maxReplicaDelay: number
  /** Worst replication `queue_size`. */
  maxQueueSize: number
  /** Rolling windows for the sparklines: newest last. */
  history: {
    parts: number[]
    merges: number[]
    insertRows: number[]
    selectRows: number[]
    delay: number[]
    markCache: number[]
  }
}

export interface SimState {
  /** Simulated seconds since boot. */
  t: number
  /** Wall seconds since boot. */
  realT: number
  knobs: Knobs
  tables: TableDef[]
  nodes: NodeSim[]
  keepers: KeeperSim[]
  /**
   * The application tier. There is no `distributed` here on purpose: the
   * `Distributed` table is not a place in the cluster, it is a table on each
   * server, and it lives at `nodes[i].distributed`.
   */
  clients: ClientsSim
  stats: SimStats
  /** Monotonic query id, so the world can tell one SELECT from the next. */
  nextQueryId: number
  /** Keeper's `/log` — the shared truth every replica pulls from. */
  keeperLogIndex: number
  scenario: string | null
  scenarioT: number
}

export interface SimApi {
  state: SimState
  /** Advance by dt simulated seconds (already scaled by timeScale). */
  update(dt: number): void
  setKnob<K extends keyof Knobs>(key: K, value: Knobs[K]): void
  runScenario(id: string | null): void
  reset(): void
  /** Force one merge on one node, the way `OPTIMIZE TABLE` does. */
  optimize(node: number, table: number, final: boolean): void
}

/* ---------------------------------------------------------------------------
 * Event bus.
 * -------------------------------------------------------------------------*/

export type FlowKind =
  | 'insert' // client → initiator, initiator → shard
  | 'block' // a sorted block heading for disk
  | 'part_write' // columns being written into a part
  | 'query' // SELECT fan-out
  | 'result' // partial results coming back
  | 'mark_read' // a mark range being read
  | 'column_read' // a column stripe being read
  | 'merge' // parts entering a merge
  | 'ttl' // rows being dropped by TTL
  | 'fetch' // a part crossing between replicas
  | 'keeper' // a Keeper request or log entry
  | 'move' // a part moving between volumes
  | 'stat'

/** A request to send N particles down a named route. */
export interface FlowRequest {
  route: string
  count?: number
  /** hex colour; defaults to the route's colour */
  color?: number
  /** world units/sec; defaults to the route's speed */
  speed?: number
  size?: number
  kind?: FlowKind
  /** lateral jitter in world units */
  spread?: number
  /** stagger emission over this many seconds */
  stagger?: number
}

export type QualityLevel = 'low' | 'reduced' | 'medium' | 'high' | 'ultra'

export interface BusEvents {
  flow: FlowRequest
  /** Camera should frame a component. */
  focus: { id: string | null; instant?: boolean }
  select: { id: string | null }
  hover: { id: string | null }
  knob: { key: keyof Knobs; value: unknown }
  scenario: { id: string | null }
  toast: { text: string; kind?: 'info' | 'warn' | 'good'; ms?: number }
  narrate: { title: string; body: string; seconds?: number } | null
  'tour:start': { chapter?: number }
  'tour:stop': Record<string, never>
  'tour:chapter': { index: number; total: number; title: string }
  'camera:mode': { mode: CameraMode }
  quality: { level: QualityLevel }
  'sim:reset': Record<string, never>
  /** Something dramatic happened — flash at this point. */
  'fx:pulse': { at: [number, number, number]; color?: number; radius?: number }
  'merge:start': { node: number; table: number; reason: MergeReason }
  'merge:end': { node: number; table: number; rows: number }
  'ttl:drop': { node: number; table: number; rows: number }
  'ui:layout': Record<string, never>
}

export type BusHandler<K extends keyof BusEvents> = (payload: BusEvents[K]) => void

export interface Bus {
  on<K extends keyof BusEvents>(type: K, fn: BusHandler<K>): () => void
  once<K extends keyof BusEvents>(type: K, fn: BusHandler<K>): () => void
  off<K extends keyof BusEvents>(type: K, fn: BusHandler<K>): void
  emit<K extends keyof BusEvents>(type: K, payload: BusEvents[K]): void
}

/* ---------------------------------------------------------------------------
 * World modules and the component registry.
 * -------------------------------------------------------------------------*/

export type DistrictId =
  | 'clients'
  // No 'distributed'. The `Distributed` table is not a district — it is a table
  // on every server, and its components belong to the island they stand on.
  | 'nodes'
  | 'storage'
  | 'merges'
  | 'ttl'
  | 'replication'
  | 'keeper'
  | 'world'

export type ComponentKind =
  | 'process' // a thread or a background pool
  | 'memory' // a cache or a buffer
  | 'storage' // on-disk
  | 'network'
  | 'client'
  | 'concept' // an idea, not a thing

export interface FocusSpec {
  /** World-space point the camera should look at. */
  target: [number, number, number]
  distance: number
  /** Direction FROM target TO camera. Need not be normalised. */
  dir?: [number, number, number]
}

export interface ComponentDef {
  id: string
  name: string
  /** One-line subtitle, e.g. "background merge pool". */
  role: string
  kind: ComponentKind
  district: DistrictId
  /** Pickable root. Raycasting uses its descendants. */
  object: THREE.Object3D
  focus: FocusSpec
  /** World position for the floating label; defaults to focus.target. */
  labelAt?: [number, number, number]
  /**
   * 0 = district-scale, always visible
   * 1 = major landmark, visible from medium range
   * 2 = detail, only visible up close
   */
  tier: 0 | 1 | 2
  /** Live one-line metric for the label and panel header. */
  readout?: (s: SimState) => string
  color?: number
}

export interface QualitySettings {
  level: QualityLevel
  pixelRatio: number
  bloom: boolean
  shadows: boolean
  maxParticles: number
  maxLabels: number
  antialias: boolean
}

export interface WorldContext {
  scene: THREE.Scene
  camera: THREE.PerspectiveCamera
  bus: Bus
  sim: SimState
  quality: QualitySettings
  register(def: ComponentDef): void
  flow(req: FlowRequest): void
  theme: ThemeApi
}

export interface WorldModule {
  id: string
  group: THREE.Object3D
  /**
   * @param dt   frame delta in real seconds
   * @param sim  live simulation state
   * @param t    simulated time in seconds
   */
  update(dt: number, sim: SimState, t: number): void
  /** Distance-based detail switch, called when the bucket changes. */
  setDetail?(level: 0 | 1 | 2): void
  dispose?(): void
}

export type WorldFactory = (ctx: WorldContext) => WorldModule

/* ---------------------------------------------------------------------------
 * Theme API (implemented in core/theme.ts).
 * -------------------------------------------------------------------------*/

export interface ThemeApi {
  color: Record<ColorKey, number>
  mat(key: string, opts?: MatOpts): THREE.MeshStandardMaterial
  neon(color: number, intensity?: number, opts?: NeonOpts): THREE.MeshBasicMaterial
  line(color: number, opacity?: number): THREE.LineBasicMaterial
  edges(geo: THREE.BufferGeometry, color: number, opacity?: number): THREE.LineSegments
  textTexture(text: string, opts?: TextTexOpts): THREE.Texture
  box(w: number, h: number, d: number): THREE.BoxGeometry
  cyl(rt: number, rb: number, h: number, seg?: number): THREE.CylinderGeometry
  dispose(): void
}

export interface MatOpts {
  color?: number
  roughness?: number
  metalness?: number
  emissive?: number
  emissiveIntensity?: number
  transparent?: boolean
  opacity?: number
  flatShading?: boolean
  side?: THREE.Side
  depthWrite?: boolean
}

export interface NeonOpts {
  transparent?: boolean
  opacity?: number
  depthWrite?: boolean
}

export interface TextTexOpts {
  size?: number
  color?: string
  bg?: string
  font?: string
  padding?: number
  align?: CanvasTextAlign
  letterSpacing?: string
}

export type ColorKey =
  | 'bg'
  | 'fog'
  | 'grid'
  | 'gridBright'
  | 'ground'
  | 'client'
  | 'distributed'
  | 'node'
  | 'partActive'
  | 'partOutdated'
  | 'partPreactive'
  | 'partTemporary'
  | 'partExpired'
  | 'primaryIndex'
  | 'skipIndex'
  | 'markCache'
  | 'blockCache'
  | 'reader'
  | 'merge'
  | 'mutation'
  | 'ttl'
  | 'replication'
  | 'fetch'
  | 'keeper'
  | 'hot'
  | 'cold'
  | 'ok'
  | 'warn'
  | 'crit'
  | 'ink'
  | 'inkDim'

/* ---------------------------------------------------------------------------
 * Camera.
 * -------------------------------------------------------------------------*/

export type CameraMode = 'orbit' | 'fly' | 'focus' | 'tour'

export interface CameraApi {
  camera: THREE.PerspectiveCamera
  mode: CameraMode
  setMode(m: CameraMode): void
  focusOn(spec: FocusSpec, opts?: { instant?: boolean; duration?: number }): void
  flyPath(points: [number, number, number][], lookAt: [number, number, number][], duration: number): Promise<void>
  /** Cancel any scripted movement, hand control back to the user. */
  release(): void
  update(dt: number): void
  /** Distance from the cluster centre, used for LOD. */
  readonly altitude: number
  readonly scripted: boolean
  resize(w: number, h: number): void
  dispose(): void
}

/* ---------------------------------------------------------------------------
 * Routes — the road network. Defined in world/layout.ts, drawn by engine/flows.
 * -------------------------------------------------------------------------*/

export interface RouteDef {
  id: string
  /** Control points, world space. */
  points: [number, number, number][]
  color: number
  /** Default world units/sec. */
  speed: number
  size?: number
  /** Draw a faint static road line for this route. */
  visible?: boolean
  roadOpacity?: number
  tension?: number
}

/* ---------------------------------------------------------------------------
 * Inspector content (src/ui/content.ts).
 * -------------------------------------------------------------------------*/

export interface ContentSection {
  heading: string
  /** Supports a tiny subset of markdown: **bold**, `code`, [link](url). */
  body: string
}

/**
 * One external pointer for the inspector's "Go deeper" block.
 *
 * `url` is OPTIONAL on purpose: some references have no canonical public page,
 * and a guessed link is a fabricated citation.
 */
export interface DocRef {
  label: string
  url?: string
  /** For source refs: the class or function worth looking for in that file. */
  symbol?: string
}

export interface DocReferences {
  /** clickhouse.com/docs — the manual. */
  docs?: DocRef[]
  /** github.com/ClickHouse/ClickHouse — the source. */
  source?: DocRef[]
  /** System tables that show the same thing live on a real server. */
  systemTables?: DocRef[]
}

export interface ComponentDoc {
  id: string
  title: string
  subtitle: string
  /** One sentence: what it is. */
  tldr: string
  sections: ContentSection[]
  metrics?: { label: string; get: (s: SimState) => string; hint?: string }[]
  /** Related settings the user can twiddle right there. */
  knobs?: (keyof Knobs)[]
  /** Ids of related components, rendered as jump links. */
  see?: string[]
  refs?: DocReferences
}

export interface TourChapter {
  id: string
  title: string
  body: string
  focus?: string
  camera?: FocusSpec
  /** Wall-clock seconds this chapter lasts. */
  duration: number
  knobs?: Partial<Knobs>
  scenario?: string | null
}

export interface ScenarioDef {
  id: string
  name: string
  blurb: string
  icon: string
  knobs: Partial<Knobs>
  focus?: string
  /** Scenario seconds at 1×; 0 = runs until cancelled. */
  duration: number
  /** Narration beats: [atSecond, title, body]. */
  beats?: [number, string, string][]
}
