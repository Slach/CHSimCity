import {
  MARK_CACHE_MAX_MIB,
  MARK_CACHE_MIN_MIB,
  N_READ_THREADS,
  UNCOMPRESSED_CACHE_MAX_MIB,
  UNCOMPRESSED_CACHE_MIN_MIB,
} from '../core/types'
import type { ComponentDoc, Knobs } from '../core/types'
import { fmtBytes, fmtNum } from '../core/util'
import { DOCS } from './docs'

/* ============================================================================
 * Doc resolution and knob metadata.
 *
 * There is one doc per MECHANISM, not one per instance: `node.2.yard` and
 * `node.0.yard` resolve to the same `node.yard` write-up, and the metrics in it
 * read node 0. That is a deliberate simplification and the only one — a
 * per-node doc would be four copies of the same prose that could drift apart.
 * ==========================================================================*/

const byId = new Map<string, ComponentDoc>(DOCS.map((d) => [d.id, d]))

/** `node.<n>.<part>` → `node.<part>`; `keeper.<n>` → `keeper.ensemble`. */
const NODE_INSTANCE = /^node\.(\d+)\.(.+)$/
const NODE_ROOT = /^node\.(\d+)$/
const KEEPER_INSTANCE = /^keeper\.(\d+)$/

export function doc(id: string | null | undefined): ComponentDoc | undefined {
  if (!id) return undefined
  const hit = byId.get(id)
  if (hit) return hit
  const inst = NODE_INSTANCE.exec(id)
  if (inst) return byId.get(`node.${inst[2]}`)
  if (NODE_ROOT.test(id)) return byId.get('node')
  if (KEEPER_INSTANCE.test(id)) return byId.get('keeper.ensemble')
  return undefined
}

export function hasDoc(id: string | null | undefined): boolean {
  return !!doc(id)
}

/* ---------------------------------------------------------------------------
 * Knob metadata — how each dial is rendered, what setting it stands for, and
 * what it teaches. The console and the inspector both read this.
 * -------------------------------------------------------------------------*/

export type KnobGroup = 'workload' | 'insert' | 'read' | 'cache' | 'merge' | 'ttl' | 'replication' | 'chaos' | 'sim'

export interface KnobMeta {
  key: keyof Knobs
  label: string
  /** The real ClickHouse setting, if there is one. */
  setting?: string
  group: KnobGroup
  kind: 'range' | 'logrange' | 'toggle' | 'select'
  min?: number
  max?: number
  step?: number
  options?: { value: string; label: string }[]
  unit?: string
  /** One line: what moving this actually does inside the engine. */
  hint: string
  /** Format the current value for display. */
  fmt?: (v: never) => string
  /** Flag the settings that lose data or wake people up. */
  danger?: boolean
}

export const KNOB_GROUPS: { id: KnobGroup; label: string; hint: string }[] = [
  { id: 'workload', label: 'Workload', hint: 'What the application is asking for' },
  { id: 'insert', label: 'The write path', hint: 'How rows become parts' },
  { id: 'read', label: 'The read path', hint: 'How a query finds them again' },
  { id: 'cache', label: 'Caches', hint: 'What stays in memory' },
  { id: 'merge', label: 'Merges', hint: 'Keeping the part count finite' },
  { id: 'ttl', label: 'TTL and tiers', hint: 'Getting rid of data, or moving it' },
  { id: 'replication', label: 'Replication', hint: 'Keeper, queues and replicas' },
  { id: 'chaos', label: 'Break something', hint: 'The failure modes worth recognising' },
  { id: 'sim', label: 'Playback', hint: 'Simulation controls' },
]

function fmtMib(mib: number): string {
  if (mib <= 0) return 'disabled'
  return fmtBytes(mib * 1024 * 1024, mib >= 1024 ? 1 : 0)
}

export const KNOB_META: KnobMeta[] = [
  /* --- workload --------------------------------------------------------- */
  {
    key: 'insertsPerSec',
    label: 'INSERT statements / s',
    group: 'workload',
    kind: 'logrange',
    min: 0.2,
    max: 200,
    step: 0.1,
    unit: '/s',
    hint: 'How often the application inserts. Together with the batch size, this decides how many parts a second you create.',
  },
  {
    key: 'insertBlockRows',
    label: 'Rows per INSERT',
    group: 'workload',
    kind: 'logrange',
    min: 100,
    max: 2_000_000,
    step: 100,
    fmt: (v: never) => fmtNum(v as unknown as number),
    hint: 'The single most important number a ClickHouse client controls. Below a few thousand rows you are manufacturing parts faster than any merge pool can consolidate them.',
  },
  {
    key: 'selectsPerSec',
    label: 'SELECT statements / s',
    group: 'workload',
    kind: 'logrange',
    min: 0.2,
    max: 100,
    step: 0.1,
    unit: '/s',
    hint: 'How often the application reads. Each one fans out to one replica per shard.',
  },

  /* --- the write path --------------------------------------------------- */
  {
    key: 'asyncInsert',
    label: 'async_insert',
    setting: 'async_insert',
    group: 'insert',
    kind: 'toggle',
    hint: 'Batch small INSERTs inside the server and write one part per flush. The correct answer to "many small INSERTs" when you cannot change the client.',
  },
  {
    key: 'asyncInsertMaxDataKib',
    label: 'async_insert_max_data_size',
    setting: 'async_insert_max_data_size',
    group: 'insert',
    kind: 'logrange',
    min: 64,
    max: 65536,
    step: 64,
    fmt: (v: never) => fmtBytes((v as unknown as number) * 1024, 0),
    hint: 'Flush the async buffer once it holds this much. Whichever of this and the busy timeout comes first wins.',
  },
  {
    key: 'asyncInsertBusyTimeoutMs',
    label: 'async_insert_busy_timeout_ms',
    setting: 'async_insert_busy_timeout_ms',
    group: 'insert',
    kind: 'range',
    min: 50,
    max: 5000,
    step: 50,
    unit: 'ms',
    hint: 'Flush the async buffer after this long even if it is not full. This is the latency you are trading for a lower part count.',
  },
  {
    key: 'waitForAsyncInsert',
    label: 'wait_for_async_insert',
    setting: 'wait_for_async_insert',
    group: 'insert',
    kind: 'toggle',
    hint: 'Does the client wait for the flush? On, and durability is unchanged and only latency moved. Off, and the INSERT returns before the data is on disk anywhere.',
    danger: true,
  },
  {
    key: 'distributedInsert',
    label: 'distributed_foreground_insert',
    setting: 'distributed_foreground_insert',
    group: 'insert',
    kind: 'select',
    options: [
      { value: 'background', label: 'background — spool on the initiator' },
      { value: 'foreground', label: 'foreground — wait for every shard' },
    ],
    hint: 'In background mode the INSERT returns once the block is on the INITIATOR’s disk. If the initiator dies, that data dies with it.',
    danger: true,
  },
  {
    key: 'insertQuorum',
    label: 'insert_quorum',
    setting: 'insert_quorum',
    group: 'insert',
    kind: 'select',
    options: [
      { value: 'none', label: '0 — no quorum (default)' },
      { value: 'one', label: '1 — one replica' },
      { value: 'majority', label: 'auto — a majority' },
      { value: 'all', label: 'all replicas' },
    ],
    hint: 'How many replicas must confirm a write before the INSERT returns. Higher is safer and slower, and it makes a replica loss a write outage rather than a non-event.',
  },
  {
    key: 'partsToDelayInsert',
    label: 'parts_to_delay_insert',
    setting: 'parts_to_delay_insert',
    group: 'insert',
    kind: 'range',
    min: 20,
    max: 600,
    step: 10,
    unit: 'parts',
    hint: 'Past this many active parts the server sleeps before each INSERT, on purpose, to give the merges room. The delay is what you see in production long before any error.',
  },
  {
    key: 'partsToThrowInsert',
    label: 'parts_to_throw_insert',
    setting: 'parts_to_throw_insert',
    group: 'insert',
    kind: 'range',
    min: 50,
    max: 1200,
    step: 10,
    unit: 'parts',
    hint: 'Past this the INSERT is refused with Code: 252. Raising it is never the fix — batching is.',
    danger: true,
  },

  /* --- the read path ---------------------------------------------------- */
  {
    key: 'primaryKeyHitRatio',
    label: 'Queries that match the sorting key',
    group: 'read',
    kind: 'range',
    min: 0,
    max: 1,
    step: 0.01,
    unit: '%',
    hint: 'Share of SELECTs whose WHERE constrains a PREFIX of the ORDER BY. At zero the primary index does nothing at all and every granule is read.',
  },
  {
    key: 'skipIndexUseRatio',
    label: 'Queries that use a skip index',
    group: 'read',
    kind: 'range',
    min: 0,
    max: 1,
    step: 0.01,
    unit: '%',
    hint: 'Share of SELECTs that filter on a column a data skipping index covers. Watch how differently the three indexes in this model perform.',
  },
  {
    key: 'partitionPruneRatio',
    label: 'Queries restricted to one partition',
    group: 'read',
    kind: 'range',
    min: 0,
    max: 1,
    step: 0.01,
    unit: '%',
    hint: 'Partition pruning is the cheapest pruning there is: whole partitions are discarded without opening a file.',
  },
  {
    key: 'maxThreads',
    label: 'max_threads',
    setting: 'max_threads',
    group: 'read',
    kind: 'range',
    min: 1,
    max: N_READ_THREADS,
    step: 1,
    unit: 'threads',
    hint: 'Reader threads one query may use per node. It raises memory as well as speed — one hash table per thread on an aggregation.',
  },
  {
    key: 'parallelReplicas',
    label: 'parallel_replicas',
    setting: 'allow_experimental_parallel_reading_from_replicas',
    group: 'read',
    kind: 'toggle',
    hint: 'Split ONE shard’s mark ranges across its replicas, so both read a share instead of one reading all of it. The only setting here that changes how much work a shard does.',
  },
  {
    key: 'clientBalancing',
    label: 'client connects to',
    // Deliberately no `setting`: this is not a ClickHouse setting. It is the
    // driver's configuration — or the load balancer in front of the cluster —
    // and it is what decides which server initiates each statement.
    group: 'read',
    kind: 'select',
    options: [
      { value: 'round_robin', label: 'every server in turn' },
      { value: 'random', label: 'a random server' },
      { value: 'single', label: 'one server — one hostname' },
    ],
    hint: 'Which server the application opens a connection to. That server becomes the initiator: it fans the statement out to the shards and merges what comes back. One hostname in a connection string makes one machine do all of that for the whole cluster, with the data distributed exactly the same.',
  },
  {
    key: 'loadBalancing',
    label: 'load_balancing',
    setting: 'load_balancing',
    group: 'read',
    kind: 'select',
    options: [
      { value: 'random', label: 'random — the default' },
      { value: 'nearest_hostname', label: 'nearest_hostname — deterministic' },
      { value: 'in_order', label: 'in_order — always the first' },
      { value: 'round_robin', label: 'round_robin' },
    ],
    hint: 'Which replica of each shard answers a distributed SELECT. With random, a replica lagging by an hour is chosen just as often as a current one.',
  },

  /* --- caches ----------------------------------------------------------- */
  {
    key: 'markCacheMib',
    label: 'mark_cache_size',
    setting: 'mark_cache_size',
    group: 'cache',
    kind: 'logrange',
    min: MARK_CACHE_MIN_MIB,
    max: MARK_CACHE_MAX_MIB,
    step: 32,
    fmt: (v: never) => fmtMib(v as unknown as number),
    hint: '.mrk3 offsets. A reader cannot seek without the mark, so a miss is a real disk seek PER STREAM. The cache nobody sizes.',
  },
  {
    key: 'uncompressedCacheMib',
    label: 'uncompressed_cache_size',
    setting: 'uncompressed_cache_size',
    group: 'cache',
    kind: 'range',
    min: UNCOMPRESSED_CACHE_MIN_MIB,
    max: UNCOMPRESSED_CACHE_MAX_MIB,
    step: 256,
    fmt: (v: never) => fmtMib(v as unknown as number),
    hint: 'Decompressed blocks. Zero by default, and usually correctly: on an analytical scan it is pure eviction churn.',
  },

  /* --- merges ----------------------------------------------------------- */
  {
    key: 'mergePoolSize',
    label: 'background_pool_size',
    setting: 'background_pool_size',
    group: 'merge',
    kind: 'range',
    min: 1,
    max: 4,
    step: 1,
    unit: 'slots',
    hint: 'Concurrent merges per node — shared with mutations and TTL merges. Drop it to two and watch the part count climb.',
  },
  {
    key: 'maxBytesToMergeGib',
    label: 'max_bytes_to_merge_at_max_space_in_pool',
    setting: 'max_bytes_to_merge_at_max_space_in_pool',
    group: 'merge',
    kind: 'logrange',
    min: 1,
    max: 300,
    step: 1,
    unit: 'GiB',
    hint: 'A merge whose inputs exceed this is refused, which is why very large parts stop merging and a mature partition settles at a few big parts rather than one.',
  },

  /* --- TTL -------------------------------------------------------------- */
  {
    key: 'ttlEnabled',
    label: 'TTL enforced',
    group: 'ttl',
    kind: 'toggle',
    hint: 'Turn it off and expired rows accumulate until you turn it back on. TTL is a background merge, not a delete.',
    danger: true,
  },
  {
    key: 'ttlMoveToCold',
    label: 'TTL … TO VOLUME instead of DELETE',
    group: 'ttl',
    kind: 'toggle',
    hint: 'Move expired parts to the cold volume rather than emptying them. Same machinery, different action, and a much smaller bill.',
  },
  {
    key: 'mergeWithTtlTimeout',
    label: 'merge_with_ttl_timeout',
    setting: 'merge_with_ttl_timeout',
    group: 'ttl',
    kind: 'range',
    min: 4,
    max: 300,
    step: 2,
    unit: 's',
    hint: 'Minimum gap between TTL merges of the same part. The real default is 14400 s; this model ships 20 s so the works are not idle for a whole visit.',
  },

  /* --- replication ------------------------------------------------------ */
  {
    key: 'keeperConnected',
    label: 'Keeper reachable',
    group: 'replication',
    kind: 'toggle',
    hint: 'Without a Keeper session a ReplicatedMergeTree cannot allocate a block number, so it goes READ-ONLY. Reads keep working, which is why this takes a while to be recognised as an outage.',
    danger: true,
  },
  {
    key: 'networkLatencyMs',
    label: 'Network latency',
    group: 'replication',
    kind: 'range',
    min: 1,
    max: 300,
    step: 1,
    unit: 'ms',
    hint: 'One-way delay to Keeper and to the sibling replica. It is the floor under every fetch and under insert_quorum.',
  },
  {
    key: 'slowReplica',
    label: 'One replica cannot keep up',
    group: 'replication',
    kind: 'toggle',
    hint: 'Its queue grows and absolute_delay climbs — and with load_balancing = random, half your reads still go to it.',
    danger: true,
  },

  /* --- chaos ------------------------------------------------------------ */
  {
    key: 'nodeDown',
    label: 'A replica is offline',
    group: 'chaos',
    kind: 'toggle',
    hint: 'Its shard survives on the sibling and nothing visibly breaks, which is exactly the danger. The dead replica’s queue grows the whole time.',
    danger: true,
  },
  {
    key: 'runningMutation',
    label: 'ALTER … UPDATE in flight',
    group: 'chaos',
    kind: 'toggle',
    hint: 'It rewrites whole parts using the same background pool the merges need. Watch the part count climb with nothing else changed.',
    danger: true,
  },

  /* --- playback --------------------------------------------------------- */
  {
    key: 'timeScale',
    label: 'Speed',
    group: 'sim',
    kind: 'range',
    min: 0.1,
    max: 5,
    step: 0.1,
    unit: '×',
    hint: 'Simulation speed. Slow it down to watch one part being committed; speed it up to watch a TTL cycle.',
  },
  {
    key: 'paused',
    label: 'Pause',
    group: 'sim',
    kind: 'toggle',
    hint: 'Freeze the cluster mid-flight and fly around it.',
  },
]

const knobById = new Map<string, KnobMeta>(KNOB_META.map((k) => [k.key as string, k]))

export function knobMeta(key: keyof Knobs): KnobMeta | undefined {
  return knobById.get(key as string)
}

export function knobsInGroup(group: KnobGroup): KnobMeta[] {
  return KNOB_META.filter((k) => k.group === group)
}

/* ---------------------------------------------------------------------------
 * Tiny markdown: **bold**, `code`, *em*, [text](url). Escapes HTML first, so it
 * is safe to feed it doc strings.
 * -------------------------------------------------------------------------*/

export function mdToHtml(src: string): string {
  const esc = src.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  return esc
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>')
    .replace(/\[([^\]]+)\]\((https?:[^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>')
    .replace(/\n\n/g, '<br><br>')
}

export { DOCS }
