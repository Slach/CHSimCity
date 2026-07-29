import type {
  ComponentDef,
  ComponentDoc,
  ComponentKind,
  DocRef,
  DocReferences,
  FlowKind,
  Knobs,
  RouteDef,
  RouteEnd,
  SimState,
} from '../core/types'
import { flowAxisColorKey } from '../core/types'
import { COLOR } from '../core/theme'
import { ROUTES } from '../world/layout'
import { doc, knobMeta, mdToHtml } from './content'
import { createCollapse, createKnobControl, loadFlag, saveFlag } from './controls'
import type { KnobControl } from './controls'
import { clear, el, icon, metricTile, setClass, setText } from './uikit'
import type { UiContext, UiModule } from './uikit'

/* ============================================================================
 * THE INSPECTOR (#hud-right)
 *
 * One component at a time: what it is, what it is doing right now, and the
 * settings that change its behaviour. Live numbers sit above the prose because
 * they are the reason any of the prose is interesting.
 * ==========================================================================*/

/** Metric and readout refresh rate. Text at 6 Hz reads as continuous. */
const TICK = 1 / 6

const SUGGESTIONS = ['node.0.yard', 'node.0.primaryindex', 'node.0.merges', 'node.0.ttl', 'keeper.ensemble']

const OPEN_KEY = 'chsimcity.inspector.open'

const KIND_HINTS: [RegExp, ComponentKind][] = [
  [/^clients/, 'client'],
  [/markcache|uncompressedcache|primaryindex|znodes/, 'memory'],
  [/insertdock|readpool|merges|ttl|mutations|keeper\.\d|keeper\.ensemble/, 'process'],
  [/yard|volumes|skipindexes/, 'storage'],
  [/^dist|queue|^keeper\.log/, 'network'],
]

function inferKind(id: string): ComponentKind {
  for (const [re, kind] of KIND_HINTS) if (re.test(id)) return kind
  return 'concept'
}

const hex6 = (c: number): string => `#${(c >>> 0).toString(16).padStart(6, '0').slice(-6)}`

/* ---------------------------------------------------------------------------
 * Prose. mdToHtml handles the inline marks; paragraphs are real elements so
 * they can have real spacing.
 * -------------------------------------------------------------------------*/

function proseBody(text: string): HTMLElement {
  const wrap = el('div', { class: 'ch-body chc-prose' })
  for (const para of text.split(/\n{2,}/)) {
    const t = para.trim()
    if (t) wrap.append(el('p', { class: 'chc-p', html: mdToHtml(t) }))
  }
  return wrap
}

/* ---------------------------------------------------------------------------
 * References — the reading list behind each component.
 *
 * Everything here is checkable: a documentation page, a file in the ClickHouse
 * tree, a system table. That is the point, so the renderer never dresses up a
 * reference as something it is not. No URL means no link.
 * -------------------------------------------------------------------------*/

function refLine(r: DocRef): HTMLElement {
  const li = el('li', { class: 'chc-src__i' })
  li.append(
    r.url
      ? el('a', { class: 'chc-ref__a', href: r.url, target: '_blank', rel: 'noopener noreferrer', text: r.label })
      : el('span', { class: 'chc-ref__t', text: r.label }),
  )
  if (r.symbol) li.append(document.createTextNode(' '), el('span', { class: 'chc-ref__sym ch-mono', text: r.symbol }))
  return li
}

function refGroup(heading: string, items: HTMLElement[]): HTMLElement | null {
  if (!items.length) return null
  return el(
    'div',
    { class: 'chc-ref__g' },
    el('span', { class: 'ch-eyebrow', text: heading }),
    el('ul', { class: 'chc-src' }, ...items),
  )
}

function renderRefs(refs: DocReferences): HTMLElement | null {
  const groups = [
    refGroup('Documentation', (refs.docs ?? []).map(refLine)),
    refGroup('Source', (refs.source ?? []).map(refLine)),
    refGroup('See it live', (refs.systemTables ?? []).map(refLine)),
  ].filter((g): g is HTMLElement => g != null)
  if (!groups.length) return null

  const block = el('div', { class: 'chc-block' }, el('span', { class: 'ch-eyebrow', text: 'Go deeper' }))
  block.append(el('div', { class: 'ch-body' }, ...groups))
  return block
}

/* ===========================================================================
 * createInspector
 * =========================================================================*/

export function createInspector(ctx: UiContext): UiModule {
  const mount = document.getElementById('hud-right')
  if (!mount) {
    console.warn('[CHSimCity] #hud-right is missing — the inspector has nowhere to live')
    return { update() {}, dispose() {} }
  }

  const host = el('div', { class: 'chc-host chc-host--right' })

  /* --- header ------------------------------------------------------------ */

  const kindBadge = el('span', { class: 'chc-kind' })
  const title = el('h2', { class: 'ch-title', text: 'Nothing selected' })
  const subtitle = el('p', { class: 'ch-sub', text: 'Click a structure to open it up' })
  const readout = el('p', { class: 'chc-readout' })

  const flyBtn = el(
    'button',
    {
      class: 'ch-btn',
      type: 'button',
      title: 'Fly the camera to this component',
      on: { click: () => currentId && ctx.bus.emit('focus', { id: currentId }) },
    },
    icon('camera', 13),
    el('span', { text: 'Fly to' }),
  )

  const closeBtn = el(
    'button',
    {
      class: 'ch-btn ch-btn--icon',
      type: 'button',
      title: 'Close the inspector',
      'aria-label': 'Close the inspector',
      on: {
        click: () => {
          ctx.bus.emit('select', { id: null })
          setOpen(false)
        },
      },
    },
    icon('close', 13),
  )

  const head = el(
    'header',
    { class: 'ch-panel__head chc-insp__head' },
    el('div', { class: 'chc-insp__top' }, kindBadge, el('span', { class: 'chc-spacer' }), flyBtn, closeBtn),
    title,
    subtitle,
    readout,
  )

  /* --- body -------------------------------------------------------------- */

  const body = el('div', { class: 'ch-panel__body ch-scroll', tabindex: '0' })
  body.setAttribute('role', 'region')
  body.setAttribute('aria-label', 'Component notes')

  const panel = el('section', { class: 'ch-panel chc-panel chc-insp' }, head, body)
  panel.setAttribute('aria-label', 'Inspector')

  const tab = el('button', {
    class: 'ch-btn ch-btn--icon chc-tab chc-tab--right',
    type: 'button',
    on: { click: () => setOpen(!open) },
  })
  tab.append(icon('layers', 15), el('span', { class: 'chc-tab__label', text: 'Inspector' }))

  host.append(tab, panel)
  mount.append(host)

  /* --- open / collapsed state -------------------------------------------- */

  const narrow = window.matchMedia('(max-width: 1180px)')
  let compact = narrow.matches
  let open = loadFlag(OPEN_KEY, false)

  function applyOpen(): void {
    setClass(host, 'is-compact', compact)
    setClass(host, 'is-open', open)
    tab.setAttribute('aria-expanded', String(open))
    tab.title = open ? 'Hide the inspector' : 'Show the inspector'
    tab.setAttribute('aria-label', tab.title)
    panel.setAttribute('aria-hidden', String(!open))
    panel.inert = !open
  }

  function setOpen(next: boolean): void {
    open = next
    saveFlag(OPEN_KEY, next)
    applyOpen()
    ctx.bus.emit('ui:layout', {})
  }

  /* --- live pieces, rebuilt on every selection --------------------------- */

  type Tile = { set(v: string, state?: '' | 'ok' | 'warn' | 'crit'): void; get: (s: SimState) => string }
  let tiles: Tile[] = []
  let knobs: KnobControl[] = []
  let liveDot: HTMLElement | null = null
  /** undefined until the first render, so the empty state is drawn on boot */
  let currentId: string | null | undefined
  /** The route whose packet is on show, if the panel is showing one. */
  let currentFlow: string | null = null
  let currentDef: ComponentDef | undefined
  /** seconds since the last metric refresh; primed so the first frame paints */
  let acc = TICK
  /** which prose sections the user left open, per component, for this session */
  const sectionState = new Map<string, boolean[]>()

  function teardown(): void {
    for (const k of knobs) k.dispose()
    knobs = []
    tiles = []
    liveDot = null
    clear(body)
  }

  /* --- empty state ------------------------------------------------------- */

  function renderEmpty(): HTMLElement {
    const wrap = el('div', { class: 'chc-content ch-enter' })
    wrap.append(
      el('p', {
        class: 'ch-hint',
        text: 'Every structure in this cluster is one real mechanism inside ClickHouse. Open one and it explains itself, with its own live counters and the settings that govern it.',
      }),
    )

    const list = el('div', { class: 'chc-empty__list' })
    for (const id of SUGGESTIONS) {
      const d = ctx.registry.get(id)
      const info = doc(id)
      const name = d?.name ?? info?.title ?? id
      const why = d?.role ?? info?.subtitle ?? ''
      list.append(
        el(
          'button',
          {
            class: 'ch-btn chc-empty__btn',
            type: 'button',
            on: {
              click: () => {
                ctx.bus.emit('focus', { id })
                ctx.bus.emit('select', { id })
              },
            },
          },
          el('span', { class: 'chc-empty__n', text: name }),
          why ? el('span', { class: 'chc-empty__w', text: why }) : null,
        ),
      )
    }
    wrap.append(el('p', { class: 'ch-eyebrow chc-empty__k', text: 'Start here' }), list)

    const keys = el('p', { class: 'chc-empty__keys' })
    keys.append(
      el('span', { class: 'ch-kbd', text: '1' }),
      document.createTextNode('–'),
      el('span', { class: 'ch-kbd', text: '7' }),
      document.createTextNode(' jump between districts · '),
      el('span', { class: 'ch-kbd', text: 'T' }),
      document.createTextNode(' takes the guided tour · '),
      el('span', { class: 'ch-kbd', text: '/' }),
      document.createTextNode(' searches everything'),
    )
    wrap.append(keys)

    wrap.append(
      el('p', { class: 'ch-eyebrow chc-empty__k', text: 'Honesty' }),
      el('p', {
        class: 'ch-hint',
        text: 'This is a model, not an emulator: nothing here parses SQL and no byte of ClickHouse source code runs in your browser. Where it simplifies, the component says so in its own notes. If you find a claim that is wrong, that is the most valuable thing this project can receive.',
      }),
    )
    return wrap
  }

  /* --- populated state --------------------------------------------------- */

  function renderDoc(id: string, info: ComponentDoc | undefined): HTMLElement {
    const wrap = el('div', { class: 'chc-content ch-enter' })

    /* metrics first — the numbers are the reason this feels alive */
    const metrics = info?.metrics ?? []
    if (metrics.length) {
      const dot = el('span', { class: 'chc-live-dot' })
      liveDot = dot
      const grid = el('div', { class: 'ch-metrics' })
      for (const m of metrics) {
        const tile = metricTile(m.label)
        if (m.hint) tile.root.title = m.hint
        grid.append(tile.root)
        tiles.push({ set: tile.set, get: m.get })
      }
      wrap.append(
        el(
          'div',
          { class: 'chc-block' },
          el('div', { class: 'chc-eyebrow-row' }, el('span', { class: 'ch-eyebrow', text: 'Live' }), dot),
          grid,
        ),
      )
    }

    /* prose */
    if (info?.sections?.length) {
      const remembered = sectionState.get(id)
      const flags: boolean[] = []
      const prose = el('div', { class: 'chc-block' })
      info.sections.forEach((section, i) => {
        const sectionOpen = remembered?.[i] ?? i === 0
        flags.push(sectionOpen)
        const collapse = createCollapse(section.heading, {
          open: sectionOpen,
          // `flags` is the array held by sectionState, so this remembers itself.
          onToggle: (next) => {
            flags[i] = next
          },
        })
        collapse.root.classList.add('chc-section')
        collapse.body.append(proseBody(section.body))
        prose.append(collapse.root)
      })
      sectionState.set(id, flags)
      wrap.append(prose)
    } else {
      wrap.append(
        el(
          'div',
          { class: 'chc-block' },
          el('p', { class: 'ch-eyebrow', text: 'No notes' }),
          el('p', {
            class: 'ch-hint',
            text: 'No notes for this one yet. It is a real part of the cluster — it just has not been written up.',
          }),
        ),
      )
    }

    /* inline knobs */
    const keys = (info?.knobs ?? []).filter((k, i, a) => a.indexOf(k) === i) as (keyof Knobs)[]
    if (keys.length) {
      const block = el(
        'div',
        { class: 'chc-block' },
        el('div', { class: 'chc-eyebrow-row' }, el('span', { class: 'ch-eyebrow', text: 'Change it' })),
      )
      let added = 0
      for (const key of keys) {
        const meta = knobMeta(key)
        if (!meta) continue
        const control = createKnobControl(ctx, meta)
        knobs.push(control)
        block.append(control.root)
        added += 1
      }
      if (added) wrap.append(block)
    }

    /* related */
    const see = info?.see ?? []
    if (see.length) {
      const row = el('div', { class: 'chc-see' })
      for (const other of see) {
        // A doc may name a family id (`node.yard`); resolve it to this node's
        // instance so the jump link actually goes somewhere in the scene.
        const target = resolveSeeTarget(id, other)
        const d = ctx.registry.get(target)
        const info2 = doc(target)
        const label = d?.name ?? info2?.title ?? target
        row.append(
          el('button', {
            class: 'ch-btn chc-see__btn',
            type: 'button',
            text: label,
            title: `${target} — click to inspect, double-click to fly there`,
            on: {
              click: () => ctx.bus.emit('select', { id: target }),
              dblclick: () => ctx.bus.emit('focus', { id: target }),
            },
          }),
        )
      }
      wrap.append(
        el('div', { class: 'chc-block' }, el('span', { class: 'ch-eyebrow', text: 'Related' }), row),
      )
    }

    /* references */
    if (info?.refs) {
      const block = renderRefs(info.refs)
      if (block) wrap.append(block)
    }

    return wrap
  }

  /**
   * A doc's `see` list names mechanisms, not instances. When the current
   * selection is on node 2, `node.merges` should take you to node 2's merges and
   * not to node 0's.
   */
  function resolveSeeTarget(currentIdValue: string, target: string): string {
    if (ctx.registry.get(target)) return target
    const m = /^node\.(\d+)\./.exec(currentIdValue)
    if (m && target.startsWith('node.')) {
      const candidate = `node.${m[1]}.${target.slice('node.'.length)}`
      if (ctx.registry.get(candidate)) return candidate
    }
    if (target.startsWith('node.')) {
      const candidate = `node.0.${target.slice('node.'.length)}`
      if (ctx.registry.get(candidate)) return candidate
    }
    return target
  }

  /* --- a packet, rather than a structure ----------------------------------
   * The cluster draws several dozen ducts at once and the traffic on them is
   * the only thing that glows, so "what is that box and where is it going" is
   * the question the scene provokes most often and could not answer at all.
   * Clicking one lands here: the two ends by name, the mechanism, and a way to
   * go and look at either end. The lane itself lights up in the scene, which is
   * the half of the answer prose cannot give.
   * ----------------------------------------------------------------------- */

  function endButton(end: RouteEnd, role: 'from' | 'to'): HTMLElement {
    const target = end.id && ctx.registry.get(end.id) ? end.id : null
    const node = el(
      target ? 'button' : 'span',
      {
        class: target ? 'ch-btn chc-end' : 'chc-end chc-end--dead',
        ...(target ? { type: 'button', title: `Fly to ${end.label}` } : {}),
        ...(target
          ? {
              on: {
                click: () => {
                  ctx.bus.emit('focus', { id: target })
                  ctx.bus.emit('select', { id: target })
                },
              },
            }
          : {}),
      },
      el('span', { class: 'ch-eyebrow chc-end__k', text: role === 'from' ? 'from' : 'to' }),
      el('span', { class: 'chc-end__n', text: end.label }),
    )
    return node
  }

  function renderFlow(def: RouteDef, kind: FlowKind | undefined): HTMLElement {
    const wrap = el('div', { class: 'chc-content ch-enter' })
    const t = def.traffic

    const path = el('div', { class: 'chc-path' })
    path.append(endButton(t.from, 'from'), el('span', { class: 'chc-path__arrow', text: '↓' }), endButton(t.to, 'to'))
    wrap.append(el('div', { class: 'chc-block' }, el('span', { class: 'ch-eyebrow', text: 'This packet' }), path))

    wrap.append(el('div', { class: 'chc-block' }, proseBody(t.note)))

    /* The duct's own identity, last and quiet. It is what to grep for in the
     * plan, not something a reader needs in order to understand the picture. */
    const meta = el('div', { class: 'chc-block' })
    meta.append(el('span', { class: 'ch-eyebrow', text: 'This duct' }))
    const rows = el('ul', { class: 'chc-src' })
    rows.append(el('li', { class: 'chc-src__i ch-mono', text: def.id }))
    if (kind) rows.append(el('li', { class: 'chc-src__i ch-mono', text: `kind: ${kind}` }))
    meta.append(rows)
    wrap.append(meta)

    return wrap
  }

  function selectFlow(routeId: string | null, kind: FlowKind | undefined): void {
    if (routeId === null) {
      // Only a flow selection can clear a flow selection. A structure click
      // clears it by going through `select`, which owns the panel outright.
      if (currentFlow !== null) {
        currentFlow = null
        select(null)
      }
      return
    }
    const def: RouteDef | undefined = ROUTES[routeId]
    if (!def) return

    currentFlow = routeId
    currentId = undefined // so a later click on a structure always re-renders
    currentDef = undefined
    teardown()

    kindBadge.hidden = false
    kindBadge.dataset.kind = 'network'
    // The badge says which side of the read/write axis the packet was on, and is
    // painted the colour the packet itself was. Reading `def.color` here showed
    // the DUCT's colour, which is not what the reader just clicked on.
    const axisKey = flowAxisColorKey(kind)
    setText(kindBadge, axisKey === 'flowWrite' ? 'writing' : axisKey === 'flowRead' ? 'reading' : 'in transit')
    kindBadge.style.setProperty('--kind', hex6(axisKey ? COLOR[axisKey] : def.color))

    setText(title, def.traffic.what)
    setText(subtitle, `${def.traffic.from.label} → ${def.traffic.to.label}`)
    subtitle.hidden = false
    readout.hidden = true
    // The packet is moving and there is nothing at a fixed point to frame. The
    // two ends are buttons instead, and each of them does have a place.
    flyBtn.disabled = true
    flyBtn.title = 'A packet is in transit — fly to one of its two ends instead'

    body.append(renderFlow(def, kind))
    body.scrollTop = 0
    setOpen(true)
  }

  /* --- selection --------------------------------------------------------- */

  function select(id: string | null): void {
    if (id !== null) currentFlow = null
    if (id === currentId) {
      if (id && !open) setOpen(true)
      return
    }
    const clearedSelection = id == null && currentId != null
    currentId = id
    teardown()

    const def = id ? ctx.registry.get(id) : undefined
    const info = id ? doc(id) : undefined
    currentDef = def

    if (!id) {
      kindBadge.hidden = true
      setText(title, 'Nothing selected')
      setText(subtitle, 'Click a structure to open it up')
      subtitle.hidden = false
      setText(readout, '')
      readout.hidden = true
      flyBtn.disabled = true
      body.append(renderEmpty())
      body.scrollTop = 0
      if (clearedSelection) setOpen(false)
      return
    }

    const kind = def?.kind ?? inferKind(id)
    kindBadge.hidden = false
    kindBadge.dataset.kind = kind
    setText(kindBadge, kind)
    if (def?.color != null) kindBadge.style.setProperty('--kind', hex6(def.color))
    else kindBadge.style.removeProperty('--kind')

    setText(title, def?.name ?? info?.title ?? id)
    const sub = def?.role ?? info?.subtitle ?? ''
    setText(subtitle, sub)
    subtitle.hidden = !sub
    readout.hidden = !def?.readout
    flyBtn.disabled = !def
    flyBtn.title = def ? 'Fly the camera to this component' : 'This one has no place in the cluster to fly to'

    body.append(renderDoc(id, info))
    body.scrollTop = 0
    acc = TICK // paint the new metrics on the very next frame
    setOpen(true)
  }

  /* --- wiring ------------------------------------------------------------ */

  const offSelect = ctx.bus.on('select', ({ id }) => select(id))
  const offFlow = ctx.bus.on('flow:select', ({ route, kind }) => selectFlow(route, kind))

  const onNarrow = (): void => {
    compact = narrow.matches
    applyOpen()
  }
  narrow.addEventListener('change', onNarrow)

  applyOpen()
  select(null)

  return {
    update(dt: number) {
      acc += dt
      if (acc < TICK) return
      acc = 0
      const s = ctx.sim.state
      for (const t of tiles) {
        let text = '—'
        try {
          text = t.get(s)
        } catch {
          text = '—'
        }
        t.set(text)
      }
      if (liveDot) setClass(liveDot, 'is-paused', s.knobs.paused)
      if (currentDef?.readout && !readout.hidden) {
        try {
          setText(readout, currentDef.readout(s))
        } catch {
          setText(readout, '')
        }
      }
      for (const k of knobs) k.sync()
    },
    dispose() {
      offSelect()
      offFlow()
      narrow.removeEventListener('change', onNarrow)
      teardown()
      host.remove()
    },
  }
}
