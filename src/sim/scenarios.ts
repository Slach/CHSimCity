import type { ScenarioDef } from '../core/types'

/** How long one narration card stays up before the next beat replaces it. */
export const SCENARIO_NARRATION_SECONDS = 11

/* ============================================================================
 * SCENARIOS — the failure modes and tuning lessons worth recognising.
 *
 * Each one is a set of settings plus a narration script. They are not demos:
 * every scenario here is an incident somebody has actually had, and the beats
 * say what to look at while it happens.
 * ==========================================================================*/

export const SCENARIOS: ScenarioDef[] = [
  {
    id: 'too-many-parts',
    name: 'Too many parts',
    blurb:
      'A thousand tiny INSERTs a second. The merge pool cannot keep up, INSERTs start being delayed, and then they start failing.',
    icon: 'parts',
    knobs: {
      insertsPerSec: 40,
      insertBlockRows: 900,
      asyncInsert: false,
      mergePoolSize: 2,
      selectsPerSec: 4,
    },
    focus: 'node.0.yard',
    duration: 130,
    beats: [
      [
        0,
        'Forty INSERTs a second, nine hundred rows each',
        'This is what an application does when it inserts one event at a time and somebody puts a small batch in front of it. Watch the parts yard on any node: every INSERT makes at least one part per partition it touches, and they are all level 0.',
      ],
      [
        20,
        'The merge pool is the bottleneck, not the disk',
        'Two merge slots, and each merge has to read and rewrite everything it touches. The selector is doing the right thing — it prefers uniform ranges — but there is simply more arriving than four threads can consolidate.',
      ],
      [
        44,
        'parts_to_delay_insert: ClickHouse slows you down first',
        'At 150 active parts the server starts sleeping before each INSERT, deliberately, to give the merges room. This is the part you see in production long before an error: p99 insert latency climbing while nothing has failed.',
      ],
      [
        70,
        'parts_to_throw_insert: and then it gives up',
        'At 300 the INSERT is refused with `Code: 252. Too many parts`. The fix is never to raise the threshold — it is to insert in larger batches, or to turn on `async_insert` and let the server do the batching for you.',
      ],
      [
        100,
        'Every part is also a Keeper cost',
        'Look south. Each part is two znodes per replica in Keeper, plus a log entry. "Too many parts" is a Keeper memory incident as well as a merge one, and that is the half people are surprised by.',
      ],
    ],
  },
  {
    id: 'async-insert',
    name: 'async_insert rescues it',
    blurb:
      'The same punishing insert pattern, with async_insert on. The server batches in memory and the part count collapses.',
    icon: 'async',
    knobs: {
      insertsPerSec: 40,
      insertBlockRows: 900,
      asyncInsert: true,
      asyncInsertMaxDataKib: 2048,
      asyncInsertBusyTimeoutMs: 400,
      mergePoolSize: 2,
    },
    focus: 'node.0.insertdock',
    duration: 100,
    beats: [
      [
        0,
        'Same load, one setting different',
        'Forty INSERTs a second again, and the merge pool is still only two slots wide. The difference is that the rows now land in a buffer inside the server rather than becoming a part each.',
      ],
      [
        22,
        'One part instead of forty',
        'The buffer flushes when it reaches `async_insert_max_data_size` or when `async_insert_busy_timeout_ms` elapses, whichever comes first. Watch the yard: level-0 parts are arriving at a fraction of the rate, and each one is far larger.',
      ],
      [
        48,
        'What you traded away',
        'With `wait_for_async_insert = 1` the client still waits for the flush, so durability is unchanged and only latency moved. Turn that off and the INSERT returns before the data is on disk anywhere — which is a real trade, not a free one.',
      ],
      [
        74,
        'This is the answer, not a bigger threshold',
        'Batching is the fix for "too many parts" in every case. `async_insert` is the server-side version of it, for when you cannot change the client.',
      ],
    ],
  },
  {
    id: 'primary-key-miss',
    name: 'The ORDER BY does not match the query',
    blurb:
      'Every SELECT filters on a column that is not a sorting-key prefix. The primary index cannot help, so every granule of every selected partition is read.',
    icon: 'index',
    knobs: {
      selectsPerSec: 10,
      primaryKeyHitRatio: 0,
      skipIndexUseRatio: 0,
      partitionPruneRatio: 0.2,
      insertsPerSec: 2,
    },
    focus: 'node.0.primaryindex',
    duration: 105,
    beats: [
      [
        0,
        'A full scan of every selected partition',
        'The primary index holds one key value per 8192-row granule. A WHERE that does not constrain a key PREFIX gives the binary search nothing to bite on, so every granule survives and every one has to be read.',
      ],
      [
        22,
        'granules_total = granules_after_key',
        'Open the read pool on any node and compare the three numbers. When the second equals the first, the primary index did no work at all — and that is a schema problem, not a tuning one.',
      ],
      [
        46,
        'The index is sparse, and that is deliberate',
        'primary.cidx is tiny enough to stay in RAM forever precisely because it indexes granules and not rows. It can never find a row for you. It can only tell you which 8192-row block a row must be in.',
      ],
      [
        70,
        'Turn the primary-key hit ratio back up',
        'Drag `Primary key hit ratio` in the console and watch `granules_after_key` collapse by three orders of magnitude. Nothing about the data changed — only whether the query named the key.',
      ],
    ],
  },
  {
    id: 'skip-index',
    name: 'Skip indexes earn their keep',
    blurb:
      'Every SELECT uses a data-skipping index. Watch how much a correlated minmax prunes, and how little an overflowed set does.',
    icon: 'skip',
    knobs: {
      selectsPerSec: 9,
      primaryKeyHitRatio: 0.5,
      skipIndexUseRatio: 1,
      partitionPruneRatio: 0.5,
      insertsPerSec: 2,
    },
    focus: 'node.0.skipindexes',
    duration: 95,
    beats: [
      [
        0,
        'They only ever remove work',
        'A skip index cannot make a query more precise. It reads a small summary per block of granules and, if that summary proves the block cannot match, the block is never opened. That is the whole mechanism.',
      ],
      [
        22,
        'A minmax on a correlated column is nearly free',
        '`idx_event_time` is a minmax on `EventTime`, and `EventDate` is in the sorting key — so the parts are already nearly sorted by it and each block has a tight range. It prunes about 88% of blocks for a few kilobytes of index.',
      ],
      [
        46,
        'A set() that overflowed prunes almost nothing',
        '`idx_region` is a `set(100)` on a 200-value column. Once the set overflows, every block reports "could match" and the index is pure overhead — index bytes to write, index bytes to read, and no pruning at all.',
      ],
      [
        70,
        'Granularity is the resolution limit',
        'A `GRANULARITY 4` index decides four granules at a time, so even a perfectly selective predicate still reads four granules where one would do. That is the price of the index being small.',
      ],
    ],
  },
  {
    id: 'mark-cache-cold',
    name: 'The mark cache is too small',
    blurb:
      'Shrink mark_cache_size until the working set no longer fits. Every reader then pays a disk seek per stream before it can read anything.',
    icon: 'cache',
    knobs: {
      markCacheMib: 32,
      selectsPerSec: 12,
      insertsPerSec: 3,
      primaryKeyHitRatio: 0.6,
    },
    focus: 'node.0.markcache',
    duration: 95,
    beats: [
      [
        0,
        'Thirty-two mebibytes of mark cache',
        'A mark is where in the `.bin` a granule starts, and how far into the decompressed block. A wide table has hundreds of streams, so its mark set runs to gigabytes — and a reader cannot seek without the mark first.',
      ],
      [
        22,
        'A miss is a seek per stream',
        'Watch the reader bays. The seeking phase, which is almost invisible on a warm cache, now dominates every task. Nothing about the data volume changed; only whether the offsets were resident.',
      ],
      [
        46,
        'This is the cache nobody sizes',
        '`mark_cache_size` defaults to 5 GiB and is usually left there. On a server with hundreds of wide tables that is not enough, and the symptom is high IOPS with low throughput — lots of tiny reads.',
      ],
      [
        70,
        'Put it back',
        'Drag `mark_cache_size` up and watch the hit ratio recover and the seek phase disappear. Then look at the node memory readout: the cache is a fixed reservation, and it comes out of the same budget as your merges.',
      ],
    ],
  },
  {
    id: 'ttl-expiry',
    name: 'TTL has to rewrite the part',
    blurb:
      'The metrics table has a two-minute TTL. Watch what removing a row actually costs, and why ttl_only_drop_parts exists.',
    icon: 'ttl',
    knobs: {
      insertsPerSec: 10,
      insertBlockRows: 40000,
      ttlEnabled: true,
      mergeWithTtlTimeout: 8,
      selectsPerSec: 3,
    },
    focus: 'node.0.ttl',
    duration: 120,
    beats: [
      [
        0,
        'A part is a directory, so a row cannot be deleted',
        'TTL does not delete rows. It schedules a MERGE whose input is one part and whose output is the same part without the expired rows. Every surviving row is read, sorted and rewritten to remove the dead ones.',
      ],
      [
        24,
        'rows_written < rows_read',
        'Open system.merges on a node. A TTL merge is the only kind whose output has fewer rows than its input, and that inequality is how you spot one in `system.part_log` after the fact.',
      ],
      [
        50,
        'A wholly-expired part is free',
        'When every row in a part is past its TTL there is nothing to keep, so with `ttl_only_drop_parts` ClickHouse deletes the directory instead of rewriting it. One rmdir instead of a full rewrite.',
      ],
      [
        76,
        'Which is why the partition key should match the TTL',
        'Partition by the same time granularity your TTL uses and every expiry becomes a wholly-expired partition — a drop, not a rewrite. Partition by something else and you pay a full rewrite of live data every time.',
      ],
      [
        100,
        'merge_with_ttl_timeout is the throttle',
        'Without it a large part whose rows are slowly expiring would be rewritten over and over. The timeout is the minimum gap between TTL merges of the same part, and the default is four hours.',
      ],
    ],
  },
  {
    id: 'vertical-merge',
    name: 'Horizontal vs vertical merge',
    blurb:
      'Watch the memory a merge holds on a wide table, and what the vertical algorithm does about it.',
    icon: 'merge',
    knobs: {
      insertsPerSec: 12,
      insertBlockRows: 250000,
      mergePoolSize: 4,
      selectsPerSec: 2,
    },
    focus: 'node.0.merges',
    duration: 100,
    beats: [
      [
        0,
        'A horizontal merge reads every column at once',
        'One read buffer per stream per input part. On `hits`, with a Map, a LowCardinality and three long Strings, that is fifteen streams — times the number of parts being merged.',
      ],
      [
        24,
        'A vertical merge reads the key columns first',
        'It merges only the sorting-key columns, records the row permutation that produced the result, and then applies that permutation one payload column at a time. Peak memory stops depending on how wide the table is.',
      ],
      [
        50,
        'Read the algorithm off the gantry',
        'Each running merge reports its algorithm and its memory_usage. Compare a `hits` merge — twelve columns and fifteen streams, so it goes vertical — with a `metrics` merge, which is four narrow columns and stays horizontal because the second pass would be pure overhead. `sessions` stays horizontal too: the threshold counts columns, and it has only four even though one is a JSON.',
      ],
      [
        74,
        'This is why wide-table merges OOM',
        '`MEMORY_LIMIT_EXCEEDED` during a merge on a table with hundreds of columns is almost always a horizontal merge that should have been vertical. `enable_vertical_merge_algorithm` is on by default for exactly that reason.',
      ],
    ],
  },
  {
    id: 'replica-lag',
    name: 'One replica falls behind',
    blurb:
      'A slow replica cannot execute its queue fast enough. Watch absolute_delay climb and the queue fill.',
    icon: 'replica',
    knobs: {
      slowReplica: true,
      insertsPerSec: 14,
      insertBlockRows: 60000,
      selectsPerSec: 6,
    },
    focus: 'node.1.queue',
    duration: 115,
    beats: [
      [
        0,
        'Replication is a queue, not a stream',
        'Every INSERT on a replica writes one entry to Keeper. Every other replica of that shard copies the entry into its own queue and executes it — a fetch for a new part, or the merge itself for a merge.',
      ],
      [
        24,
        'absolute_delay is a time, not a byte count',
        'It is the age of the oldest entry this replica has not yet executed. That is the number worth alerting on, because it answers the only question that matters: how stale is a read from this replica?',
      ],
      [
        50,
        'A distributed SELECT can still hit it',
        'With the default `load_balancing = random`, half your reads go to the lagging replica and see older data. `max_replica_delay_for_distributed_queries` is what stops that, and it is not set by default.',
      ],
      [
        76,
        'The queue is what fills first',
        'Look at the queue slots. GET_PART entries pile up because the fetches cannot keep pace, and every queued entry is a znode Keeper is holding on this replica behind.',
      ],
      [
        98,
        'Merges are instructions, not results',
        'Notice that MERGE_PARTS entries make this replica do the merge itself rather than copy the merged part. That is why replication traffic does not grow with merge volume — and why a slow replica is slow at merging too.',
      ],
    ],
  },
  {
    id: 'keeper-down',
    name: 'Keeper goes away',
    blurb:
      'No Keeper session means no block numbers, which means every ReplicatedMergeTree table is read-only. Reads keep working.',
    icon: 'keeper',
    knobs: {
      keeperConnected: false,
      insertsPerSec: 8,
      selectsPerSec: 8,
    },
    focus: 'keeper.ensemble',
    duration: 90,
    beats: [
      [
        0,
        'The ensemble is unreachable',
        'Keeper holds no user data at all — only metadata. But a ReplicatedMergeTree INSERT has to allocate its block number from Keeper before it can write, so without a session there is nothing it can do.',
      ],
      [
        22,
        'Read-only, not down',
        '`Code: 242. Table is in readonly mode`. Every SELECT still works from the parts already on local disk, which is why a Keeper outage presents as "writes are failing" and takes a while to be recognised as an outage at all.',
      ],
      [
        46,
        'Merges stop too',
        'A replicated merge has to be announced to `/log` before it may run, so the merge pools go quiet and the part count starts climbing even though nothing is being inserted.',
      ],
      [
        68,
        'Turn it back on',
        'Flip `Keeper connected`. Each replica re-reads `/log` from its stored log_pointer, catches up on the entries it missed, and the queues drain. Nothing was lost — the entries were in Keeper the whole time.',
      ],
    ],
  },
  {
    id: 'mutation-storm',
    name: 'A mutation eats the merge pool',
    blurb:
      'ALTER … UPDATE rewrites whole parts using the same background pool the merges need. Watch the part count climb while it runs.',
    icon: 'mutation',
    knobs: {
      runningMutation: true,
      insertsPerSec: 14,
      insertBlockRows: 40000,
      mergePoolSize: 2,
    },
    focus: 'node.0.mutations',
    duration: 100,
    beats: [
      [
        0,
        'An UPDATE is a background job',
        'ALTER TABLE … UPDATE does not modify anything. It creates a mutation entry, and a background job rewrites every part that could contain a matching row into a new part with a `_<version>` suffix.',
      ],
      [
        24,
        'It uses the merge pool',
        'The same `background_pool_size` slots. So while the mutation runs, the merges that would have consolidated your level-0 parts are not running — and the part count climbs even though nothing changed about the insert rate.',
      ],
      [
        50,
        'Read the part names',
        '`20260701_1_9_2` becomes `20260701_1_9_2_43`. Same block range, same merge level, new mutation version. That trailing number is the only difference between the old rows and the new ones.',
      ],
      [
        74,
        'Which is why you batch them',
        'Ten separate ALTER UPDATEs rewrite every part ten times. One ALTER with ten SET clauses rewrites it once. `system.mutations` is where you find out which of the two you did.',
      ],
    ],
  },
  {
    id: 'node-loss',
    name: 'A replica disappears',
    blurb:
      'One node goes offline. Its shard survives on the sibling, and nothing visibly breaks — which is the danger.',
    icon: 'down',
    knobs: {
      nodeDown: true,
      insertsPerSec: 10,
      selectsPerSec: 10,
      loadBalancing: 'random',
    },
    focus: 'node.0.wheel',
    duration: 90,
    beats: [
      [
        0,
        'Shard 2 is down to one replica',
        'The Distributed table stops choosing the dead node, both for reads and for writes. No error reaches the client, no alert fires from the query path, and the cluster looks healthy.',
      ],
      [
        22,
        'The surviving replica takes all of it',
        'Twice the read load and all of the writes, and its merge pool is now the only one consolidating that shard. Watch its CPU and its part count against the other shard.',
      ],
      [
        46,
        'And its queue is growing on the dead one',
        'Keeper is still accepting log entries from the live replica. The dead one is simply not reading them, so when it comes back it has a queue to work through before it can serve a correct read.',
      ],
      [
        68,
        'Bring it back',
        'Turn `Node down` off. It restarts, re-reads `/log` from its stored pointer, fetches every part it missed, and rejoins. The fetches are replica-to-replica over HTTP — nothing large goes through Keeper.',
      ],
    ],
  },
  {
    id: 'cold-storage',
    name: 'TTL moves data to cold storage',
    blurb:
      'TTL … TO VOLUME instead of DELETE. Old parts move to S3, queries against them get six times slower, and the disk bill drops.',
    icon: 'tier',
    knobs: {
      ttlEnabled: true,
      ttlMoveToCold: true,
      mergeWithTtlTimeout: 10,
      insertsPerSec: 8,
      selectsPerSec: 6,
      partitionPruneRatio: 0.3,
    },
    focus: 'node.0.volumes',
    duration: 105,
    beats: [
      [
        0,
        'The same TTL machinery, a different action',
        'A TTL rule can DELETE the rows, RECOMPRESS them with a heavier codec, or MOVE the part to another volume. It is the same background job in every case — only what it does with the output differs.',
      ],
      [
        26,
        'Watch a part change volume',
        'Look under the island. The part is rewritten onto the cold volume and the hot one gets its space back. The part name does not change, because it is the same data at the same version.',
      ],
      [
        52,
        'And now it is six times slower to read',
        'Object storage has bandwidth but not IOPS. A query that touches a cold part pays for that, which is exactly why the TTL is written around the partition key: you want the cold parts to be the ones nobody queries.',
      ],
      [
        78,
        'The point is the bill, not the speed',
        'Twenty terabytes of cold storage costs a fraction of four hundred gigabytes of local SSD. `storage_policy` is a cost decision that happens to be expressible as a TTL rule.',
      ],
    ],
  },
]
