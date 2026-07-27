import type { Knobs, TourChapter } from '../core/types'
import { el, icon, setClass, setText } from './uikit'
import type { UiContext, UiModule } from './uikit'

/* ============================================================================
 * THE GUIDED TOUR
 *
 * Fourteen chapters, in the order the mechanisms actually depend on each other:
 * you cannot understand a merge before you understand a part, and you cannot
 * understand the read path before you understand what a part contains.
 *
 * Each chapter frames a component, sets whatever settings make its lesson
 * visible, and narrates. Any user input hands control straight back — the tour
 * is a suggestion, not a cage.
 * ==========================================================================*/

export const CHAPTERS: TourChapter[] = [
  {
    id: 'overview',
    title: 'A ClickHouse cluster',
    body: 'Two shards, two replicas each, and three Keeper nodes. You are standing where a client stands: the application tier in front of you, the four servers across the middle, the metadata that coordinates them furthest away. The geography is the order things happen in.',
    focus: 'cluster',
    duration: 15,
    knobs: { insertsPerSec: 4, insertBlockRows: 100000, selectsPerSec: 6 },
  },
  {
    id: 'clients',
    title: 'The client knows one table and picks a server',
    body: 'The application tier stands outside the cluster. It knows one table name and nothing about shards — but it does choose which server to connect to, and there are four roads out of here because all four will do. The pallet stack on the west dock is the INSERT batch size, the most important number a ClickHouse client controls.',
    focus: 'clients',
    duration: 16,
  },
  {
    id: 'distributed',
    title: 'Distributed is a table on every server',
    body: 'Not a node in front of the cluster — a table created on all four by the same DDL. The one the client connected to becomes the initiator: it fans the statement out, merges what comes back, and answers. Look at the north face of each island: they all have this strip, and which one is lit is the application’s choice, not the cluster’s.',
    focus: 'node.0.dist',
    duration: 18,
  },
  {
    id: 'sharding-key',
    title: 'The sharding key decides everything downstream',
    body: 'The wheel is the sharding expression, and it is identical on every server because it comes from the table definition. A block arrives, the wheel turns, and the block leaves in two pieces. The arc widths are the cumulative share each shard has received, so a badly chosen key becomes visible rather than merely suspected.',
    focus: 'node.0.wheel',
    duration: 17,
  },
  {
    id: 'insert',
    title: 'How a block becomes a part',
    body: 'Sort by the ORDER BY key. Split by the partition expression — and each piece becomes its own part. Compress each column, and each stream within each column, into its own file. Write the marks and the primary index. Then rename the directory into place: that rename is the commit, and it is atomic.',
    focus: 'node.0.insertdock',
    duration: 20,
  },
  {
    id: 'parts',
    title: 'A part is a directory',
    body: 'Height is rows, colour is state. Green is active — the only state a SELECT can see. Grey is outdated: merged away, still on disk because a running query might be reading it. The lit cap is the merge level. Read a part name and you know its partition, its block range and how many times it has been merged.',
    focus: 'node.0.yard',
    duration: 22,
  },
  {
    id: 'primary-index',
    title: 'The primary index is sparse',
    body: 'One sorting-key row per 8192-row granule, which is why it fits in memory and stays there. A binary search over it turns a WHERE on a key prefix into a set of mark ranges. It cannot find a row — only the granule a row must be in. Watch the beam: its height is where the search landed.',
    focus: 'node.0.primaryindex',
    duration: 20,
    knobs: { selectsPerSec: 10, primaryKeyHitRatio: 0.9, partitionPruneRatio: 0.7 },
  },
  {
    id: 'primary-index-miss',
    title: 'And it only works on a key prefix',
    body: 'Now every query filters on a column that is not a sorting-key prefix. The index has nothing to bite on, every granule survives, and the read pool reports granules_after_key equal to granules_total. That is a schema problem, not a tuning one — and it is the most common one there is.',
    focus: 'node.0.readpool',
    duration: 20,
    knobs: { primaryKeyHitRatio: 0, skipIndexUseRatio: 0, partitionPruneRatio: 0.2, selectsPerSec: 10 },
  },
  {
    id: 'skip-index',
    title: 'Skip indexes only remove work',
    body: 'Each shed’s height is the share of blocks its index can actually prune. A minmax on a column correlated with the sorting key prunes almost everything for a few kilobytes. A set() that has overflowed prunes nothing at all and is worse than having no index — and nothing in system.parts will tell you.',
    focus: 'node.0.skipindexes',
    duration: 20,
    knobs: { primaryKeyHitRatio: 0.6, skipIndexUseRatio: 1, selectsPerSec: 9 },
  },
  {
    id: 'read-pool',
    title: 'The read pool, and the phases',
    body: 'Mark ranges are dealt out to max_threads reader threads, biggest first, so they finish together. Each bay’s colour is the phase, and the colours are borrowed from whichever cache decides it: orange for seeking, blue for reading, teal for decompressing. If seeking dominates, your mark cache is too small.',
    focus: 'node.0.readpool',
    duration: 20,
  },
  {
    id: 'mark-cache',
    title: 'The cache nobody sizes',
    body: 'A mark is where in the .bin a granule starts and how far into the decompressed block its first row is. A reader cannot seek without it. On a wide table the mark set runs to gigabytes, and a miss is a real disk seek per stream. Watch the seeking phase take over the reader bays.',
    focus: 'node.0.markcache',
    duration: 20,
    knobs: { markCacheMib: 32, selectsPerSec: 12 },
  },
  {
    id: 'merges',
    title: 'Merges are not an optimisation',
    body: 'Without them the part count grows without bound and every SELECT has to open all of them. The selector looks for ranges of adjacent parts and refuses ranges where one part dominates, because merging a huge part to remove one small one is pure write amplification. The beams show which parts each merge has reserved.',
    focus: 'node.0.merges',
    duration: 22,
    knobs: { markCacheMib: 5120, insertsPerSec: 20, insertBlockRows: 20000, mergePoolSize: 4 },
  },
  {
    id: 'too-many-parts',
    title: 'And this is what happens without them',
    body: 'Forty INSERTs a second of nine hundred rows, and two merge slots. Past parts_to_delay_insert the server starts sleeping before each INSERT on purpose. Past parts_to_throw_insert it refuses with Code 252. The fix is never a higher threshold — it is a bigger batch, or async_insert.',
    focus: 'node.0.yard',
    duration: 22,
    knobs: { insertsPerSec: 40, insertBlockRows: 900, mergePoolSize: 2, asyncInsert: false },
  },
  {
    id: 'ttl',
    title: 'TTL has to rewrite the part',
    body: 'A part is a directory, so a row cannot be deleted from it. TTL schedules a merge whose output is the part minus the expired rows — every surviving row read, sorted and rewritten. Unless the whole part has expired, in which case it is one rmdir. Which is why the partition key should match the TTL.',
    focus: 'node.0.ttl',
    duration: 22,
    knobs: { insertsPerSec: 10, insertBlockRows: 40000, mergePoolSize: 4, ttlEnabled: true, mergeWithTtlTimeout: 8 },
  },
  {
    id: 'replication',
    title: 'Replication is a queue',
    body: 'There is no primary. Every replica reads the same Keeper log and executes it: GET_PART means fetch the part over HTTP from whoever has it, and MERGE_PARTS means do the merge yourself. Keeper carries the instruction, never the data. absolute_delay is the age of the oldest entry a replica has not executed.',
    focus: 'node.1.queue',
    duration: 22,
    knobs: { slowReplica: true, insertsPerSec: 14, insertBlockRows: 60000 },
  },
  {
    id: 'keeper',
    title: 'And it all rests on three small nodes',
    body: 'Keeper holds no user data — only block numbers, the log, and a znode per part per replica. That last item is why "too many parts" is a Keeper memory incident as well as a merge one. Take Keeper away and every replicated table goes read-only while every SELECT keeps working. That is the outage that takes an hour to recognise.',
    focus: 'keeper.ensemble',
    duration: 22,
    knobs: { slowReplica: false, insertsPerSec: 4, insertBlockRows: 100000 },
  },
]

export function createTour(ctx: UiContext): UiModule {
  const mount = document.getElementById('tour-layer')
  if (!mount) return { update() {}, dispose() {} }

  let active = false
  let index = 0
  let elapsed = 0
  /** Settings the tour changed, so leaving restores them. */
  const saved: Partial<Knobs> = {}
  let savedKeys: (keyof Knobs)[] = []

  /* --- the deck ---------------------------------------------------------- */

  const chapterNum = el('span', { class: 'tour-num' })
  const chapterTitle = el('h3', { class: 'tour-title' })
  const chapterBody = el('p', { class: 'tour-body' })
  const barFill = el('i', { class: 'tour-bar__fill' })
  const bar = el('div', { class: 'tour-bar' }, barFill)

  const prevBtn = el(
    'button',
    { class: 'ch-btn ch-btn--icon', type: 'button', title: 'Previous chapter', on: { click: () => go(index - 1) } },
    icon('prev', 12),
  )
  const nextBtn = el(
    'button',
    { class: 'ch-btn ch-btn--icon', type: 'button', title: 'Next chapter', on: { click: () => go(index + 1) } },
    icon('next', 12),
  )
  const stopBtn = el(
    'button',
    { class: 'ch-btn', type: 'button', title: 'Leave the tour', on: { click: () => stop() } },
    icon('close', 12),
    el('span', { text: 'Leave' }),
  )

  const steps = el('div', { class: 'tour-steps' })
  const stepDots: HTMLElement[] = []
  for (let i = 0; i < CHAPTERS.length; i++) {
    const dot = el('button', {
      class: 'tour-step',
      type: 'button',
      title: CHAPTERS[i].title,
      'aria-label': CHAPTERS[i].title,
      on: { click: () => go(i) },
    })
    steps.append(dot)
    stepDots.push(dot)
  }

  const card = el(
    'div',
    { class: 'tour-card ch-panel' },
    el('div', { class: 'tour-card__head' }, chapterNum, el('span', { class: 'chc-spacer' }), prevBtn, nextBtn, stopBtn),
    chapterTitle,
    chapterBody,
    bar,
    steps,
  )
  card.hidden = true
  mount.append(card)

  /* --- chapter transitions ----------------------------------------------- */

  /**
   * Reading or writing a knob whose key is a *union* of keys collapses its value
   * type to `never` under `strict`. These two helpers are the one place that is
   * bridged; everything else in this file stays generic over a single key.
   */
  type LooseKnobs = Record<keyof Knobs, unknown>
  const setLoose = (key: keyof Knobs, value: unknown): void => {
    ;(ctx.sim.setKnob as unknown as (k: keyof Knobs, v: unknown) => void)(key, value)
  }

  function applyKnobs(chapter: TourChapter): void {
    if (!chapter.knobs) return
    for (const key of Object.keys(chapter.knobs) as (keyof Knobs)[]) {
      // Remember the value from *before the tour started*, not from before this
      // chapter, so leaving at chapter 12 restores what the visitor had.
      if (!savedKeys.includes(key)) {
        savedKeys.push(key)
        ;(saved as LooseKnobs)[key] = (ctx.sim.state.knobs as LooseKnobs)[key]
      }
      const v = (chapter.knobs as LooseKnobs)[key]
      if (v !== undefined) setLoose(key, v)
    }
  }

  function go(next: number): void {
    if (next < 0 || next >= CHAPTERS.length) {
      if (next >= CHAPTERS.length) stop()
      return
    }
    index = next
    elapsed = 0
    const chapter = CHAPTERS[index]

    setText(chapterNum, `${index + 1} / ${CHAPTERS.length}`)
    setText(chapterTitle, chapter.title)
    setText(chapterBody, chapter.body)
    for (let i = 0; i < stepDots.length; i++) {
      setClass(stepDots[i], 'is-done', i < index)
      setClass(stepDots[i], 'is-now', i === index)
    }
    prevBtn.disabled = index === 0

    applyKnobs(chapter)
    if (chapter.scenario !== undefined) ctx.sim.runScenario(chapter.scenario)
    if (chapter.focus) {
      ctx.bus.emit('focus', { id: chapter.focus })
      ctx.bus.emit('select', { id: chapter.focus })
    } else if (chapter.camera) {
      ctx.bus.emit('focus', { id: null })
    }
    ctx.bus.emit('tour:chapter', { index, total: CHAPTERS.length, title: chapter.title })
  }

  function start(from = 0): void {
    if (active) {
      go(from)
      return
    }
    active = true
    savedKeys = []
    card.hidden = false
    requestAnimationFrame(() => card.classList.add('is-on'))
    document.body.classList.add('ch-tour')
    go(from)
  }

  function stop(): void {
    if (!active) return
    active = false
    card.classList.remove('is-on')
    document.body.classList.remove('ch-tour')
    window.setTimeout(() => {
      if (!active) card.hidden = true
    }, 260)
    // Put back exactly what the visitor had before the tour touched anything.
    for (const key of savedKeys) {
      const v = (saved as LooseKnobs)[key]
      if (v !== undefined) setLoose(key, v)
    }
    savedKeys = []
    ctx.sim.runScenario(null)
    ctx.bus.emit('tour:stop', {})
    ctx.bus.emit('select', { id: null })
    ctx.bus.emit('focus', { id: null })
  }

  /* --- wiring ------------------------------------------------------------ */

  const offStart = ctx.bus.on('tour:start', ({ chapter }) => start(chapter ?? 0))
  const offStop = ctx.bus.on('tour:stop', () => {
    /* emitted by stop() itself; nothing more to do */
  })

  function onKeyDown(e: KeyboardEvent): void {
    if (!active) return
    const node = e.target as HTMLElement | null
    if (node && typeof node.tagName === 'string' && (node.tagName === 'INPUT' || node.tagName === 'SELECT')) return
    if (e.key === 'Escape') {
      stop()
      e.preventDefault()
      return
    }
    if (e.key === 'ArrowRight' && e.shiftKey) {
      go(index + 1)
      e.preventDefault()
      return
    }
    if (e.key === 'ArrowLeft' && e.shiftKey) {
      go(index - 1)
      e.preventDefault()
    }
  }
  window.addEventListener('keydown', onKeyDown)

  return {
    update(dt: number, wall?: number) {
      if (!active) return
      // Chapters advance on the WALL clock: a chapter's length is how long a
      // person needs to read it, and it must not stretch when the simulation is
      // slowed down or stop when it is paused.
      elapsed += wall ?? dt
      const chapter = CHAPTERS[index]
      const p = Math.min(1, elapsed / chapter.duration)
      barFill.style.width = `${(p * 100).toFixed(1)}%`
      if (p >= 1) go(index + 1)
    },
    dispose() {
      window.removeEventListener('keydown', onKeyDown)
      offStart()
      offStop()
      card.remove()
      document.body.classList.remove('ch-tour')
    },
  }
}
