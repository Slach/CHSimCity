import { cssColor } from '../core/theme'
import { el, icon, physicalKey } from './uikit'
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
  ['Two-finger scroll', 'Up and down zooms · sideways pans, by the distance a drag would'],
  ['Pinch', 'Zoom, on a trackpad or a touchscreen'],
  ['Touch', '1 finger pans · 2 fingers pinch to zoom, twist to turn'],
  ['Click', 'Select a structure · double-click to fly to it'],
  ['W A S D / arrows', 'Move'],
  ['PageUp / PageDown', 'Change altitude'],
  ['Shift · Alt', 'Boost · precision'],
]

const KEYS: [string, string][] = [
  ['F', 'Fly mode on and off. Click the scene to capture the mouse; Esc gives it back'],
  ['Esc', 'Release the mouse · press again to leave fly mode'],
  ['H', 'Back to the establishing shot'],
  ['T', 'Guided tour'],
  ['/ or Ctrl-K', 'Search every component, setting and scenario'],
  ['?', 'This panel'],
  ['K or P', 'Pause / resume'],
  [', .', 'Slower / faster'],
  ['N', 'Day / night'],
  ['R', 'Reset the cluster'],
  ['1 – 7', 'Jump: clients, a Distributed table, the four servers, Keeper'],
]

/** In fly mode the movement keys mean something the orbit list does not cover. */
const FLY_KEYS: [string, string][] = [
  ['W A S D', 'Move, relative to where you are looking'],
  ['Space · C', 'Rise · descend, always world-vertical'],
  ['Wheel · pinch', 'Move along the way you are looking'],
  ['Shift-wheel', 'Change how fast W A S D move you'],
  ['Shift · Alt', 'Boost · precision'],
]

/** The map is small and does more than it looks like it does. */
const MAP_NOTES: [string, string][] = [
  ['Click a district', 'Fly to it'],
  ['Click the ground', 'Back to the establishing shot'],
  ['Island colour', 'Its own, unless that node is in trouble: parts, replica delay, read-only, down'],
  ['Cone', 'Where you are and what you can see — pinned to the edge when you are outside the map'],
  ['N ▲', 'North. The plan never rotates with you'],
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
  ['distributed', 'Distributed', 'the routing table every server has'],
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
      el(
        'section',
        { class: 'help__sec' },
        el('span', { class: 'ch-eyebrow', text: 'Keys' }),
        el('p', {
          class: 'ch-hint',
          text: 'Shortcuts follow the physical key, not the character it prints, so they work on any keyboard layout.',
        }),
        keyTable(KEYS),
      ),
      el('section', { class: 'help__sec' }, el('span', { class: 'ch-eyebrow', text: 'In fly mode' }), keyTable(FLY_KEYS)),
      el('section', { class: 'help__sec' }, el('span', { class: 'ch-eyebrow', text: 'The minimap' }), keyTable(MAP_NOTES)),
    ),
  )

  mount.append(card)

  let open = false

  function setOpen(next: boolean): void {
    open = next
    mount.hidden = !next
    if (next) {
      // `hidden` really does mean `display: none` now, and a transition cannot
      // run in the frame an element stops being display:none. Both the fade and
      // the focus therefore wait for the next one.
      requestAnimationFrame(() => {
        mount.classList.add('is-on')
        closeBtn.focus()
      })
    } else {
      mount.classList.remove('is-on')
    }
  }

  setOpen(false)

  function onKeyDown(e: KeyboardEvent): void {
    const node = e.target as HTMLElement | null
    const typing =
      node &&
      typeof node.tagName === 'string' &&
      (node.tagName === 'INPUT' || node.tagName === 'TEXTAREA' || node.isContentEditable === true)
    if (typing) return
    // `?` is Shift and the physical `/` key. Asking for the character instead
    // meant this never fired on a layout where that key prints something else.
    if (physicalKey(e) === '/' && e.shiftKey) {
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
