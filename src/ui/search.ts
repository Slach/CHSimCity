import type { Knobs } from '../core/types'
import { SCENARIOS } from '../sim/scenarios'
import { KNOB_META } from './content'
import { applyKnob } from './controls'
import { clear, el, icon, physicalKey, setClass, setText } from './uikit'
import type { UiContext, UiModule } from './uikit'

/* ============================================================================
 * THE COMMAND PALETTE
 *
 * One box over everything: every registered component, every setting, every
 * scenario. `/` or Ctrl-K opens it, arrows move, Enter acts, Escape closes.
 *
 * Three result kinds, and each does the obvious thing:
 *
 *   component  select it and fly to it
 *   setting    focus the console with that group open
 *   scenario   run it
 * ==========================================================================*/

const MAX_RESULTS = 14

type ResultKind = 'component' | 'setting' | 'scenario'

interface Result {
  kind: ResultKind
  id: string
  name: string
  detail: string
  score: number
  run(): void
}

export function createSearch(ctx: UiContext): UiModule {
  const overlay = el('div', { class: 'pal-overlay' })
  overlay.hidden = true
  overlay.setAttribute('role', 'dialog')
  overlay.setAttribute('aria-modal', 'true')
  overlay.setAttribute('aria-label', 'Search')

  const input = el('input', {
    class: 'pal-input',
    type: 'text',
    placeholder: 'Search components, settings and scenarios…',
    spellcheck: false,
    autocomplete: 'off',
  })
  const list = el('div', { class: 'pal-list', role: 'listbox' })
  const hint = el(
    'div',
    { class: 'pal-hint' },
    el('span', { class: 'ch-kbd', text: '↑↓' }),
    el('span', { text: 'move' }),
    el('span', { class: 'ch-kbd', text: '↵' }),
    el('span', { text: 'go' }),
    el('span', { class: 'ch-kbd', text: 'esc' }),
    el('span', { text: 'close' }),
  )

  const dialog = el(
    'div',
    { class: 'pal-dialog ch-panel' },
    el('div', { class: 'pal-head' }, icon('search', 15), input),
    list,
    hint,
  )
  overlay.append(dialog)
  document.body.append(overlay)

  let open = false
  let results: Result[] = []
  let selected = 0

  /* --- scoring ----------------------------------------------------------- */

  /**
   * A deliberately simple scorer: exact, prefix, substring, then a field-weighted
   * substring. A fuzzy matcher would be worse here — the corpus is small and the
   * names are precise, so a false positive costs more than a missed subsequence.
   */
  function score(needle: string, name: string, id: string, detail: string): number {
    const n = name.toLowerCase()
    const i = id.toLowerCase()
    const d = detail.toLowerCase()
    if (n === needle || i === needle) return 1000
    if (n.startsWith(needle)) return 600 - n.length
    if (i.startsWith(needle)) return 550 - i.length
    if (n.includes(needle)) return 320 - n.length
    if (i.includes(needle)) return 260 - i.length
    if (d.includes(needle)) return 120
    return -1
  }

  function build(query: string): Result[] {
    const needle = query.trim().toLowerCase()
    const out: Result[] = []

    if (!needle) {
      // The resting state is the useful one: the scenarios, because they are the
      // fastest route to something worth looking at.
      for (const sc of SCENARIOS.slice(0, MAX_RESULTS)) {
        out.push({
          kind: 'scenario',
          id: sc.id,
          name: sc.name,
          detail: sc.blurb,
          score: 0,
          run: () => ctx.sim.runScenario(sc.id),
        })
      }
      return out
    }

    for (const def of ctx.registry.all()) {
      const sc = score(needle, def.name, def.id, def.role)
      if (sc < 0) continue
      out.push({
        kind: 'component',
        id: def.id,
        name: def.name,
        detail: def.role,
        score: sc,
        run: () => {
          ctx.bus.emit('focus', { id: def.id })
          ctx.bus.emit('select', { id: def.id })
        },
      })
    }

    for (const meta of KNOB_META) {
      const sc = score(needle, meta.label, meta.setting ?? String(meta.key), meta.hint)
      if (sc < 0) continue
      out.push({
        kind: 'setting',
        id: String(meta.key),
        name: meta.label,
        detail: meta.setting ? `${meta.setting} — ${meta.hint}` : meta.hint,
        // Settings rank a little below components: you usually want to *see* the
        // thing before you change it.
        score: sc - 30,
        run: () => {
          // Toggles are actionable from here; ranges are not, so the palette
          // opens the console instead of guessing a value.
          if (meta.kind === 'toggle') {
            const cur = ctx.sim.state.knobs[meta.key]
            applyKnob(ctx.sim, meta.key as keyof Knobs, !cur)
            ctx.bus.emit('toast', {
              text: `${meta.label} → ${!cur ? 'on' : 'off'}`,
              kind: 'info',
              ms: 2400,
            })
          } else {
            ctx.bus.emit('toast', {
              text: `${meta.label} lives in the console under “${meta.group}”`,
              kind: 'info',
              ms: 3200,
            })
          }
        },
      })
    }

    for (const s of SCENARIOS) {
      const sc = score(needle, s.name, s.id, s.blurb)
      if (sc < 0) continue
      out.push({
        kind: 'scenario',
        id: s.id,
        name: s.name,
        detail: s.blurb,
        score: sc + 40,
        run: () => ctx.sim.runScenario(s.id),
      })
    }

    out.sort((a, b) => b.score - a.score)
    return out.slice(0, MAX_RESULTS)
  }

  /* --- rendering --------------------------------------------------------- */

  function render(): void {
    clear(list)
    if (results.length === 0) {
      list.append(el('div', { class: 'pal-empty', text: 'Nothing matches that.' }))
      return
    }
    results.forEach((r, i) => {
      const row = el(
        'button',
        {
          class: `pal-row${i === selected ? ' is-sel' : ''}`,
          type: 'button',
          role: 'option',
          on: {
            click: () => {
              selected = i
              commit()
            },
            pointerenter: () => {
              if (selected === i) return
              selected = i
              paintSelection()
            },
          },
        },
        el('span', { class: `pal-row__kind is-${r.kind}`, text: r.kind }),
        el('span', { class: 'pal-row__n', text: r.name }),
        el('span', { class: 'pal-row__d', text: r.detail }),
      )
      list.append(row)
    })
  }

  function paintSelection(): void {
    const rows = list.querySelectorAll('.pal-row')
    for (let i = 0; i < rows.length; i++) setClass(rows[i], 'is-sel', i === selected)
    const active = rows[selected] as HTMLElement | undefined
    active?.scrollIntoView({ block: 'nearest' })
  }

  function refresh(): void {
    results = build(input.value)
    selected = 0
    render()
  }

  function commit(): void {
    const r = results[selected]
    if (!r) return
    setOpen(false)
    r.run()
  }

  function setOpen(next: boolean): void {
    if (next === open) return
    open = next
    overlay.hidden = !next
    if (next) {
      input.value = ''
      refresh()
      // `hidden` really does mean `display: none` now, and a transition cannot
      // run in the frame an element stops being display:none. Both the fade and
      // the focus therefore wait for the next one.
      requestAnimationFrame(() => {
        overlay.classList.add('is-on')
        input.focus()
      })
    } else {
      overlay.classList.remove('is-on')
      input.blur()
    }
  }

  /* --- wiring ------------------------------------------------------------ */

  input.addEventListener('input', refresh)

  input.addEventListener('keydown', (e: KeyboardEvent) => {
    switch (e.key) {
      case 'ArrowDown':
        selected = Math.min(results.length - 1, selected + 1)
        paintSelection()
        e.preventDefault()
        break
      case 'ArrowUp':
        selected = Math.max(0, selected - 1)
        paintSelection()
        e.preventDefault()
        break
      case 'Enter':
        commit()
        e.preventDefault()
        break
      case 'Escape':
        setOpen(false)
        e.preventDefault()
        break
      default:
        break
    }
  })

  function isTyping(t: EventTarget | null): boolean {
    const node = t as HTMLElement | null
    if (!node || typeof node.tagName !== 'string') return false
    if (node === input) return false
    const tag = node.tagName
    return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || node.isContentEditable === true
  }

  function onKeyDown(e: KeyboardEvent): void {
    // The PHYSICAL key: `/` is `.` on a Cyrillic layout and `K` is `л`, so
    // matching on the character meant the palette had no way to open at all
    // for anyone not typing in Latin.
    const k = physicalKey(e)
    if (k === 'K' && (e.ctrlKey || e.metaKey)) {
      setOpen(!open)
      e.preventDefault()
      return
    }
    // Escape while the palette is up, but the focus has wandered out of the
    // input — clicking a result's row and missing, say. The input's own
    // handler cannot see that keystroke.
    if (k === 'Escape' && open) {
      setOpen(false)
      e.preventDefault()
      return
    }
    if (isTyping(e.target)) return
    // Shift-/ is `?`, which belongs to the help overlay.
    if (k === '/' && !e.shiftKey && !open) {
      setOpen(true)
      e.preventDefault()
    }
  }

  function onRequest(): void {
    setOpen(!open)
  }

  function onBackdrop(e: MouseEvent): void {
    if (e.target === overlay) setOpen(false)
  }

  window.addEventListener('keydown', onKeyDown)
  window.addEventListener('chsimcity:search', onRequest)
  overlay.addEventListener('click', onBackdrop)

  return {
    update() {},
    dispose() {
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('chsimcity:search', onRequest)
      overlay.removeEventListener('click', onBackdrop)
      overlay.remove()
    },
  }
}
