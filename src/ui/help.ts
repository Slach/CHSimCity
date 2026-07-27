import { cssColor } from '../core/theme'
import { el, icon } from './uikit'
import type { UiContext, UiModule } from './uikit'

/* ============================================================================
 * HELP — the keyboard map and the colour legend.
 *
 * The legend is the more important half. Colour in this cluster is semantic and
 * never decorative, so a viewer who has not been told the code is missing most
 * of what is on screen — above all that a part's colour IS its
 * `system.parts.state`.
 * ==========================================================================*/

const CAMERA_KEYS: [string, string][] = [
  ['Left-drag', 'Pan — grab the ground and move it, the way a map does'],
  ['Shift-drag / middle-drag', 'Orbit around the cluster'],
  ['Wheel', 'Zoom — the dolly follows the cursor, not the pivot'],
  ['Touch', '1 finger pans · 2 fingers pinch to zoom, twist to turn'],
  ['Click', 'Select a structure · double-click to fly to it'],
  ['W A S D / arrows', 'Move'],
  ['PageUp / PageDown', 'Change altitude'],
  ['Shift · Alt', 'Boost · precision'],
]

const KEYS: [string, string][] = [
  ['F', 'Fly mode. Click the scene to capture the mouse; Esc gives it back'],
  ['Esc', 'Release the mouse · press again to leave fly mode'],
  ['H', 'Back to the establishing shot'],
  ['T', 'Guided tour'],
  ['/ or Ctrl-K', 'Search every component, setting and scenario'],
  ['?', 'This panel'],
  ['K or P', 'Pause / resume'],
  [', .', 'Slower / faster'],
  ['N', 'Day / night'],
  ['R', 'Reset the cluster'],
  ['1 – 7', 'Jump: clients, initiator, the four nodes, Keeper'],
]

/** In fly mode the movement keys mean something the orbit list does not cover. */
const FLY_KEYS: [string, string][] = [
  ['W A S D', 'Move, relative to where you are looking'],
  ['Space · C', 'Rise · descend, always world-vertical'],
  ['Wheel', 'Change speed — it does not zoom in fly mode'],
  ['Shift · Alt', 'Boost · precision'],
]

/** The map is small and does more than it looks like it does. */
const MAP_NOTES: [string, string][] = [
  ['Click', 'Fly to that district'],
  ['Island fill', 'That node’s worst signal: parts, replica delay, read-only, down'],
  ['Cone', 'Where you are and what you can see'],
  ['Arrowhead', 'You are off the edge of the map, looking that way'],
]

/**
 * The legend. The five part states come first and are separated from everything
 * else, because they are the code that carries the most information and the one
 * a viewer is most likely to misread as decoration.
 */
const PART_STATES: [string, string, string][] = [
  ['partActive', 'active', 'the only state a SELECT can see'],
  ['partOutdated', 'outdated', 'merged away, still on disk for running queries'],
  ['partPreactive', 'preactive', 'renamed into place, being committed'],
  ['partTemporary', 'temporary', 'still tmp_insert_…, invisible to everybody'],
  ['partExpired', 'expired', 'every row past its TTL'],
]

const LEGEND: [string, string, string][] = [
  ['primaryIndex', 'primary index', 'primary.cidx — one key row per granule'],
  ['skipIndex', 'skip indexes', 'skp_idx_*.idx2 — they only remove work'],
  ['markCache', 'mark cache', '.mrk3 offsets, and the seeking phase'],
  ['blockCache', 'uncompressed cache', 'decompressed blocks'],
  ['reader', 'reader threads', 'MergeTreeReadPool'],
  ['merge', 'merges', 'the background pool'],
  ['mutation', 'mutations', 'ALTER UPDATE / DELETE'],
  ['ttl', 'TTL', 'removing or moving expired rows'],
  ['replication', 'replication', 'the Keeper log and the queue'],
  ['fetch', 'part fetch', 'a part crossing the wire between replicas'],
  ['keeper', 'Keeper', 'metadata, and never data'],
  ['hot', 'hot volume', 'local SSD'],
  ['cold', 'cold volume', 'object storage'],
  ['distributed', 'Distributed', 'the initiator and its routing'],
  ['client', 'clients', 'the application tier'],
]

export function createHelp(ctx: UiContext): UiModule {
  const overlay = document.getElementById('help-overlay')
  if (!overlay) return { update() {}, dispose() {} }
  // A local const, not the possibly-null lookup: the closures below outlive the
  // guard above and TypeScript will not carry the narrowing into them.
  const mount: HTMLElement = overlay

  mount.className = 'help'
  mount.setAttribute('role', 'dialog')
  mount.setAttribute('aria-modal', 'true')
  mount.setAttribute('aria-label', 'Keyboard map and colour legend')

  function keyTable(rows: [string, string][]): HTMLElement {
    const table = el('div', { class: 'help-keys' })
    for (const [k, v] of rows) {
      table.append(
        el('div', { class: 'help-keys__row' }, el('span', { class: 'ch-kbd', text: k }), el('span', { text: v })),
      )
    }
    return table
  }

  function swatches(rows: [string, string, string][]): HTMLElement {
    const list = el('div', { class: 'help-legend' })
    for (const [key, name, why] of rows) {
      const dot = el('span', { class: 'help-legend__dot' })
      dot.style.background = cssColor(key as never)
      list.append(
        el(
          'div',
          { class: 'help-legend__row' },
          dot,
          el('span', { class: 'help-legend__n', text: name }),
          el('span', { class: 'help-legend__w', text: why }),
        ),
      )
    }
    return list
  }

  const closeBtn = el(
    'button',
    {
      class: 'ch-btn ch-btn--icon help__x',
      type: 'button',
      title: 'Close',
      'aria-label': 'Close',
      on: { click: () => setOpen(false) },
    },
    icon('close', 13),
  )

  const card = el(
    'div',
    { class: 'help__card ch-panel' },
    el(
      'header',
      { class: 'ch-panel__head' },
      el('div', {}, el('h2', { class: 'ch-title', text: 'Controls and colour' }), el('p', { class: 'ch-sub', text: 'Colour in this cluster is semantic and never decorative' })),
      el('span', { class: 'chc-spacer' }),
      closeBtn,
    ),
    el(
      'div',
      { class: 'help__body ch-scroll' },
      el(
        'section',
        { class: 'help__sec' },
        el('span', { class: 'ch-eyebrow', text: 'A part’s colour is its state' }),
        el('p', { class: 'ch-hint', text: 'system.parts.state, and nothing else in the cluster uses these five colours.' }),
        swatches(PART_STATES),
      ),
      el(
        'section',
        { class: 'help__sec' },
        el('span', { class: 'ch-eyebrow', text: 'Everything else' }),
        swatches(LEGEND),
      ),
      el('section', { class: 'help__sec' }, el('span', { class: 'ch-eyebrow', text: 'Camera' }), keyTable(CAMERA_KEYS)),
      el('section', { class: 'help__sec' }, el('span', { class: 'ch-eyebrow', text: 'Keys' }), keyTable(KEYS)),
      el('section', { class: 'help__sec' }, el('span', { class: 'ch-eyebrow', text: 'In fly mode' }), keyTable(FLY_KEYS)),
      el('section', { class: 'help__sec' }, el('span', { class: 'ch-eyebrow', text: 'The minimap' }), keyTable(MAP_NOTES)),
    ),
  )

  mount.append(card)

  let open = false

  function setOpen(next: boolean): void {
    open = next
    mount.hidden = !next
    mount.classList.toggle('is-on', next)
    if (next) closeBtn.focus()
  }

  setOpen(false)

  function onKeyDown(e: KeyboardEvent): void {
    const node = e.target as HTMLElement | null
    const typing =
      node &&
      typeof node.tagName === 'string' &&
      (node.tagName === 'INPUT' || node.tagName === 'TEXTAREA' || node.isContentEditable === true)
    if (typing) return
    if (e.key === '?' || (e.key === '/' && e.shiftKey)) {
      setOpen(!open)
      e.preventDefault()
      return
    }
    if (e.key === 'Escape' && open) {
      setOpen(false)
      e.preventDefault()
    }
  }

  function onRequest(): void {
    setOpen(!open)
  }

  function onBackdrop(e: MouseEvent): void {
    if (e.target === mount) setOpen(false)
  }

  window.addEventListener('keydown', onKeyDown)
  window.addEventListener('chsimcity:help', onRequest)
  mount.addEventListener('click', onBackdrop)

  void ctx

  return {
    update() {},
    dispose() {
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('chsimcity:help', onRequest)
      mount.removeEventListener('click', onBackdrop)
      card.remove()
      mount.hidden = true
    },
  }
}
