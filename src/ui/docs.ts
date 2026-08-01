import { INDEX_GRANULARITY, N_NODES, N_READ_THREADS } from '../core/types'
import type { ComponentDoc, NodeSim, SimState } from '../core/types'
import { N_TABLES, TABLES, streamCount } from '../world/layout'
import { fmtBytes, fmtNum } from '../core/util'

/* ============================================================================
 * THE KNOWLEDGE LAYER
 *
 * One doc per mechanism. Every claim here should be checkable against the
 * ClickHouse documentation or the source, and the `refs` block on each doc says
 * where. Where the model simplifies, the doc says so — a caption cannot correct
 * a misleading building, but it can at least admit to one.
 *
 * Per-node components (`node.2.yard`) resolve to their family doc (`node.yard`)
 * through `doc()` in content.ts, so there is one write-up per mechanism rather
 * than one per node.
 * ==========================================================================*/

const GRAN = fmtNum(INDEX_GRANULARITY)

/** Sum a per-node value across the cluster, counting one replica per shard. */
function acrossPrimaries(pick: (i: number) => number): number {
  let n = 0
  for (let i = 0; i < N_NODES; i += 2) n += pick(i)
  return n
}

/** Sum a per-node value across every server. */
function sumNodes(s: SimState, pick: (n: NodeSim) => number): number {
  let total = 0
  for (const n of s.nodes) total += pick(n)
  return total
}

/**
 * How the application's statements are spread over the servers, as the share
 * held by the busiest one. With a driver that knows the cluster this sits near
 * `1/N`; with one hostname in a connection string it is 100%.
 */
function statementShare(s: SimState): string {
  let total = 0
  let worst = 0
  for (const v of s.clients.sentToNode) {
    total += v
    if (v > worst) worst = v
  }
  if (total <= 0) return '—'
  return `${((worst / total) * 100).toFixed(0)}% on the busiest`
}

export const DOCS: ComponentDoc[] = [
  /* ======================================================================
   * The cluster as a whole
   * ====================================================================*/
  {
    id: 'cluster',
    title: 'CHSimCity',
    subtitle: 'a two-shard, two-replica ClickHouse cluster',
    tldr: 'Four data nodes, three Keeper nodes, one Distributed table in front of them.',
    sections: [
      {
        heading: 'What you are looking at',
        body: `Every structure here is one real mechanism inside ClickHouse, and the geography is the order things happen in.

North, outside the cluster, is the **application tier**. It talks to exactly one thing: the **Distributed** table on the initiator, which stores nothing and routes everything.

The four islands are the data nodes, standing in one row and paired: two islands close together are the two **replicas** of one shard, holding the same rows, and the wide channel between the pairs is the **shard boundary**. That channel is the only line in this cluster data never crosses — a part is fetched across the narrow gap and never across the wide one. A SELECT does cross it, but as a question, not as data.

Read one island west to east and you have read the whole of a \`MergeTree\`: a block arrives at the **insert dock**, is sorted and written as a **part**, joins the **parts yard**, is found again through the **primary index** and the **skip indexes**, is read by the **read pool**, and is eventually consolidated by the **merge gantry** or emptied by the **TTL works**.

South is the **Keeper quorum**. It holds no user data at all — only metadata — and every write in the cluster depends on it.`,
      },
      {
        heading: 'Colour is semantic and never decorative',
        body: `A part's colour **is** its \`system.parts.state\`, and nothing else in the cluster uses those five colours:

**green** active — the only state a SELECT can see. **grey** outdated — merged away, still on disk because a running query might be reading it. **pale blue** preactive — renamed into place, being committed. **violet** temporary — still \`tmp_insert_…\`, invisible to everybody. **pink** every row past its TTL.

Elsewhere: **amber** is a merge, **magenta** a mutation, **pink** the TTL, **orange** replication, **coral** a part crossing the wire between replicas, **violet** Keeper, **yellow** the primary index, **aqua** the skip indexes.`,
      },
      {
        heading: 'What this is not',
        body: `It is a *model*, not an emulator. Nothing here parses SQL and no byte of ClickHouse source code runs in your browser.

Three distortions are deliberate. **Time is stretched** for anything sub-second and **compressed** for anything measured in hours — the \`metrics\` table's TTL is two minutes rather than two weeks, because a TTL you cannot watch expire teaches nothing. **The cluster is a scale model**: four nodes, and at most 96 *visible* parts per table per node — the rest are simulated and counted but not drawn, so no total is ever understated. And **granules are counted, not simulated** — a query's cost is derived from how many index granules survive pruning, which is the arithmetic ClickHouse itself does, but the rows inside a granule are never materialised.`,
      },
    ],
    metrics: [
      { label: 'Active parts', get: (s) => fmtNum(s.stats.activeParts) },
      { label: 'Merges running', get: (s) => String(s.stats.runningMerges) },
      { label: 'Rows', get: (s) => fmtNum(s.stats.totalRows) },
      { label: 'On disk', get: (s) => fmtBytes(s.stats.totalBytesOnDisk) },
      { label: 'Compression', get: (s) => `${s.stats.compressionRatio.toFixed(1)}×` },
      { label: 'Mark cache', get: (s) => `${s.stats.markCacheHitPct.toFixed(1)}%` },
    ],
    knobs: ['insertsPerSec', 'insertBlockRows', 'selectsPerSec', 'timeScale'],
    see: ['node.dist', 'node.yard', 'node.merges', 'keeper.ensemble'],
    refs: {
      docs: [
        { label: 'ClickHouse — MergeTree engine', url: 'https://clickhouse.com/docs/engines/table-engines/mergetree-family/mergetree' },
        { label: 'ClickHouse — Distributed engine', url: 'https://clickhouse.com/docs/engines/table-engines/special/distributed' },
      ],
    },
  },

  /* ======================================================================
   * Clients
   * ====================================================================*/
  {
    id: 'clients',
    title: 'Application tier',
    subtitle: 'outside the cluster, and it only knows about one table',
    tldr: 'The client talks to a Distributed table and has no idea how many shards exist.',
    sections: [
      {
        heading: 'One connection, one table name',
        body: `This is the whole contract. The application writes \`INSERT INTO hits_dist\` and reads \`SELECT … FROM hits_dist\`, and the \`Distributed\` engine on the initiator turns each of those into as many remote statements as there are shards.

Adding a shard changes nothing here. That is the property the engine exists to provide, and it is why the road from this terminal stops at the initiator and never continues.`,
      },
      {
        heading: 'The batch size is the client’s most important decision',
        body: `The pallet stack on the west dock is \`insertBlockRows\`, and it is colour-coded because it is not a matter of taste.

One INSERT makes **at least one part per partition it touches**. A client that inserts one row at a time makes one part per row, and no merge pool on earth can consolidate parts as fast as a busy application can create them. ClickHouse's own guidance is to insert in batches of at least a few thousand rows, and preferably tens of thousands.

Below 2000 rows the stack goes red. That is not a stylistic choice — it is the range in which the \`too many parts\` scenario becomes inevitable.`,
      },
      {
        heading: 'When you cannot change the client',
        body: `Sometimes you cannot batch: the writer is a third-party agent, or a thousand separate processes each with one row. That is what \`async_insert\` is for — the server accumulates the rows in memory and writes one part per flush instead of one per statement.

Turn it on in the console and watch the part count collapse. Then read what \`wait_for_async_insert\` costs you.`,
      },
    ],
    metrics: [
      { label: 'INSERT / s', get: (s) => s.knobs.insertsPerSec.toFixed(1) },
      { label: 'Rows per block', get: (s) => fmtNum(s.knobs.insertBlockRows) },
      { label: 'SELECT / s', get: (s) => s.knobs.selectsPerSec.toFixed(1) },
      { label: 'Rows / s written', get: (s) => fmtNum(s.stats.insertRowsPerSec) },
    ],
    knobs: ['insertsPerSec', 'insertBlockRows', 'selectsPerSec', 'asyncInsert'],
    see: ['node.dist', 'node.insertdock'],
    refs: {
      docs: [
        { label: 'ClickHouse — Selecting an insert strategy', url: 'https://clickhouse.com/docs/best-practices/selecting-an-insert-strategy' },
        { label: 'ClickHouse — Asynchronous inserts', url: 'https://clickhouse.com/docs/optimize/asynchronous-inserts' },
      ],
    },
  },

  /* ======================================================================
   * Distributed
   * ====================================================================*/
  {
    id: 'node.dist',
    title: 'Distributed',
    subtitle: 'the table the clients connect to — every server has one',
    tldr: 'A router with a query rewriter, on every server. No data lives in it.',
    sections: [
      {
        heading: 'It is a table, not a node',
        body: `\`CREATE TABLE hits_dist AS hits ENGINE = Distributed(cluster, db, hits, sipHash64(UserID))\`.

That DDL runs on **every server in the cluster**. All four have the table, all four read the same \`system.clusters\`, and all four can answer the question — which is why there is one of these strips on each island rather than one initiator district between the clients and the shards.

The table holds no rows. On **INSERT** it evaluates the sharding expression per row, splits the block, and sends each piece to one replica of the target shard — as an INSERT into the **underlying local table** there (\`Distributed(cluster, db, local_table, key)\` names it), never into that server's own \`Distributed\` table. On **SELECT** it rewrites the query for one replica of each shard, sends it, and merges the partial results.`,
      },
      {
        heading: 'The initiator is whichever server the client called',
        body: `There is no designated router. The server that becomes the **initiator** of a statement is simply the one the application opened a connection to; it fans the statement out, merges what comes back, and answers. The next statement can be initiated by a different server, and with a driver that knows the cluster it usually is.

So the initiator role is a property of your *connection string*, not of your topology. Put one hostname in it and one server does every fan-out and every result merge for the whole cluster, while the other three only ever read their own shard — with the data distributed exactly the same either way. Move the **client connects to** dial and watch the initiated share on each island change while nothing about the data does.

Note also what does **not** cross the network: a server reading its own shard has no hop to make, which is why \`prefer_localhost_replica\` is on by default.`,
      },
      {
        heading: 'Background insert: the part people get wrong',
        body: `With the default \`distributed_foreground_insert = 0\`, an INSERT into a \`Distributed\` table returns as soon as each remote shard's slice is a .bin file on **the local disk of the server the client reached**, under \`data/<database>/<table>/shard<N>_all_replicas/\`. A background thread forwards each file afterwards — as an INSERT into the underlying MergeTree table on one live replica of its shard; the receiving server's own \`Distributed\` table is never involved.

The exception is the initiator's OWN shard: \`prefer_localhost_replica\` (on by default) writes that slice into the local table synchronously even in background mode, so it skips the queue entirely.

Look at the silos on each island. Whatever is in them is data that client has been told was accepted and which no shard has yet seen. If that server's disk dies, that data is gone — and *which* server was holding it is decided by which one the client happened to connect to.

Set it to \`foreground\` and the INSERT waits for every shard. Slower, and the only mode in which the client learns that a shard is down.`,
      },
      {
        heading: 'A SELECT only ever reaches one replica per shard',
        body: `The initiator picks a replica per shard according to \`load_balancing\` and sends the rewritten query there. Two shards means two remote queries — one of which is usually local — and the initiator merges their partial results.

That is also the trap: with \`load_balancing = random\`, a replica that is lagging by an hour is just as likely to be chosen as one that is current. \`max_replica_delay_for_distributed_queries\` closes that hole and is **not** set by default.

\`parallel_replicas\` changes the shape entirely: instead of one replica reading all of a shard's mark ranges, every replica of the shard reads a share of them. It is the only setting here that changes how much *work* a shard does rather than which node does it.`,
      },
      {
        heading: 'What the model simplifies',
        body: `The real engine splits a block by evaluating the sharding expression **per row** and honours per-shard weights. Here the block is split evenly with a deterministic lean that follows the hash, which is enough to make the skew argument honestly but is not a per-row evaluation.

The application's choice of server is modelled as a driver policy — round robin, random, or one hostname — with failover when a server is down. Real deployments often put a TCP load balancer in front instead, and real drivers do their own health checking and backoff; neither is modelled, and nor is connection pooling or the retry logic behind \`Code: 279\`.`,
      },
    ],
    metrics: [
      {
        label: 'Initiating now',
        get: (s) => `${s.nodes.filter((n) => n.distributed.fanOut > 0).length} of ${N_NODES} servers`,
      },
      { label: 'Statement spread', get: (s) => statementShare(s) },
      {
        label: 'Spooled blocks',
        get: (s) => String(sumNodes(s, (n) => n.distributed.pendingBlocks.reduce((a, b) => a + b, 0))),
      },
      {
        label: 'Spooled bytes',
        get: (s) => fmtBytes(sumNodes(s, (n) => n.distributed.pendingBytes.reduce((a, b) => a + b, 0))),
      },
      // State rows, not rows read: what a shard sends is one row per group.
      { label: 'State rows merged', get: (s) => fmtNum(sumNodes(s, (n) => n.distributed.rowsMerged)) },
      { label: 'From remote', get: (s) => fmtBytes(sumNodes(s, (n) => n.distributed.bytesFromRemote)) },
    ],
    knobs: ['clientBalancing', 'distributedInsert', 'loadBalancing', 'parallelReplicas', 'insertQuorum'],
    see: ['node.wheel', 'node.spool', 'node.resultmerge', 'clients', 'node.queue'],
    refs: {
      docs: [
        { label: 'ClickHouse — Distributed table engine', url: 'https://clickhouse.com/docs/engines/table-engines/special/distributed' },
        { label: 'ClickHouse — distributed_foreground_insert', url: 'https://clickhouse.com/docs/operations/settings/settings#distributed_foreground_insert' },
        { label: 'ClickHouse — Parallel replicas', url: 'https://clickhouse.com/docs/deployment-guides/parallel-replicas' },
      ],
      systemTables: [{ label: 'system.clusters' }, { label: 'system.distribution_queue' }],
    },
  },

  {
    id: 'node.wheel',
    title: 'The sharding key',
    subtitle: 'sipHash64(key) % shards — where every row goes',
    tldr: 'One expression decides your data distribution for the life of the table.',
    sections: [
      {
        heading: 'The wheel is the expression',
        body: `Each shard owns a contiguous arc, and the **width** of its arc is the cumulative share of rows it has received. The readout gives you the skew as a percentage.

A high-cardinality hash — \`sipHash64(UserID)\` — divides evenly and the arcs stay equal. A low-cardinality key, or one with a hot value in it (\`sipHash64(customer_id)\` where one customer is 40% of your traffic), does not, and no amount of hardware fixes it afterwards.`,
      },
      {
        heading: 'Why it matters more than it looks',
        body: `Shard skew is not merely a storage imbalance. The overloaded shard also does more merges, holds more parts, holds more znodes in Keeper, and is the slowest respondent to every distributed SELECT — and a distributed SELECT is only as fast as its slowest shard.

Changing a sharding key means rewriting the data. This is the decision it is worth spending a day on before the first INSERT.`,
      },
      {
        heading: 'The other option, and why it is usually wrong',
        body: `\`rand()\` as a sharding expression gives you a perfect distribution and destroys locality: a query that would have touched one shard now touches all of them, and any \`GROUP BY\` on the natural key becomes a two-stage aggregation across the network.

Hash the column your queries actually group by, unless it is skewed. Then hash a composite of it and something with cardinality.`,
      },
    ],
    metrics: [
      { label: 'Shard 1 rows', get: (s) => fmtNum(s.nodes[0].distributed.rowsToShard[0]) },
      { label: 'Shard 2 rows', get: (s) => fmtNum(s.nodes[0].distributed.rowsToShard[1]) },
      {
        label: 'Skew',
        get: (s) => {
          const t = s.nodes[0].distributed.rowsToShard[0] + s.nodes[0].distributed.rowsToShard[1]
          if (t <= 0) return '—'
          return `${((Math.abs(s.nodes[0].distributed.rowsToShard[0] - s.nodes[0].distributed.rowsToShard[1]) / t) * 100).toFixed(1)}%`
        },
      },
    ],
    see: ['node.dist', 'node.clusters'],
    refs: {
      docs: [
        { label: 'ClickHouse — Distributed, sharding_key', url: 'https://clickhouse.com/docs/engines/table-engines/special/distributed#distributed-clusters' },
      ],
    },
  },

  {
    id: 'node.spool',
    title: 'system.distribution_queue',
    subtitle: 'the background INSERT queue, on the initiator’s own disk',
    tldr: 'In background mode an INSERT is durable on the initiator, not on the shards.',
    sections: [
      {
        heading: 'Where these bytes live',
        body: `\`data/<database>/<distributed_table>/shard<N>_all_replicas/*.bin\` on the initiator's local filesystem — one directory per destination shard (with \`internal_replication = true\` and the default compact naming), one file per pending block, one row per directory in \`system.distribution_queue\`. The client has already been told the INSERT succeeded.

A background thread works through each directory and sends every file as an INSERT into the **underlying MergeTree table** on ONE live replica of that shard, picked by \`load_balancing\` at send time — the receiving server's own \`Distributed\` table plays no part in it. Getting the rows to the shard's other replica is \`ReplicatedMergeTree\`'s job, through Keeper, not the Distributed engine's.`,
      },
      {
        heading: 'What never enters the queue',
        body: `The slice for the initiator's OWN shard. \`prefer_localhost_replica\` (on by default) writes it into the local table immediately and synchronously, even in background mode — no .bin file, no queue row, and no failover: if the local table is read-only because its Keeper session is gone, the INSERT fails outright despite the "background" in the setting's name.

So a background INSERT is partly synchronous: when it returns, this server's shard already has its rows durable in MergeTree, while every other shard's rows are still files on this one disk.`,
      },
      {
        heading: 'When the silos fill',
        body: `A silo filling faster than it drains means the destination is refusing or slow — a shard that is down, a replica that is read-only because Keeper is unreachable, or a shard whose merge pool has fallen far enough behind to delay inserts.

The queue never drops a file. Each failed send raises \`error_count\` and the directory backs off exponentially — \`distributed_background_insert_sleep_time_ms\` (100 ms) × 2^\`error_count\`, capped by \`distributed_background_insert_max_sleep_time_ms\` (30 s) — then tries again. Watch \`data_files\` and \`data_compressed_bytes\` for depth, \`error_count\` and \`last_exception\` for why. \`is_blocked = 1\` means someone ran \`SYSTEM STOP DISTRIBUTED SENDS\`. A file the queue cannot even parse is moved to a \`broken/\` subdirectory and counted in \`broken_data_files\` — those are never retried.`,
      },
      {
        heading: 'The safe configuration',
        body: `If losing an accepted INSERT is unacceptable, \`distributed_foreground_insert = 1\` and accept the latency. If it is acceptable, background mode with monitoring on \`system.distribution_queue\` is the faster answer. What is never right is background mode without that monitoring.

Older material calls all of this the "directory monitor": \`insert_distributed_sync\` and the \`distributed_directory_monitor_*\` settings were renamed to \`distributed_foreground_insert\` and \`distributed_background_insert_*\` in 23.10, and the old names still work as aliases.`,
      },
      {
        heading: 'What the model simplifies',
        body: `The flush cadence here is a few tenths of a second rather than 100 ms, and a failed send retries after a flat pause instead of the real exponential backoff — the queue depth and the never-drop behaviour are what this component is for, not the timing curve. Files are never batched (\`distributed_background_insert_batch\` is off by default anyway), and nothing ever lands in \`broken/\`.`,
      },
    ],
    metrics: [
      { label: 'Shard 1 blocks', get: (s) => String(s.nodes[0].distributed.pendingBlocks[0]) },
      { label: 'Shard 2 blocks', get: (s) => String(s.nodes[0].distributed.pendingBlocks[1]) },
      { label: 'At risk', get: (s) => fmtBytes(sumNodes(s, (n) => n.distributed.pendingBytes.reduce((a, b) => a + b, 0))) },
    ],
    knobs: ['distributedInsert', 'nodeDown', 'keeperConnected'],
    see: ['node.dist'],
    refs: {
      docs: [
        { label: 'ClickHouse — system.distribution_queue', url: 'https://clickhouse.com/docs/operations/system-tables/distribution_queue' },
        { label: 'ClickHouse — distributed_background_insert_sleep_time_ms', url: 'https://clickhouse.com/docs/operations/settings/settings#distributed_background_insert_sleep_time_ms' },
      ],
      systemTables: [{ label: 'system.distribution_queue' }],
    },
  },

  {
    id: 'node.resultmerge',
    title: 'Result merge',
    subtitle: 'partial results from every shard, combined here',
    tldr: 'Only the initiator ever sees the whole answer.',
    sections: [
      {
        heading: 'Two-stage aggregation',
        body: `\`SELECT status, count() FROM hits_dist GROUP BY status\` does not ship rows. With more than one shard involved, \`StorageDistributed::getQueryProcessingStage\` returns \`WithMergeableState\`: each shard runs the aggregation over its own data and ships a **partial aggregate state**, one row per group; the initiator's \`MergingAggregatedStep\` merges those states and finalises.

That is why a distributed \`GROUP BY\` on a low-cardinality key is nearly free and one on a high-cardinality key is not — the state that crosses the network is proportional to the number of GROUPS, not to the number of rows. The packets in the city are sized by exactly that, so a query that scanned a billion rows and grouped by one small column brings home a short train.

Once a shard's hash table passes \`group_by_two_level_threshold\` (100,000 rows) its aggregation goes two-level and the states it ships carry bucket numbers. That is what lets \`distributed_aggregation_memory_efficient\` — on by default — merge bucket *N* from every shard together and hold one bucket at a time instead of every shard's whole result.

One shard only, and the picture changes completely: the shard is told to go to \`Complete\` and the initiator is a proxy.`,
      },
      {
        heading: 'What crosses the network',
        body: `Aggregate states, sorted blocks for an \`ORDER BY … LIMIT\`, and nothing else if the query allows it. A \`SELECT *\` with no filter genuinely does ship every row, and that is the query to look for when a distributed cluster feels slow for no reason.

\`ORDER BY … LIMIT n\` without aggregation is the case worth knowing: \`distributed_push_down_limit\` is 1 by default, so each shard sorts *and* applies \`offset + limit\` itself and ships at most that many already-sorted rows. The initiator does a k-way merge, not a re-sort.

Outbound, what leaves the initiator is the **rewritten SQL text** — \`db.dist\` replaced by the shard-local table, \`SETTINGS\` stripped because the settings travel in the query context. A serialised plan crosses instead only with \`serialize_query_plan\`, which is off by default.`,
      },
      {
        heading: 'The initiator’s own shard is not privileged',
        body: `With \`prefer_localhost_replica\` on — the default — the initiator's own shard runs the identical rewritten query at the identical stage, in-process, with no socket. It is not exempt from the work; it is exempt from the network. That is why the model counts \`bytesFromRemote\` for the other shards only, and why the merging cost lands on whichever server the clients happened to connect to.

Each shard also gets its own \`query_id\`, sharing the initiator's \`initial_query_id\` — so one distributed SELECT is N + 1 rows in \`system.query_log\`, and \`is_initial_query = 0\` on the shards' rows.`,
      },
      {
        heading: 'The slowest shard sets the pace',
        body: `The initiator cannot finalise until every shard has answered. One lagging replica, one shard with a cold cache, one shard whose merge pool is saturated — any of those is the latency of the whole query.

This is the argument for keeping shards balanced that has nothing to do with disk space.`,
      },
    ],
    metrics: [
      // State rows, not rows read: what a shard sends is one row per group.
      { label: 'State rows merged', get: (s) => fmtNum(sumNodes(s, (n) => n.distributed.rowsMerged)) },
      { label: 'From remote', get: (s) => fmtBytes(sumNodes(s, (n) => n.distributed.bytesFromRemote)) },
      { label: 'Mean query', get: (s) => `${s.stats.meanQueryMs.toFixed(0)} ms` },
    ],
    see: ['node.dist', 'node.readpool'],
  },

  {
    id: 'node.clusters',
    title: 'system.clusters',
    subtitle: 'the cluster definition, as the server sees it',
    tldr: 'Which hosts exist, in which shard, and whether they are reachable.',
    sections: [
      {
        heading: 'The board',
        body: `One lamp per host. Green means reachable, amber means reachable but degraded — read-only because Keeper is unreachable, or lagging far enough that a read from it would be stale — and red means the connection is failing.

The bright lamp in each shard is the replica the initiator chose for the most recent SELECT.`,
      },
      {
        heading: 'Amber is the dangerous state',
        body: `A host that is up and lagging is *chosen* by the load balancer exactly as often as a current one. Nothing errors. Queries simply return older data than they should, intermittently, depending on which replica answered.

That is the failure mode \`max_replica_delay_for_distributed_queries\` exists for. It is worth setting.`,
      },
    ],
    metrics: [
      {
        label: 'Hosts up',
        get: (s) => {
          let up = 0
          for (const n of s.nodes) if (n.status === 'up') up++
          return `${up} / ${N_NODES}`
        },
      },
      { label: 'Worst lag', get: (s) => `${s.stats.maxReplicaDelay.toFixed(1)} s` },
    ],
    knobs: ['nodeDown', 'loadBalancing', 'slowReplica'],
    see: ['node.dist', 'node.queue'],
    refs: { systemTables: [{ label: 'system.clusters' }, { label: 'system.replicas' }] },
  },

  /* ======================================================================
   * The node, and the write path
   * ====================================================================*/
  {
    id: 'node',
    title: 'One ClickHouse server',
    subtitle: 'one shard, one replica',
    tldr: 'An island: the write path north, the read path east, the background work south.',
    sections: [
      {
        heading: 'The layout is the order things happen',
        body: `**North** the insert dock: a block is sorted by the ORDER BY key, split by the partition expression, and each column compressed into its own \`.bin\`.

**West** the \`primary.cidx\` tower and the skip-index sheds — how a query finds anything.

**North, elevated** the mark cache and the uncompressed cache.

**Centre** the parts yard, standing over the excavation the data actually lives in.

**East** the read pool and its reader threads.

**South** the merge gantry and the TTL works.

**West, low** the replication queue and the Keeper session lamp.`,
      },
      {
        heading: 'What a server is spending its memory on',
        body: `Three consumers, and this ranking is the real one on a busy server. The **caches** are a fixed reservation. The **merges** are the variable cost that kills you — a horizontal merge on a wide table holds one read buffer per stream per input part. The **queries** are usually smallest.

\`MemoryTracking\` in \`system.metrics\` is the total; \`system.merges.memory_usage\` and \`system.processes.memory_usage\` are the breakdown.`,
      },
    ],
    metrics: [
      { label: 'Status', get: (s) => s.nodes[0].status },
      { label: 'CPU', get: (s) => `${(s.nodes[0].cpu * 100).toFixed(0)}%` },
      { label: 'Memory', get: (s) => fmtBytes(s.nodes[0].memoryBytes) },
      { label: 'Peak memory', get: (s) => fmtBytes(s.nodes[0].memoryPeakBytes) },
      { label: 'Queries served', get: (s) => fmtNum(s.nodes[0].queriesServed) },
      { label: 'Blocks written', get: (s) => fmtNum(s.nodes[0].blocksWritten) },
    ],
    see: ['node.yard', 'node.insertdock', 'node.readpool', 'node.merges'],
    refs: { systemTables: [{ label: 'system.metrics' }, { label: 'system.asynchronous_metrics' }] },
  },

  {
    id: 'node.insertdock',
    title: 'MergeTreeDataWriter',
    subtitle: 'the write path: sort, split, compress, rename',
    tldr: 'One INSERT becomes at least one part per partition it touches.',
    sections: [
      {
        heading: 'The four steps, in order',
        body: `**1. Sort.** The whole block is sorted in memory by the ORDER BY key. This is why an INSERT's memory is proportional to its block size and why a hundred-million-row single INSERT is a bad idea for reasons unrelated to parts.

**2. Split by partition.** The partition expression is evaluated per row and the block is divided. *Each piece becomes its own part.* A block spread over thirty days of a \`toYYYYMMDD\`-partitioned table makes thirty parts.

**3. Write the columns.** Each column — and each *stream* within a column — is compressed in blocks of at most \`max_compress_block_size\` and written to its own \`.bin\`, with a \`.mrk3\` recording where every granule starts. \`primary.cidx\` gets one sorting-key row per granule. All of it goes into a directory named \`tmp_insert_…\`.

**4. Rename.** The directory is renamed into place, the part enters \`preactive\`, joins the data-part set under lock, and becomes \`active\`. That rename is the commit, and it is atomic.`,
      },
      {
        heading: 'One column is several files',
        body: `The stacks on the writer block are streams, not columns, and there are more of them than you expect. An \`Array\` adds an offsets stream. A \`Map\` is two arrays, so three streams. A \`LowCardinality\` adds its dictionary. A \`JSON\` column adds one per discovered subcolumn.

The \`hits\` table in this model has ${TABLES[0].columns.length} columns and ${streamCount(0)} streams, and every one of them is a \`.bin\` and a \`.mrk3\` in every part. That is what \`min_bytes_for_wide_part\` exists to avoid: below that threshold the part is stored **Compact**, with all columns in one file, because a part with 400 tiny files is worse than a part with one.`,
      },
      {
        heading: 'parts_to_delay_insert, then parts_to_throw_insert',
        body: `ClickHouse does not fail an INSERT the moment the yard gets busy. Past \`parts_to_delay_insert\` (150 by default) it *sleeps before each INSERT*, deliberately, to give the merge pool room. The delay is quadratic, so the last few parts before the throw threshold cost far more than the first few.

Only past \`parts_to_throw_insert\` (300) does it give up with \`Code: 252. Too many parts\`.

**The delay is what you see in production**, long before any error: p99 insert latency climbing while nothing is technically wrong. Watch this component's readout while the "too many parts" scenario runs.`,
      },
      {
        heading: 'What the model simplifies',
        body: `Real block sizes vary; here every INSERT is exactly \`insertBlockRows\` rows. Compression is a per-column ratio rather than a real codec. The \`primary.cidx\` write and the \`.mrk3\` write are collapsed into one visible step.`,
      },
    ],
    metrics: [
      { label: 'Blocks written', get: (s) => fmtNum(s.nodes[0].blocksWritten) },
      { label: 'Rows / s', get: (s) => fmtNum(s.nodes[0].insertRowsPerSec) },
      {
        label: 'Insert delay',
        get: (s) => (s.nodes[0].insertDelay > 0.01 ? `${(s.nodes[0].insertDelay * 100).toFixed(0)}%` : 'none'),
      },
      { label: 'TOO_MANY_PARTS', get: (s) => fmtNum(s.nodes[0].tooManyPartsErrors) },
      { label: 'async buffer', get: (s) => fmtBytes(s.nodes[0].asyncInsertBytes) },
    ],
    knobs: ['insertBlockRows', 'insertsPerSec', 'asyncInsert', 'partsToDelayInsert', 'partsToThrowInsert'],
    see: ['node.yard', 'node.merges', 'clients'],
    refs: {
      docs: [
        { label: 'ClickHouse — MergeTree settings', url: 'https://clickhouse.com/docs/operations/settings/merge-tree-settings' },
        { label: 'ClickHouse — Selecting an insert strategy', url: 'https://clickhouse.com/docs/best-practices/selecting-an-insert-strategy' },
      ],
      source: [
        {
          label: 'src/Storages/MergeTree/MergeTreeDataWriter.cpp',
          url: 'https://github.com/ClickHouse/ClickHouse/blob/master/src/Storages/MergeTree/MergeTreeDataWriter.cpp',
          symbol: 'writeTempPart',
        },
      ],
      systemTables: [{ label: 'system.part_log' }, { label: 'system.asynchronous_inserts' }],
    },
  },

  /* ======================================================================
   * The parts yard
   * ====================================================================*/
  {
    id: 'node.yard',
    title: 'system.parts',
    subtitle: 'one tower per part — partition across, merge level back, rows up',
    tldr: 'A part is a directory. Everything about MergeTree follows from that.',
    sections: [
      {
        heading: 'A part is a directory',
        body: `Not a page, not a segment, not a row group. A directory, containing one \`.bin\` and one \`.mrk3\` per stream, a \`primary.cidx\`, a \`checksums.txt\`, a \`count.txt\`, and the skip-index files.

Everything else follows from that one fact:

- It is created under a temporary name and **renamed** into place, so a commit is atomic and needs no journal.
- It becomes visible **as a unit** and is superseded **as a unit**.
- **There is no such thing as modifying a part.** That is why an UPDATE is a mutation that rewrites whole parts, and why TTL cannot delete a row without rewriting the part around it.`,
      },
      {
        heading: 'Read the name',
        body: `\`20260701_412_418_2\` is \`<partition_id>_<min_block>_<max_block>_<level>\`.

**Partition** first, so parts of one partition sort together — and a merge may never cross that boundary. **Block range**: this part covers block numbers 412 through 418, which means it is the result of merging the parts that held those blocks. **Level 2**: it has been through two rounds of merging.

A part with \`min_block == max_block\` and level 0 came straight out of one INSERT and nothing has touched it. A trailing fifth number is a **mutation version**: \`20260701_412_418_2_43\` is the same rows as \`20260701_412_418_2\`, rewritten by mutation 43.

Every field of that name is a coordinate in the yard, which is why the yard is laid out the way it is. The lit cap on top of a tower is the only field that is not: it is the mutation version, which has nowhere else to go.`,
      },
      {
        heading: 'How to read the yard',
        body: `**One band per table**, named on the west kerb. A merge can never cross a table.

**One group per partition**, named with its real \`partition_id\` along the north edge. A merge can never cross that boundary either — that is the whole of what \`PARTITION BY\` buys you, and the gaps between the groups are it.

**One lane per merge level**, numbered on the east, level 0 at the front. A background merge takes several parts out of one lane and puts **one** part into the lane behind it, so merging is a visible march away from you: many thin towers at the front, a few wide ones at the back. Footprint is the level as well as the lane, and height is still rows — a deeper part really does hold more rows, and watching the two agree is what makes the level believable.

A cell — one table, one partition, one level — holds eight towers at full spacing and then **squeezes**. A level-0 cell packed with sixty slivers is what "too many parts" looks like before the exception arrives.

On top of all of that, a tower **pulses**: red while it is being written, green while it is being read — by a SELECT, or by the merge that is consuming it. That is the same red/green the moving packets use. It is a pulse and not a colour precisely because a part's colour is already spoken for: at rest, colour is state and nothing else.`,
      },
      {
        heading: 'The five states',
        body: `\`temporary\` — being written under \`tmp_insert_…\`. Not in the data-part set; invisible to everybody.

\`preactive\` — renamed into place, joining the set under \`DataPartsLock\`.

\`active\` — **the only state a SELECT can see.** When somebody asks "how many parts do I have", this is the number they mean.

\`outdated\` — superseded by a merge, still on disk. A query that started before the merge finished is still reading it, and \`old_parts_lifetime\` (eight minutes by default) is how long it is kept for that reason.

\`deleting\` — reference count hit zero; the directory is going away.`,
      },
      {
        heading: 'Why the count matters so much',
        body: `Every \`active\` part is a set of files a SELECT may have to open, a set of marks that may have to be resident, and — on a \`ReplicatedMergeTree\` — two znodes in Keeper per replica.

So a high part count is simultaneously a query-latency problem, a mark-cache-pressure problem, an insert-latency problem (\`parts_to_delay_insert\`) and a Keeper-memory problem. It is the single most useful number on a ClickHouse server.`,
      },
      {
        heading: 'What the model simplifies',
        body: `A real node holds thousands of parts per table. The yard is a WINDOW onto the newest 96 per table: a part beyond it is fully simulated — it merges, it expires, it is fetched, it counts in every total — it simply has nowhere to stand, so it is not drawn. When the window is full the oldest \`outdated\` directory gives up its place first, which costs no information because \`old_parts_lifetime\` is a maximum rather than a minimum.

There are five level lanes and the last one is labelled \`4+\`: a part at level 7 stands in it alongside the level-4 parts. Real levels have no ceiling, and a yard that grew a lane every time a table matured would eventually be deeper than the island.

Compact versus Wide part format is described but not drawn. \`min_rows_for_wide_part\`, \`checksums.txt\` and the projection directories are not modelled.`,
      },
    ],
    metrics: [
      {
        label: 'Active',
        get: (s) => {
          let n = 0
          for (const t of s.nodes[0].tables) n += t.activeParts
          return String(n)
        },
      },
      {
        label: 'Outdated',
        get: (s) => {
          let n = 0
          for (const t of s.nodes[0].tables) n += t.outdatedParts
          return String(n)
        },
      },
      { label: 'Cluster active', get: (s) => fmtNum(s.stats.activeParts) },
      {
        label: 'On disk',
        get: (s) => {
          let n = 0
          for (const t of s.nodes[0].tables) n += t.bytesOnDisk
          return fmtBytes(n)
        },
      },
      {
        label: 'Uncompressed',
        get: (s) => {
          let n = 0
          for (const t of s.nodes[0].tables) n += t.bytesUncompressed
          return fmtBytes(n)
        },
      },
      { label: 'Compression', get: (s) => `${s.stats.compressionRatio.toFixed(1)}×` },
    ],
    knobs: ['insertBlockRows', 'partsToDelayInsert', 'partsToThrowInsert', 'mergePoolSize'],
    see: ['node.merges', 'node.primaryindex', 'node.insertdock', 'keeper.znodes'],
    refs: {
      docs: [
        { label: 'ClickHouse — Data storage', url: 'https://clickhouse.com/docs/engines/table-engines/mergetree-family/mergetree#mergetree-data-storage' },
      ],
      source: [
        {
          label: 'src/Storages/MergeTree/IMergeTreeDataPart.h',
          url: 'https://github.com/ClickHouse/ClickHouse/blob/master/src/Storages/MergeTree/IMergeTreeDataPart.h',
          symbol: 'IMergeTreeDataPart::State',
        },
      ],
      systemTables: [{ label: 'system.parts' }, { label: 'system.parts_columns' }, { label: 'system.part_log' }],
    },
  },

  /* ======================================================================
   * The read path
   * ====================================================================*/
  {
    id: 'node.analysis',
    title: 'selectRangesToRead',
    subtitle: 'index analysis — one task per part, finished before a thread exists',
    tldr: 'Everything a query decides NOT to read, it decides here, at plan time.',
    sections: [
      {
        heading: 'Why this is not part of the read pool',
        body: `A query plan asks \`ReadFromMergeTree\` what it is going to read *while it is still being optimised*, and the answer is memoised: \`initializePipeline\` calls \`getAnalysisResult()\` and uses whatever is already there. So by the time the pipeline exists — let alone a reader thread — the list of parts and mark ranges is fixed.

That ordering is why this building stands at the head of the index racks and not next to \`MergeTreeReadPool\`. The pool is *given* a list. It never asks an index anything, and no reader thread ever opens \`primary.cidx\`.

It can run more than once: a projection, a JOIN or a parallel-replicas decision can rebuild the step, and the server counts the rounds in the \`IndexAnalysisRounds\` profile event.`,
      },
      {
        heading: 'One task per part, in parallel',
        body: `The unit of this step is a PART. \`MergeTreeDataSelectExecutor\` schedules one task per selected part on its own thread pool — bounded by \`max_threads_for_indexes\`, which is 0 (meaning "as many as there are streams") by default — and waits for all of them.

That is what the row of lamps is: analysis tasks in flight, each one a part opening its own index files. It is a window, like the parts yard — a real query analyses every selected part, and this server can have hundreds.`,
      },
      {
        heading: 'The order of the sieve, and what each step removes',
        body: `The steps are not interchangeable, and each one removes a different UNIT:

**Whole parts** — the partition key, then the partition minmax index, then column statistics. No index file is opened for any of this.

**Granules** — the query condition cache (if \`use_query_condition_cache\` is on), then \`primary.cidx\` producing mark ranges, then the skip indexes narrowing them.

**Rows** — PREWHERE, and PREWHERE only. It is the one filter that runs inside a reader thread, on data already read.

So: parts are gone before any thread reads, granules are gone before any thread reads, and rows are the only thing a reading thread throws away.`,
      },
      {
        heading: 'It uses different caches from the reading',
        body: `Analysis reads index files through the *index* caches — \`getIndexMarkCache()\` and \`getIndexUncompressedCache()\` — which are separate from the \`MarkCache\` and uncompressed cache a reader thread uses for \`.mrk3\` and data blocks. Sizing one tells you nothing about the other.

This is also why the mark-cache duct in the city runs to the reader BAYS: \`MergeTreeMarksLoader\` runs inside the thread that is about to seek, not here.`,
      },
      {
        heading: 'What the model simplifies',
        body: `The pods are capped at five per table however many parts were selected, so the drawing stays inside its frame budget; \`partsSelected\` on the query still counts every part. Analysis is given a fixed short duration rather than a cost derived from index size. Sampling, projections, \`_part\` value filtering, column statistics and the query condition cache are named here but not simulated as separate steps.`,
      },
    ],
    metrics: [
      {
        label: 'Planning now',
        get: (s) => {
          let planning = 0
          let parts = 0
          for (const nd of s.nodes) {
            for (const q of nd.queries) {
              if (!q.analysing) continue
              planning++
              parts += q.partsSelected
            }
          }
          return planning === 0 ? 'idle' : `${planning} queries · ${fmtNum(parts)} parts`
        },
      },
      {
        label: 'granules total',
        get: (s) => (s.nodes[0].queries[0] ? fmtNum(s.nodes[0].queries[0].granulesTotal) : '—'),
      },
      {
        label: 'after skip',
        get: (s) => (s.nodes[0].queries[0] ? fmtNum(s.nodes[0].queries[0].granulesAfterSkip) : '—'),
      },
    ],
    see: ['node.primaryindex', 'node.skipindexes', 'node.readpool'],
  },

  {
    id: 'node.primaryindex',
    title: 'primary.cidx',
    subtitle: `the sparse primary index — one key row per ${GRAN}-row granule`,
    tldr: 'It cannot find a row. It can only tell you which granule a row must be in.',
    sections: [
      {
        heading: 'One per PART, and there are three racks for that reason',
        body: `There is no table-level primary index. \`primary.cidx\` is a file **inside every part directory**, loaded into that part's own memory and kept there for as long as the part exists; the search runs once per part, in parallel across parts, and the mark ranges it returns are numbered inside that one part. Mark 4181 of one part has nothing to do with mark 4181 of another.

CHSimCity draws one rack at the west end of each table's band — three per server — because a query names one table and consults the index of every part of it. Even that is a simplification: strictly there would be one small index per tower in the yard. What must not be simplified away is that the index belongs to the DATA, not to the server.`,
      },
      {
        heading: 'Sparse, and deliberately so',
        body: `Each rack is drawn as a stack of equal steps because that is exactly what this index is: one entry per \`index_granularity\` rows — ${GRAN} by default — holding the sorting-key values of that granule's first row.

A billion-row part therefore has about 122,000 index entries, not a billion. Small enough to load when the part is attached and to **stay** resident. That is the trade: tiny and always there, and in exchange it cannot identify a row. (With \`index_granularity_bytes\` on — the default — granules do not all hold the same number of rows, which is why every mark carries its own row count and why row arithmetic goes through the granularity table rather than a multiplication.)`,
      },
      {
        heading: 'What a query actually does with it',
        body: `\`WHERE CounterID = 57\` on a table ordered by \`(CounterID, EventDate, …)\`:

1. Binary-search that PART's index for the first granule whose key could contain 57, and the last.
2. That is a **mark range**: granules 4181 through 4184, say — \`[begin × index_granularity, end × index_granularity)\`.
3. Read those four granules — ${GRAN} rows each — and filter the ~32,000 rows down to the matching ones.

Step 1 is a true binary search only when the predicate is ONE continuous key interval. \`IN (…)\`, \`OR\`, or a tuple comparison takes the other path: a coarse recursive exclusion search that splits each candidate range into \`merge_tree_coarse_index_granularity\` pieces (8 by default) and throws away the ones the key cannot be in — which is why those predicates leave many disjoint ranges behind rather than one.

Ranges closer together than \`merge_tree_min_rows_for_seek\` are then merged, so some granules are read that never matched: skipping them would have cost more than reading them.

The beam on the rack lights while a query on THAT table is doing this, and its height is where in the key space the search landed.`,
      },
      {
        heading: 'It only works on a key PREFIX',
        body: `This is the single most common ClickHouse misunderstanding, and it is worth being precise about.

The index is sorted by \`(CounterID, EventDate, UserID)\`. \`WHERE CounterID = 57\` narrows it beautifully. \`WHERE CounterID = 57 AND EventDate = '2026-07-01'\` narrows it further. **\`WHERE EventDate = '2026-07-01'\` alone narrows it hardly at all**, because every value of \`CounterID\` contains that date, so nearly every granule's range straddles it.

Compare the readout on the read pool while the "ORDER BY does not match the query" scenario runs: when \`granules_after_key\` equals \`granules_total\`, the index did no work whatsoever. That is a schema problem, not a tuning one.`,
      },
      {
        heading: 'What the first key column costs you',
        body: `Cardinality decides how tight a range the search can produce, and the model reflects it: the \`hits\` table's \`CounterID\` prefix gives a very tight range, and the \`sessions\` table's \`session_id\` UUID prefix gives almost none — a UUID sorting key is sorted but useless for constraining anything else.

It also decides compression. \`CounterID\` first means long runs of one value, and \`Delta, LZ4\` takes it to almost nothing. The same column third in the key is nearly incompressible. **ORDER BY is a storage decision as much as a query one.**`,
      },
      {
        heading: 'What the model simplifies',
        body: `The tower shows 22 ticks rather than one per real granule. \`primary_key_ratio_of_bytes_allowed_in_memory\`, \`index_granularity_bytes\` (adaptive granularity) and the \`PRIMARY KEY\` / \`ORDER BY\` split are not modelled.`,
      },
    ],
    metrics: [
      {
        label: 'Marks resident',
        get: (s) => {
          let m = 0
          for (const t of s.nodes[0].tables) for (const p of t.parts) if (p.state === 'active') m += p.marks
          return fmtNum(m)
        },
      },
      { label: 'index_granularity', get: () => GRAN },
      {
        label: 'granules total',
        get: (s) => (s.nodes[0].queries[0] ? fmtNum(s.nodes[0].queries[0].granulesTotal) : '—'),
      },
      {
        label: 'after key',
        get: (s) => (s.nodes[0].queries[0] ? fmtNum(s.nodes[0].queries[0].granulesAfterKey) : '—'),
      },
      {
        label: 'pruned by key',
        get: (s) => {
          const q = s.nodes[0].queries[0]
          if (!q || q.granulesTotal <= 0) return '—'
          return `${((1 - q.granulesAfterKey / q.granulesTotal) * 100).toFixed(1)}%`
        },
      },
    ],
    knobs: ['primaryKeyHitRatio', 'partitionPruneRatio', 'selectsPerSec'],
    see: ['node.skipindexes', 'node.readpool', 'node.markcache'],
    refs: {
      docs: [
        { label: 'ClickHouse — A practical introduction to primary indexes', url: 'https://clickhouse.com/docs/guides/best-practices/sparse-primary-indexes' },
        { label: 'ClickHouse — Choosing a primary key', url: 'https://clickhouse.com/docs/engines/table-engines/mergetree-family/mergetree#selecting-a-primary-key' },
      ],
      source: [
        {
          label: 'src/Storages/MergeTree/MergeTreeDataSelectExecutor.cpp',
          url: 'https://github.com/ClickHouse/ClickHouse/blob/master/src/Storages/MergeTree/MergeTreeDataSelectExecutor.cpp',
          symbol: 'markRangesFromPKRange',
        },
      ],
    },
  },

  {
    id: 'node.skipindexes',
    title: 'Data skipping indexes',
    subtitle: 'skp_idx_*.idx2 — they only ever remove work',
    tldr: 'A small summary per block of granules. If it proves the block cannot match, the block is never opened.',
    sections: [
      {
        heading: 'What they are not',
        body: `They are not indexes in the B-tree sense. A skip index cannot find anything and cannot make a query more precise. It reads a tiny summary covering \`GRANULARITY n\` index granules and answers exactly one question: *could this block contain a match?* If the answer is no, the block is skipped.

Each shed's **height** here is the share of blocks its index can actually prune. That is the only number that matters about a skip index.`,
      },
      {
        heading: 'A minmax on a correlated column is nearly free',
        body: `\`idx_event_time\` is \`minmax\` on \`EventTime\`, and \`EventDate\` is in the sorting key — so the parts are already nearly sorted by it and every block has a tight \`[min, max]\`. It prunes about 88% of blocks for a few kilobytes of index.

**Correlation with the sorting key is the whole reason a minmax index ever works.** A minmax on a randomly-distributed column has every block reporting nearly the full range, and prunes nothing.`,
      },
      {
        heading: 'A set() that overflowed prunes nothing',
        body: `\`idx_region\` is \`set(100)\` on a column with 200 distinct values. Once a block's set overflows the limit, the index records "could be anything" for that block, and once most blocks have overflowed the index is pure overhead: index bytes to write on every INSERT, index bytes to read on every query, and no pruning at all.

It is worse than having no index, and \`system.parts_columns\` will not tell you. The only way to find out is to check whether \`granulesAfterSkip\` is actually below \`granulesAfterKey\`.`,
      },
      {
        heading: 'GRANULARITY is a resolution limit',
        body: `\`GRANULARITY 4\` means the index decides four index granules at a time. Even a perfectly selective predicate still reads four granules — ${fmtNum(INDEX_GRANULARITY * 4)} rows — where one would have done.

Lower granularity means a bigger index and finer pruning. \`GRANULARITY 1\` on a \`minmax\` over a numeric column is usually right; \`GRANULARITY 4\` on a \`tokenbf_v1\` over long strings usually is too, because the filter itself is the expensive part.`,
      },
      {
        heading: 'Bloom filters, and what they are for',
        body: `\`bloom_filter\`, \`tokenbf_v1\` and \`ngrambf_v1\` all answer "does this block contain this value / token / substring", with false positives and no false negatives.

\`tokenbf_v1\` on a URL column is genuinely good: most blocks do not contain the token you are searching for, so most blocks are skipped. The cost is that you must size it — \`tokenbf_v1(size_bytes, hashes, seed)\` — and an undersized filter saturates and prunes nothing, exactly like an overflowed set.`,
      },
      {
        heading: 'Where and when they actually run',
        body: `In \`selectRangesToRead\`, at plan time, per part, on the analysis thread pool — after the primary key and never instead of it. A part the primary key already emptied is not consulted at all, and a part whose index file is missing is passed through untouched with a line in the log rather than an error.

The unit is index-mark space: the surviving mark ranges are mapped into \`GRANULARITY n\`-sized index granules, filtered, expanded back, and then ranges closer together than \`merge_tree_min_rows_for_seek\` are coalesced — so a few granules survive that nothing matched, because seeking past them was not worth the seek.

They read through the **index** caches (\`getIndexMarkCache\`, \`getIndexUncompressedCache\`), not through the mark cache and uncompressed cache a reader thread uses. Sizing one tells you nothing about the other.

One exception to "at plan time": an index can be marked as applicable *during* the data read, in which case analysis skips it and the reader applies it. Vector similarity indexes are never eligible for that.`,
      },
      {
        heading: 'On the file name',
        body: `\`.idx\` and \`.idx2\` are the same artefact at two serialization versions — the extension encodes the version, and the server probes the part's checksums to see which one is there. So \`skp_idx_region.idx\` and \`skp_idx_region.idx2\` are not two different things, and a part written by an older server can carry the older name.`,
      },
      {
        heading: 'What the model simplifies',
        body: `Pruning is a per-index selectivity constant rather than a real filter evaluation. \`GRANULARITY\` is honoured as a resolution floor. Index build cost on INSERT and on merge is not charged. The per-part index order, the on-data-read variant above, and the vector-similarity index cache are not modelled.`,
      },
    ],
    metrics: [
      {
        label: 'Indexes',
        get: () => {
          let n = 0
          for (const t of TABLES) n += t.skipIndexes.length
          return `${n} across ${N_TABLES} tables`
        },
      },
      {
        label: 'after key',
        get: (s) => (s.nodes[0].queries[0] ? fmtNum(s.nodes[0].queries[0].granulesAfterKey) : '—'),
      },
      {
        label: 'after skip',
        get: (s) => (s.nodes[0].queries[0] ? fmtNum(s.nodes[0].queries[0].granulesAfterSkip) : '—'),
      },
      {
        label: 'pruned by skip',
        get: (s) => {
          const q = s.nodes[0].queries[0]
          if (!q || q.granulesAfterKey <= 0) return '—'
          return `${((1 - q.granulesAfterSkip / q.granulesAfterKey) * 100).toFixed(1)}%`
        },
      },
    ],
    knobs: ['skipIndexUseRatio', 'primaryKeyHitRatio', 'selectsPerSec'],
    see: ['node.primaryindex', 'node.readpool'],
    refs: {
      docs: [
        { label: 'ClickHouse — Data skipping indexes', url: 'https://clickhouse.com/docs/optimize/skipping-indexes' },
        { label: 'ClickHouse — Available index types', url: 'https://clickhouse.com/docs/engines/table-engines/mergetree-family/mergetree#available-types-of-indices' },
      ],
      systemTables: [{ label: 'system.data_skipping_indices' }],
    },
  },

  {
    id: 'node.readpool',
    title: 'MergeTreeReadPool',
    subtitle: 'hands mark ranges to max_threads reader threads',
    tldr: 'Three numbers explain every ClickHouse query: granules total, after key, after skip.',
    sections: [
      {
        heading: 'The whole read path, in order — and in two phases',
        body: `**Planning, in \`selectRangesToRead\`, before this pool exists:**

**1. Partition pruning.** The partition expression is evaluated against the WHERE clause and whole partitions are discarded without opening a single file — then the partition minmax index and column statistics drop more whole parts.

**2. The primary index.** Per selected part, in parallel, \`primary.cidx\` is searched and mark ranges come back.

**3. Skip indexes.** Inside those ranges, each \`skp_idx_*\` is consulted and granules it can prove irrelevant are dropped.

**Execution, which is where this pool starts:**

**4. The read pool.** The finished \`(part, mark ranges)\` list is cut into per-thread queues, each one spanning whichever parts its slice happens to cover. The pool is *handed* this list; it never consults an index, and neither does any reader thread.

**5. The readers.** Each resolves a mark through the mark cache — inside the reading thread, which is why the seeking phase is a real phase — reads the compressed block it points at, checks the uncompressed cache, decompresses if it must, applies PREWHERE to the ROWS, and streams blocks of at most \`max_block_size\` up.`,
      },
      {
        heading: 'A thread does not get a part. It gets pieces of several',
        body: `What reaches the pool is a LIST of \`(part, mark ranges)\`, and \`fillPerThreadInfo\` cuts that list up — it does not distribute parts. So one thread's workload is normally a few ranges out of a few *different* parts, each read through that part's own \`primary.cidx\` and its own skip-index files, and the same big part is being read by several threads at once.

Watch the beams standing in the yard. Each one is one task: which part it stands on is where the range lives, how wide it is is how much of that part the range covers, and the bright one is the task its thread is on right now. Several narrow beams on one tower means several threads are inside that part; one thread's beams landing on four towers means its queue spans four parts.

A pool that gave one part to one thread would be a queue, and the query's latency is its slowest thread — so it would stall on whichever thread drew the biggest part. That is the entire reason this is a class.`,
      },
      {
        heading: 'Stealing, and why max_threads is a ceiling not an allocation',
        body: `\`getTask\` lets a thread whose own queue has run dry take work off the back of another thread's. The deal is an estimate; stealing is what makes a wrong estimate cheap.

How many threads actually run is not \`max_threads\` either. The pool divides the surviving marks by \`merge_tree_min_rows_for_concurrent_read\` (163840 rows — twenty granules at the default \`index_granularity\`) and uses that many, capped by \`max_threads\`. An indexed lookup therefore lights ONE bay however high you set it, because starting eight threads to read twelve granules costs more than reading them. Raise the granule count — drop the WHERE, or query a column the sorting key cannot help — and the rest of the bays light up.`,
      },
      {
        heading: 'The reader phases, and what they tell you',
        body: `Each bay's colour is the phase, and the colours are borrowed from whichever cache decides it:

**seeking** (mark-cache orange) — resolving the mark. A mark-cache hit makes this nearly free; a miss is a real disk seek *per stream*.

**reading** (reader blue) — pulling the compressed block off the device.

**decompressing** (block-cache teal) — LZ4 or ZSTD. An uncompressed-cache hit skips it entirely.

**filtering** (skip-index aqua) — applying the WHERE to the granule's rows.

**aggregating** (green) — the hash table.

If the seeking phase dominates, your mark cache is too small. If decompressing dominates, your codec is too heavy for the query pattern. The bar on each bay is that thread's mark range, so a thread with a big range visibly takes longer.`,
      },
      {
        heading: 'max_threads raises memory as well as speed',
        body: `Each reader thread holds its own read buffers, and an aggregation holds one hash table per thread. So \`max_threads = 64\` on a machine with 64 cores costs 64 hash tables per concurrent query, and \`max_memory_usage\` is per query, not per thread.

This is why the answer to "my queries OOM" is sometimes to *lower* \`max_threads\`.`,
      },
      {
        heading: 'What the model simplifies',
        body: `The surviving marks are spread over the selected parts in proportion to their size, and the range's position inside each part is arbitrary. That is right in shape — every part carries the whole key range of the table, so a range predicate really does leave a piece of nearly every part behind — but a real analysis computes the exact ranges per part, and it deals the biggest tasks first, which the model does not.

A thread's queue is shown up to five tasks deep; a real one is unbounded. Stealing is modelled as one round after the deal rather than continuously. \`max_streams\`, PREWHERE, and the difference between \`Coordinator\` and \`InOrder\` pools are not modelled. Rows inside a granule are counted, never materialised.`,
      },
    ],
    metrics: [
      {
        label: 'Threads busy',
        get: (s) => {
          let b = 0
          for (const r of s.nodes[0].readers) if (r.state !== 'idle') b++
          return `${b} / ${N_READ_THREADS}`
        },
      },
      {
        // The number that says the pool is not a queue of parts: how many parts
        // one busy thread is holding ranges from, right now.
        label: 'Parts per busy thread',
        get: (s) => {
          let tasks = 0
          let busy = 0
          let stolen = 0
          for (const r of s.nodes[0].readers) {
            if (r.state === 'idle') continue
            busy++
            tasks += r.taskCount
            if (r.stolenFrom >= 0) stolen++
          }
          if (busy === 0) return '—'
          return `${(tasks / busy).toFixed(1)}${stolen > 0 ? ` · ${stolen} stealing` : ''}`
        },
      },
      {
        label: 'granules total',
        get: (s) => (s.nodes[0].queries[0] ? fmtNum(s.nodes[0].queries[0].granulesTotal) : '—'),
      },
      {
        label: 'after key',
        get: (s) => (s.nodes[0].queries[0] ? fmtNum(s.nodes[0].queries[0].granulesAfterKey) : '—'),
      },
      {
        label: 'after skip',
        get: (s) => (s.nodes[0].queries[0] ? fmtNum(s.nodes[0].queries[0].granulesAfterSkip) : '—'),
      },
      {
        label: 'parts selected',
        get: (s) =>
          s.nodes[0].queries[0]
            ? `${s.nodes[0].queries[0].partsSelected} / ${s.nodes[0].queries[0].partsTotal}`
            : '—',
      },
      { label: 'Mean query', get: (s) => `${s.stats.meanQueryMs.toFixed(0)} ms` },
    ],
    knobs: ['maxThreads', 'primaryKeyHitRatio', 'skipIndexUseRatio', 'partitionPruneRatio', 'selectsPerSec'],
    see: ['node.primaryindex', 'node.skipindexes', 'node.markcache', 'node.uncompressedcache'],
    refs: {
      docs: [
        { label: 'ClickHouse — Query analysis', url: 'https://clickhouse.com/docs/guides/developer/understanding-query-execution-with-the-analyzer' },
      ],
      source: [
        {
          label: 'src/Storages/MergeTree/MergeTreeReadPool.cpp',
          url: 'https://github.com/ClickHouse/ClickHouse/blob/master/src/Storages/MergeTree/MergeTreeReadPool.cpp',
          symbol: 'fillPerThreadInfo',
        },
      ],
      systemTables: [{ label: 'system.query_log' }, { label: 'system.processes' }],
    },
  },

  /* ======================================================================
   * The caches
   * ====================================================================*/
  {
    id: 'node.markcache',
    title: 'Mark cache',
    subtitle: '.mrk3 offsets — a reader cannot seek without them',
    tldr: 'The cache nobody sizes, and the one whose miss costs a disk seek per stream.',
    sections: [
      {
        heading: 'What a mark is',
        body: `A pair of offsets, plus a row count. **Where in the \`.bin\` the compressed block containing this granule starts**, and **how far into that block, once decompressed, the granule's first row is**. Three 64-bit numbers per granule per stream.

A reader cannot begin reading a column until it has the mark. So the mark is on the critical path of every single read, and a miss is a small random read of the \`.mrk3\` file — one per stream.`,
      },
      {
        heading: 'Why the working set is so much larger than people expect',
        body: `Marks per part = granules × streams. The \`hits\` table here has ${streamCount(0)} streams; a part with 10,000 granules therefore has ${fmtNum(10000 * streamCount(0))} marks, at 24 bytes each — around ${fmtBytes(10000 * streamCount(0) * 24)} **for one part**.

Multiply by the part count, by the table count, and by every table on the server. \`mark_cache_size\` defaults to 5 GiB and is usually left there, and on a server with hundreds of wide tables that is not enough.

**The model is explicit about this one.** It draws three tables but sizes the mark working set as if the node hosted twenty-four times as many, because sizing the cache against three tables would make 5 GiB look infinitely generous and hide the failure mode entirely. The 5 GiB default is comfortable here and 32 MiB is catastrophic — which is the relationship a real server has.`,
      },
      {
        heading: 'The symptom',
        body: `High IOPS with low throughput: many tiny reads. Query latency that does not correlate with the amount of data scanned. In the read pool bays, a **seeking** phase that dominates every task.

Run the "mark cache is too small" scenario and watch the bays. Nothing about the data volume changes; only whether the offsets were resident.`,
      },
      {
        heading: 'It is a fixed reservation',
        body: `The cache is memory the server has taken and will not give back, and it comes out of the same budget as your merges and your queries. Look at the node's memory readout: \`mark_cache_size\` is a floor under it.

So sizing it is a real trade, not a free win. The right size is "large enough that the hit ratio is above ~99% for the tables you actually query", and \`system.events\` gives you \`MarkCacheHits\` and \`MarkCacheMisses\` to check.`,
      },
      {
        heading: 'What the model simplifies',
        body: `The hit probability is derived from the share of the working set the cache can hold, skewed to reflect that the newest partition is read far more than the oldest. It is not an LRU simulation, and the eviction counter is indicative rather than exact.

The working set is also scaled by a factor of twenty-four to stand for the tables the node hosts and this model does not draw — see the section above.`,
      },
    ],
    metrics: [
      { label: 'Capacity', get: (s) => fmtBytes(s.nodes[0].markCache.capacityBytes) },
      { label: 'Resident', get: (s) => fmtBytes(s.nodes[0].markCache.usedBytes) },
      {
        label: 'Hit ratio',
        get: (s) => `${(s.nodes[0].markCache.hitRatio * 100).toFixed(1)}%`,
        hint: 'below ~99% on a query-serving node is worth investigating',
      },
      { label: 'Hits', get: (s) => fmtNum(s.nodes[0].markCache.hits) },
      { label: 'Misses', get: (s) => fmtNum(s.nodes[0].markCache.misses) },
      { label: 'Evictions', get: (s) => fmtNum(s.nodes[0].markCache.evictions) },
    ],
    knobs: ['markCacheMib', 'selectsPerSec', 'insertBlockRows'],
    see: ['node.uncompressedcache', 'node.readpool', 'node.primaryindex'],
    refs: {
      docs: [
        { label: 'ClickHouse — mark_cache_size', url: 'https://clickhouse.com/docs/operations/server-configuration-parameters/settings#mark_cache_size' },
      ],
      systemTables: [{ label: 'system.events — MarkCacheHits / MarkCacheMisses' }, { label: 'system.metrics' }],
    },
  },

  {
    id: 'node.uncompressedcache',
    title: 'Uncompressed cache',
    subtitle: 'decompressed blocks — off by default, and usually correctly',
    tldr: 'Only pays for itself when the same small set of granules is read over and over.',
    sections: [
      {
        heading: 'What it holds',
        body: `Decompressed blocks. A hit means a reader skips the LZ4 or ZSTD decompression entirely and reads the bytes straight out of memory.

\`uncompressed_cache_size\` is **0 by default**, and the tank here starts empty and dark for that reason.`,
      },
      {
        heading: 'Why off is usually right',
        body: `Decompressed data is several times larger than the compressed form — the compression ratio on this cluster is currently the figure in the header — so the cache holds far less than its size suggests.

On an analytical scan, every block is read once and never again. The cache is then pure eviction churn: memory spent, CPU spent inserting, and nothing ever served from it. Worse, it is memory the merges and queries could have used.`,
      },
      {
        heading: 'When on is right',
        body: `A point-lookup workload against a small hot range: a dashboard that queries the last hour over and over, a \`Dictionary\` source, a key-value pattern over a narrow table.

There the same granules are genuinely re-read, and \`use_uncompressed_cache = 1\` on those queries — it is a per-query setting as well as a server one — turns a decompression into a memcpy.

Turn it on in the console and watch the decompressing phase disappear from the reader bays. Then turn it off and notice that on this workload it barely mattered.`,
      },
    ],
    metrics: [
      {
        label: 'Capacity',
        get: (s) =>
          s.nodes[0].uncompressedCache.capacityBytes > 0
            ? fmtBytes(s.nodes[0].uncompressedCache.capacityBytes)
            : 'disabled',
      },
      { label: 'Resident', get: (s) => fmtBytes(s.nodes[0].uncompressedCache.usedBytes) },
      {
        label: 'Hit ratio',
        get: (s) =>
          s.nodes[0].uncompressedCache.capacityBytes > 0
            ? `${(s.nodes[0].uncompressedCache.hitRatio * 100).toFixed(1)}%`
            : '—',
      },
      { label: 'Compression', get: (s) => `${s.stats.compressionRatio.toFixed(1)}×` },
    ],
    knobs: ['uncompressedCacheMib', 'selectsPerSec', 'primaryKeyHitRatio'],
    see: ['node.markcache', 'node.readpool'],
    refs: {
      docs: [
        { label: 'ClickHouse — uncompressed_cache_size', url: 'https://clickhouse.com/docs/operations/server-configuration-parameters/settings#uncompressed_cache_size' },
        { label: 'ClickHouse — use_uncompressed_cache', url: 'https://clickhouse.com/docs/operations/settings/settings#use_uncompressed_cache' },
      ],
    },
  },

  /* ======================================================================
   * Merges
   * ====================================================================*/
  {
    id: 'node.merges',
    title: 'system.merges',
    subtitle: 'the background pool that keeps the part count finite',
    tldr: 'Without merges a MergeTree becomes unreadable. This is not an optimisation.',
    sections: [
      {
        heading: 'The selector is not a queue',
        body: `Every few seconds each node looks at every partition of every table and asks one question: **is there a range of ADJACENT parts worth merging?**

Adjacency is by block number. The range may not cross a partition boundary, ever — that is what makes \`PARTITION BY\` a physical guarantee rather than a hint. And it may not exceed \`max_bytes_to_merge_at_max_space_in_pool\`, which is why very large parts eventually stop merging and a mature partition settles at a few big parts rather than one.`,
      },
      {
        heading: 'Why it refuses obvious-looking merges',
        body: `\`SimpleMergeSelector\` prefers a range whose total size is at least \`base\` times its largest member — 5 by default. Below that it waits.

The reason is write amplification. Merging a 100 GiB part with a 1 MiB part rewrites 100 GiB to remove one part, and doing that repeatedly spends your entire disk budget on rewriting data that was already fine. So the selector waits for the small parts to accumulate into something worth merging with, which is what produces the roughly-logarithmic ladder of levels you can read off the part names.

Under insert pressure it becomes far less fussy: past \`parts_to_delay_insert\`, reducing the part count is suddenly worth the amplification.`,
      },
      {
        heading: 'Horizontal versus vertical',
        body: `A **horizontal** merge reads every column of every input part concurrently: one read buffer per stream per part. Memory grows with (streams × parts), and on a table with hundreds of columns that is how you get \`MEMORY_LIMIT_EXCEEDED\` during a merge.

A **vertical** merge merges only the sorting-key columns first, records the row permutation that produced the result, and then applies that permutation one payload column at a time. Peak memory stops depending on how wide the table is. \`enable_vertical_merge_algorithm\` is on by default, gated on the column count and the row count, because on a narrow table the second pass is pure overhead.

Each bay reports its algorithm and its \`memory_usage\`. Compare a \`hits\` merge — twelve columns and fifteen streams, so it goes vertical — with a \`metrics\` merge, which is four narrow columns and stays horizontal because the second pass would be pure overhead. \`sessions\` has only four columns and stays horizontal too, even though one of them is a \`JSON\`: the activation threshold counts COLUMNS, not streams.`,
      },
      {
        heading: 'The beams',
        body: `Every running merge drops a beam onto the parts it has reserved, and the beam widens with the number of inputs. Those parts are still \`active\` — \`system.parts\` will not tell you they are reserved — so the pulse on them is the only sign.

When the merge commits, the inputs become \`outdated\` in one step and the output appears as \`preactive\`. Nothing is deleted at that moment: \`old_parts_lifetime\` keeps the inputs around for the queries that are still reading them.`,
      },
      {
        heading: 'The pool is shared, and that is the trap',
        body: `\`background_pool_size\` slots are shared between merges, mutations and TTL merges. A large \`ALTER … UPDATE\` therefore makes the part count climb, because the merges it displaced are not running.

Run the "mutation eats the merge pool" scenario and watch that happen with nothing else changed.`,
      },
      {
        heading: 'What the model simplifies',
        body: `The selector is a simplified \`SimpleMergeSelector\`: it scores by total-size-over-largest-member and by count, which gets the *shape* right, but the real one also weighs part age and has separate heuristics for the ranges nearest the write end. \`max_replicated_merges_in_queue\` and the merge-throttling machinery are not modelled.`,
      },
    ],
    metrics: [
      {
        label: 'Running here',
        get: (s) => {
          let n = 0
          for (const m of s.nodes[0].merges) if (m.active) n++
          return String(n)
        },
      },
      { label: 'Cluster-wide', get: (s) => String(s.stats.runningMerges) },
      {
        label: 'Memory held',
        get: (s) => {
          let n = 0
          for (const m of s.nodes[0].merges) if (m.active) n += m.memoryBytes
          return fmtBytes(n)
        },
      },
      { label: 'Rows / s merged', get: (s) => fmtNum(s.stats.mergeRowsPerSec) },
      {
        label: 'Algorithm',
        get: (s) => {
          const m = s.nodes[0].merges.find((x) => x.active)
          return m ? m.algorithm : '—'
        },
      },
      {
        label: 'Parts merged',
        get: (s) => fmtNum(acrossPrimaries((i) => s.nodes[i].tables.reduce((a, t) => a + t.partsMerged, 0))),
      },
    ],
    knobs: ['mergePoolSize', 'maxBytesToMergeGib', 'insertBlockRows', 'runningMutation'],
    see: ['node.yard', 'node.ttl', 'node.mutations', 'node.queue'],
    refs: {
      docs: [
        { label: 'ClickHouse — MergeTree settings', url: 'https://clickhouse.com/docs/operations/settings/merge-tree-settings' },
        { label: 'ClickHouse — OPTIMIZE TABLE', url: 'https://clickhouse.com/docs/sql-reference/statements/optimize' },
      ],
      source: [
        {
          label: 'src/Storages/MergeTree/MergeSelectors/SimpleMergeSelector.cpp',
          url: 'https://github.com/ClickHouse/ClickHouse/blob/master/src/Storages/MergeTree/MergeSelectors/SimpleMergeSelector.cpp',
          symbol: 'SimpleMergeSelector::select',
        },
        {
          label: 'src/Storages/MergeTree/MergeTreeDataMergerMutator.cpp',
          url: 'https://github.com/ClickHouse/ClickHouse/blob/master/src/Storages/MergeTree/MergeTreeDataMergerMutator.cpp',
          symbol: 'selectPartsToMerge',
        },
      ],
      systemTables: [{ label: 'system.merges' }, { label: 'system.part_log' }, { label: 'system.merge_tree_settings' }],
    },
  },

  /* ======================================================================
   * TTL
   * ====================================================================*/
  {
    id: 'node.ttl',
    title: 'TTL works',
    subtitle: 'a TTL merge rewrites the part without the expired rows',
    tldr: 'TTL does not delete rows. It schedules a merge whose output is the part minus the dead rows.',
    sections: [
      {
        heading: 'Why removing a row is expensive',
        body: `A part is a directory, and there is no such thing as modifying one. So \`TTL ts + INTERVAL 2 MINUTE DELETE\` cannot delete anything in place. What it does is schedule a **merge** whose input is one part and whose output is the same part without the expired rows.

Every surviving row is read, decompressed, sorted, recompressed and written. To remove 5% of a part you rewrite 95% of it.

This is the single most surprising cost in a ClickHouse deployment with a TTL, and it is why the furnace here sits next to the merge gantry rather than somewhere else: it is the same machinery.`,
      },
      {
        heading: 'rows_written < rows_read',
        body: `A TTL merge is the only kind whose output has fewer rows than its input. That inequality in \`system.part_log\` is how you identify one after the fact, and \`system.merges.is_ttl_delete\` is how you spot one while it runs.`,
      },
      {
        heading: 'A wholly-expired part is free',
        body: `When **every** row in a part is past its TTL there is nothing to keep. With \`ttl_only_drop_parts = 1\` ClickHouse does not rewrite it — it deletes the directory. One \`rmdir\` instead of a full rewrite of the part.

In the yard, a part shifts toward the TTL colour in proportion to how much of it has expired. A fully pink tower is one that can be dropped for free. A half-pink one has to be rewritten.`,
      },
      {
        heading: 'Which is why the partition key should match the TTL',
        body: `**This is the whole design lesson.** Partition by the same time granularity your TTL uses — \`PARTITION BY toDate(ts)\` with \`TTL ts + INTERVAL 30 DAY\` — and every expiry becomes a wholly-expired partition: a drop, not a rewrite.

Partition by something else, or by nothing, and you pay a full rewrite of live data every time the TTL fires, forever.`,
      },
      {
        heading: 'merge_with_ttl_timeout is the throttle',
        body: `Without it, a large part whose rows are slowly expiring would be selected for a TTL merge, rewritten, and then be eligible again a second later — rewriting a hundred gigabytes repeatedly to remove a handful of rows each time.

\`merge_with_ttl_timeout\` is the minimum gap between TTL merges of the same part. The real default is 14400 seconds (four hours). This model ships 20 seconds, because a TTL you cannot watch teaches nothing — and that is a deliberate distortion, not a recommendation.`,
      },
      {
        heading: 'DELETE is not the only action',
        body: `\`TTL ts + INTERVAL 7 DAY TO VOLUME 'cold'\` moves the part instead of emptying it. \`TO DISK\` names a disk rather than a volume. \`RECOMPRESS CODEC(ZSTD(9))\` rewrites it with a heavier codec — cheaper to store, more expensive to read.

\`GROUP BY\` is the interesting one: \`TTL ts + INTERVAL 1 DAY GROUP BY metric SET value = avg(value)\` **rolls up** expiring rows instead of discarding them, which is how you keep a year of hourly data and a decade of daily data in one table.

Turn on "Move to cold volume" in the console and watch a part change volume rather than shrink.`,
      },
      {
        heading: 'What the model simplifies',
        body: `A part's TTL range is derived from when it was written plus the table's TTL interval, rather than from real per-row \`ts\` values. \`GROUP BY\` and \`RECOMPRESS\` actions are described but only \`DELETE\` and \`TO VOLUME\` are drawn. Column-level TTL is not modelled.`,
      },
    ],
    metrics: [
      {
        label: 'Parts wholly expired',
        get: (s) => {
          let n = 0
          for (const t of s.nodes[0].tables) n += t.expiredParts
          return String(n)
        },
      },
      {
        label: 'TTL merges running',
        get: (s) => {
          let n = 0
          for (const nd of s.nodes)
            for (const m of nd.merges)
              if (m.active && (m.reason === 'ttl_delete' || m.reason === 'ttl_recompress')) n++
          return String(n)
        },
      },
      {
        label: 'merge_with_ttl_timeout',
        get: (s) => `${s.knobs.mergeWithTtlTimeout} s`,
        hint: 'the real default is 14400 s; this model compresses it so you can watch',
      },
      { label: 'TTL rule', get: () => TABLES[1].ttl ?? '—' },
      {
        label: 'Parts dropped',
        get: (s) => fmtNum(acrossPrimaries((i) => s.nodes[i].tables.reduce((a, t) => a + t.partsDropped, 0))),
      },
    ],
    knobs: ['ttlEnabled', 'ttlMoveToCold', 'mergeWithTtlTimeout', 'insertsPerSec'],
    see: ['node.merges', 'node.volumes', 'node.yard'],
    refs: {
      docs: [
        { label: 'ClickHouse — TTL for columns and tables', url: 'https://clickhouse.com/docs/engines/table-engines/mergetree-family/mergetree#table_engine-mergetree-ttl' },
        { label: 'ClickHouse — Managing data with TTL', url: 'https://clickhouse.com/docs/guides/developer/ttl' },
      ],
      systemTables: [{ label: 'system.merges — is_ttl_delete' }, { label: 'system.part_log' }],
    },
  },

  /* ======================================================================
   * Storage tiers
   * ====================================================================*/
  {
    id: 'node.volumes',
    title: 'storage_policy',
    subtitle: 'hot local SSD over cold object storage',
    tldr: 'A part lives on a volume, and a TTL rule can move it.',
    sections: [
      {
        heading: 'Volumes and disks',
        body: `A \`storage_policy\` is an ordered list of volumes; each volume is a list of disks. A new part goes on the first volume with room, and \`move_factor\` decides when the server starts moving parts off a volume that is filling up.

Here: **hot**, a 400 GiB local SSD, and **cold**, S3. The narrow towers in the yard are the parts that have moved to cold — same data, in a place with less bandwidth.`,
      },
      {
        heading: 'Object storage has bandwidth but not IOPS',
        body: `That asymmetry is the whole engineering problem. A large sequential scan of a cold part is perhaps a third the speed of a hot one; a query that needs many small random reads — a mark-cache miss on a cold part, say — is far worse than that.

So the TTL rule that moves data to cold has to be written around the partition key: you want the cold parts to be the ones nobody queries.`,
      },
      {
        heading: 'The point is the bill',
        body: `Twenty terabytes of object storage costs a fraction of four hundred gigabytes of local SSD. \`storage_policy\` is a cost decision that happens to be expressible as a TTL rule, and the query slowdown is what you are buying with the saving.`,
      },
    ],
    metrics: [
      { label: 'Hot used', get: (s) => fmtBytes(s.nodes[0].volumes[0].usedBytes) },
      { label: 'Hot total', get: (s) => fmtBytes(s.nodes[0].volumes[0].totalBytes) },
      { label: 'Cold used', get: (s) => fmtBytes(s.nodes[0].volumes[1].usedBytes) },
      { label: 'Hot load', get: (s) => `${(s.nodes[0].volumes[0].load * 100).toFixed(0)}%` },
    ],
    knobs: ['ttlMoveToCold', 'ttlEnabled', 'mergeWithTtlTimeout'],
    see: ['node.ttl', 'node.yard'],
    refs: {
      docs: [
        { label: 'ClickHouse — Multiple block devices for data storage', url: 'https://clickhouse.com/docs/engines/table-engines/mergetree-family/mergetree#table_engine-mergetree-multiple-volumes' },
      ],
      systemTables: [{ label: 'system.disks' }, { label: 'system.storage_policies' }, { label: 'system.moves' }],
    },
  },

  /* ======================================================================
   * Mutations
   * ====================================================================*/
  {
    id: 'node.mutations',
    title: 'system.mutations',
    subtitle: 'ALTER UPDATE / DELETE — it rewrites whole parts',
    tldr: 'An UPDATE is a background job that rewrites every part that could match.',
    sections: [
      {
        heading: 'It is not an UPDATE',
        body: `\`ALTER TABLE hits UPDATE RegionID = 0 WHERE CounterID = 57\` does not modify anything. It writes a **mutation entry** and returns. A background job then rewrites every part that could contain a matching row into a new part with a \`_<mutation_version>\` suffix.

Read the part names: \`20260701_1_9_2\` becomes \`20260701_1_9_2_43\`. Same block range, same merge level, new mutation version. That trailing number is the only difference between the old rows and the new ones.`,
      },
      {
        heading: 'It uses the merge pool',
        body: `The same \`background_pool_size\` slots. While a large mutation runs, the merges that would have consolidated your level-0 parts are not running, and the part count climbs even though nothing changed about the insert rate.

That is the coupling worth internalising: a mutation is not a free background nicety, it is a claim on the resource that keeps the table readable.`,
      },
      {
        heading: 'Which is why you batch them',
        body: `Ten separate \`ALTER … UPDATE\` statements rewrite every part ten times. One \`ALTER\` with ten \`SET\` clauses rewrites it once.

\`system.mutations\` tells you which of the two you did, and \`parts_to_do\` tells you how far from finished it is.`,
      },
      {
        heading: 'Stuck mutations',
        body: `A mutation that cannot proceed does not fail loudly — it sits there with \`is_done = 0\` and \`latest_fail_reason\` set. The classic causes are a Keeper session it cannot read the entry through, a part that no active replica has, and an expression that throws on some rows.

Turn Keeper off while a mutation runs and watch the shed report exactly that.`,
      },
      {
        heading: 'Lightweight DELETE is different',
        body: `\`DELETE FROM t WHERE …\` (the lightweight form) writes a \`_row_exists\` mask instead of rewriting the parts, and the rows are physically removed by a later merge. Far cheaper to issue, and it moves the cost into the merge you were going to pay for anyway. It is not modelled here.`,
      },
    ],
    metrics: [
      {
        label: 'Mutation',
        get: (s) => {
          const m = s.nodes[0].mutations.find((x) => x.state === 'running')
          return m ? m.id : 'none'
        },
      },
      {
        label: 'Parts done',
        get: (s) => {
          const m = s.nodes[0].mutations.find((x) => x.state === 'running')
          return m ? `${m.partsDone} / ${m.partsToDo}` : '—'
        },
      },
      {
        label: 'Fail reason',
        get: (s) => {
          const m = s.nodes[0].mutations.find((x) => x.state === 'running')
          return m && m.failReason ? m.failReason : '—'
        },
      },
    ],
    knobs: ['runningMutation', 'mergePoolSize', 'keeperConnected'],
    see: ['node.merges', 'node.yard'],
    refs: {
      docs: [
        { label: 'ClickHouse — ALTER UPDATE', url: 'https://clickhouse.com/docs/sql-reference/statements/alter/update' },
        { label: 'ClickHouse — Lightweight DELETE', url: 'https://clickhouse.com/docs/sql-reference/statements/delete' },
      ],
      systemTables: [{ label: 'system.mutations' }],
    },
  },

  /* ======================================================================
   * Replication
   * ====================================================================*/
  {
    id: 'node.queue',
    title: 'system.replication_queue',
    subtitle: 'what this replica has been told to do and has not done yet',
    tldr: 'ReplicatedMergeTree has no primary. Every replica executes the same log.',
    sections: [
      {
        heading: 'There is no primary',
        body: `Every replica of a \`ReplicatedMergeTree\` watches \`/clickhouse/tables/{shard}/{table}/log\` in Keeper, copies new entries into its own \`/replicas/{name}/queue\`, and executes them in order. That is the whole of ClickHouse replication.

A write can go to any replica. The replica that receives it allocates a block number from Keeper, writes the part locally, and appends a log entry. Every other replica sees the entry and acts on it.`,
      },
      {
        heading: 'The two entry types that matter',
        body: `**GET_PART** — a new part exists somewhere. This replica **fetches it over HTTP**, replica to replica, directly. Keeper carries the entry, never the data. That is why a large backfill saturates the network between replicas and leaves Keeper idle.

**MERGE_PARTS** — a merge was decided. This replica performs **the same merge itself**, locally. The result is byte-identical on both replicas without ever being transferred, which is why replication traffic does not grow with merge volume — and why a slow replica is slow at merging too.

Also **MUTATE_PART**, **DROP_RANGE** and **ATTACH_PART**. In the rack here, GET_PART is coral, MERGE_PARTS is amber, MUTATE_PART is magenta, and anything that has been retried more than a few times goes red.`,
      },
      {
        heading: 'absolute_delay is a time, not a byte count',
        body: `It is the age of the oldest entry this replica has not yet executed. That is the number worth alerting on, because it answers the only question that matters: **how stale is a read from this replica?**

A byte-lag figure cannot answer that. Neither can \`log_pointer\` on its own.`,
      },
      {
        heading: 'The queue is what fills first',
        body: `A replica that cannot keep up accumulates entries, and every queued entry is a znode Keeper is holding on its behalf. So a chronically lagging replica is a Keeper memory problem as well as a staleness problem.

Run the "one replica falls behind" scenario and watch the rack fill while \`absolute_delay\` climbs.`,
      },
      {
        heading: 'No Keeper session means read-only',
        body: `A \`ReplicatedMergeTree\` INSERT has to allocate its block number from Keeper before it can write. Without a session there is nothing it can do, and the table goes read-only: \`Code: 242. Table is in readonly mode\`.

SELECTs keep working from whatever is already on local disk, which is why a Keeper outage presents as "writes are failing" and takes a while to be recognised as an outage at all. The lamp on the east end of the rack is that session.`,
      },
      {
        heading: 'What the model simplifies',
        body: `Up to four entries execute at once, in queue order, standing in for \`max_replicated_merges_in_queue\` together with the fetch concurrency. A \`MERGE_PARTS\` entry is satisfied by running this replica's own selector on the same table rather than by waiting for the exact named input parts, which is sound only because the model's two replicas cannot disagree about which parts exist.

Quorum inserts, \`ATTACH_PART\` and part-checksum verification on fetch are not modelled.`,
      },
    ],
    metrics: [
      { label: 'Queue size', get: (s) => String(s.nodes[1].replication.queueSize) },
      { label: 'absolute_delay', get: (s) => `${s.nodes[1].replication.absoluteDelay.toFixed(1)} s` },
      { label: 'log_pointer', get: (s) => String(s.nodes[1].replication.logPointer) },
      { label: 'log_max_index', get: (s) => String(s.nodes[1].replication.logMaxIndex) },
      { label: 'Parts fetched', get: (s) => fmtNum(s.nodes[1].replication.partsFetched) },
      { label: 'Parts sent', get: (s) => fmtNum(s.nodes[1].replication.partsSent) },
      { label: 'Worst delay', get: (s) => `${s.stats.maxReplicaDelay.toFixed(1)} s` },
    ],
    knobs: ['slowReplica', 'keeperConnected', 'nodeDown', 'networkLatencyMs', 'insertQuorum'],
    see: ['keeper.ensemble', 'keeper.log', 'node.merges', 'node.clusters'],
    refs: {
      docs: [
        { label: 'ClickHouse — Data replication', url: 'https://clickhouse.com/docs/engines/table-engines/mergetree-family/replication' },
      ],
      source: [
        {
          label: 'src/Storages/MergeTree/ReplicatedMergeTreeLogEntry.h',
          url: 'https://github.com/ClickHouse/ClickHouse/blob/master/src/Storages/MergeTree/ReplicatedMergeTreeLogEntry.h',
          symbol: 'ReplicatedMergeTreeLogEntryData::Type',
        },
      ],
      systemTables: [{ label: 'system.replication_queue' }, { label: 'system.replicas' }, { label: 'system.replicated_fetches' }],
    },
  },

  /* ======================================================================
   * Keeper
   * ====================================================================*/
  {
    id: 'keeper.ensemble',
    title: 'ClickHouse Keeper',
    subtitle: 'raft quorum — metadata only, and every write depends on it',
    tldr: 'Holds no user data. Holds every block number, log entry and part checksum.',
    sections: [
      {
        heading: 'Small, and load-bearing',
        body: `Three nodes, raft, one leader. This district is deliberately small next to the data islands, and that disproportion is the point: it is a tiny service on which every write in the cluster depends.

Keeper stores **metadata only** — block-number sequences, the replication log, part checksums, mutation entries, and the ephemeral znodes that make up a replica's session. Not one row of user data passes through it.`,
      },
      {
        heading: 'What the halls tell you',
        body: `The leader stands a row forward and is the only node that serves writes; the followers serve reads and vote. The beacon marks the leader, and it moves when an election does.

Nothing else about the three differs, because in raft nothing else does. There is no sharding, no partitioning, no read replica hierarchy — just three copies of the same small state machine.`,
      },
      {
        heading: 'Why znodes are the number to watch',
        body: `The field west of the quorum is the znode count, log-scaled from a hundred to a million because that is the range in which a real Keeper goes from comfortable to out of heap.

It grows with the **part count**: roughly two znodes per part per replica for the checksum, plus one per log entry, plus the block-number sequences. So "too many parts" is a Keeper memory incident as well as a merge one, and that is the half people are surprised by.

Past three quarters of the field the posts warm and then go critical. Keeper's memory is a capacity, not a statistic.`,
      },
      {
        heading: 'When it goes away',
        body: `Every \`ReplicatedMergeTree\` table becomes read-only, because an INSERT cannot allocate a block number. Replicated merges stop, because a merge has to be announced to \`/log\` before it may run — so the part count starts climbing with nothing being inserted.

SELECTs keep working. Turn Keeper off in the console and watch which lamps change and which do not.`,
      },
      {
        heading: 'Operational notes the model cannot show',
        body: `Keeper wants its own disk (the raft log is fsync-bound), its own nodes if the cluster is large, and an odd number of them. Three survives one loss; five survives two. Two survives nothing and is worse than one.

\`ZooKeeper\` and \`ClickHouse Keeper\` are protocol-compatible; Keeper is the one to use for a new deployment.`,
      },
    ],
    metrics: [
      { label: 'Leader', get: (s) => `keeper-${(s.keepers.find((k) => k.role === 'leader')?.slot ?? 0) + 1}` },
      { label: 'znodes', get: (s) => fmtNum(s.keepers[1]?.znodes ?? 0) },
      { label: 'Sessions', get: (s) => String(s.keepers[1]?.sessions ?? 0) },
      { label: 'Requests / s', get: (s) => (s.keepers[1]?.requestsPerSec ?? 0).toFixed(0) },
      { label: 'Log index', get: (s) => String(s.keeperLogIndex) },
      { label: 'Cluster parts', get: (s) => fmtNum(s.stats.activeParts) },
    ],
    knobs: ['keeperConnected', 'networkLatencyMs', 'insertBlockRows'],
    see: ['keeper.log', 'keeper.znodes', 'node.queue'],
    refs: {
      docs: [
        { label: 'ClickHouse — Keeper', url: 'https://clickhouse.com/docs/guides/sre/keeper/clickhouse-keeper' },
      ],
      systemTables: [{ label: 'system.zookeeper' }, { label: 'system.zookeeper_connection' }],
    },
  },

  {
    id: 'keeper.log',
    title: '/log',
    subtitle: 'the one place every replica learns what to do',
    tldr: '/clickhouse/tables/{shard}/{table}/log — an ordered list of instructions.',
    sections: [
      {
        heading: 'The stack is the log',
        body: `Newest at the top. Each entry is a few hundred bytes: a type, a part name, and the source replica.

A replica records how far it has read as \`log_pointer\` and copies everything past it into its own queue. There is no push, no fan-out, no leader deciding who gets what — every replica pulls the same ordered list.`,
      },
      {
        heading: 'Trimming, and why a slow replica is expensive',
        body: `\`/log\` is trimmed once every replica has read past an entry. A replica that never catches up therefore pins the whole log, and Keeper's znode count grows without bound.

That is the second reason a chronically lagging replica is an incident and not an inconvenience.`,
      },
      {
        heading: 'Metadata, never data',
        body: `The entry says "part \`20260701_9_9_0\` exists on replica \`ch-s1r1\`". It does not contain the part. The receiving replica fetches it directly from \`ch-s1r1\` over HTTP.

That separation is what lets Keeper run on three small nodes while the replicas move terabytes between themselves.`,
      },
    ],
    metrics: [
      { label: 'Log index', get: (s) => String(s.keeperLogIndex) },
      {
        label: 'Slowest replica',
        get: (s) => {
          let min = Infinity
          for (const n of s.nodes) if (n.replication.logPointer < min) min = n.replication.logPointer
          const behind = Math.max(0, s.keeperLogIndex - (isFinite(min) ? min : s.keeperLogIndex))
          return behind > 0 ? `${behind} entries behind` : 'caught up'
        },
      },
      { label: 'Worst queue', get: (s) => String(s.stats.maxQueueSize) },
    ],
    knobs: ['slowReplica', 'keeperConnected'],
    see: ['keeper.ensemble', 'node.queue'],
    refs: { systemTables: [{ label: 'system.zookeeper WHERE path = …/log' }] },
  },

  {
    id: 'keeper.znodes',
    title: 'znodes',
    subtitle: 'what Keeper holds — and it grows with the part count',
    tldr: 'Keeper memory is a capacity. The part count is what consumes it.',
    sections: [
      {
        heading: 'What is in there',
        body: `Per table per shard: a block-number sequence, the log, a \`/replicas/<name>\` subtree per replica containing that replica's queue and its \`log_pointer\`, and — the big one — a znode per part per replica holding its checksum.

That last item is why the field here is driven by the part count and not by the data volume. Ten thousand small parts cost Keeper the same as ten thousand large ones.`,
      },
      {
        heading: 'The failure it leads to',
        body: `Keeper keeps its whole state in memory. Past a few million znodes it starts to struggle: slower requests, longer election times, and eventually an out-of-memory kill that takes every replicated table in the cluster read-only at once.

The fix is never a bigger Keeper. It is fewer parts — larger INSERT batches, \`async_insert\`, a merge pool that can keep up, and a partition key that does not multiply parts by thirty.`,
      },
    ],
    metrics: [
      { label: 'znodes', get: (s) => fmtNum(s.keepers[1]?.znodes ?? 0) },
      { label: 'Cluster parts', get: (s) => fmtNum(s.stats.activeParts) },
      { label: 'Log index', get: (s) => String(s.keeperLogIndex) },
    ],
    knobs: ['insertBlockRows', 'mergePoolSize', 'asyncInsert'],
    see: ['keeper.ensemble', 'node.yard'],
  },

  /* ======================================================================
   * Odds and ends
   * ====================================================================*/
  {
    id: 'clients.batch',
    title: 'INSERT batch',
    subtitle: 'rows per INSERT — the number that decides everything downstream',
    tldr: 'One INSERT makes at least one part per partition it touches.',
    sections: [
      {
        heading: 'The arithmetic',
        body: `At 40 INSERTs a second of 900 rows each, you create at least 40 parts a second — more if the block straddles partitions. At 4 INSERTs a second of 9000 rows each, the same throughput costs 4.

The merge pool has to consolidate whatever you create. Four threads merging cannot keep pace with forty parts a second arriving, and that is the whole of the "too many parts" story.`,
      },
      {
        heading: 'What to aim for',
        body: `ClickHouse's own guidance: batches of at least a few thousand rows, ideally tens of thousands, and one INSERT per second per table rather than a thousand.

If the client cannot batch, \`async_insert\` moves the batching into the server. If it can, batching in the client is strictly better because the server never has to hold the rows.`,
      },
    ],
    metrics: [
      { label: 'Rows per block', get: (s) => fmtNum(s.knobs.insertBlockRows) },
      { label: 'INSERT / s', get: (s) => s.knobs.insertsPerSec.toFixed(1) },
      {
        label: 'Parts / s created',
        get: (s) => (s.knobs.insertsPerSec * (s.knobs.asyncInsert ? 0.15 : 1.4)).toFixed(1),
      },
      { label: 'Active parts', get: (s) => fmtNum(s.stats.activeParts) },
    ],
    knobs: ['insertBlockRows', 'insertsPerSec', 'asyncInsert', 'asyncInsertMaxDataKib'],
    see: ['clients', 'node.insertdock', 'node.merges'],
  },
]
