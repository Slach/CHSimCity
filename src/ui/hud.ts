import '../styles/hud.css'

import { cssColor, themeMode, toggleThemeMode } from '../core/theme'
import { N_NODES } from '../core/types'
import type { QualityLevel } from '../core/types'
import { fmtBytes, fmtNum } from '../core/util'
import { SCENARIOS } from '../sim/scenarios'
import { el, icon, isTypingTarget, physicalKey, setClass, setText, sparkline } from './uikit'
import type { UiContext, UiModule } from './uikit'

/* ============================================================================
 * THE HUD
 *
 * Three surfaces, and each answers a different question.
 *
 *   TOP BAR       "is this cluster healthy?" — six vitals with sparklines, and
 *                 each one is a number a real operator watches. Click one to fly
 *                 to the thing that produces it.
 *   BOTTOM DOCK   transport: pause, speed, home, tour, search, help, theme, and
 *                 the scenario picker.
 *   TOASTS        the exceptions and warnings the cluster raises, verbatim where
 *                 possible — `Code: 252. Too many parts` is worth recognising.
 *
 * Everything here polls SimState. Nothing in the HUD ever holds simulation state
 * of its own, so it cannot drift out of agreement with the model.
 * ==========================================================================*/

/** Vitals refresh. 6 Hz reads as continuous and costs one layout pass. */
const TICK = 1 / 6
/** Sparklines are heavier; a third of that is plenty. */
const SPARK_TICK = 1 / 3

interface Vital {
  key: string
  label: string
  /** Component to fly to when the tile is clicked. */
  focus: string
  color: string
  get(): { text: string; state: '' | 'ok' | 'warn' | 'crit' }
  history(): readonly number[]
  /** Draw a dashed baseline here — usually a threshold. */
  baseline?: number
}

export function createHud(ctx: UiContext): UiModule {
  const top = document.getElementById('hud-top')
  const bottom = document.getElementById('hud-bottom')
  const toastStack = document.getElementById('toast-stack')
  if (!top || !bottom) {
    console.warn('[CHSimCity] the HUD shell is missing')
    return { update() {}, dispose() {} }
  }

  const s = () => ctx.sim.state

  /* ======================================================================
   * TOP BAR — the vitals
   * ====================================================================*/

  const VITALS: Vital[] = [
    {
      key: 'parts',
      label: 'active parts',
      focus: 'node.0.yard',
      color: cssColor('partActive'),
      get: () => {
        const n = s().stats.activeParts
        // The thresholds are the real ones, scaled to the cluster: four nodes ×
        // three tables, so `parts_to_delay_insert` per node-table is the line.
        const perTable = n / (N_NODES * 3)
        return {
          text: fmtNum(n),
          state: perTable > s().knobs.partsToThrowInsert * 0.8 ? 'crit' : perTable > s().knobs.partsToDelayInsert * 0.8 ? 'warn' : 'ok',
        }
      },
      history: () => s().stats.history.parts,
    },
    {
      key: 'merges',
      label: 'merges',
      focus: 'node.0.merges',
      color: cssColor('merge'),
      get: () => {
        const n = s().stats.runningMerges
        const cap = s().knobs.mergePoolSize * N_NODES
        return { text: `${n} / ${cap}`, state: n >= cap ? 'warn' : '' }
      },
      history: () => s().stats.history.merges,
    },
    {
      key: 'insert',
      label: 'rows/s written',
      focus: 'node.0.insertdock',
      color: cssColor('partPreactive'),
      get: () => {
        let delayed = 0
        for (const n of s().nodes) if (n.insertDelay > delayed) delayed = n.insertDelay
        return {
          text: fmtNum(s().stats.insertRowsPerSec),
          state: delayed > 0.5 ? 'crit' : delayed > 0.05 ? 'warn' : '',
        }
      },
      history: () => s().stats.history.insertRows,
    },
    {
      key: 'select',
      label: 'rows/s read',
      focus: 'node.0.readpool',
      color: cssColor('reader'),
      get: () => ({ text: fmtNum(s().stats.selectRowsPerSec), state: '' }),
      history: () => s().stats.history.selectRows,
    },
    {
      key: 'markcache',
      label: 'mark cache',
      focus: 'node.0.markcache',
      color: cssColor('markCache'),
      get: () => {
        const p = s().stats.markCacheHitPct
        // Below 95% on a query-serving node is worth a look; below 80% is the
        // scenario this project ships to demonstrate.
        return { text: `${p.toFixed(1)}%`, state: p < 80 ? 'crit' : p < 95 ? 'warn' : 'ok' }
      },
      history: () => s().stats.history.markCache,
      baseline: 95,
    },
    {
      key: 'delay',
      label: 'replica delay',
      focus: 'node.1.queue',
      color: cssColor('replication'),
      get: () => {
        const d = s().stats.maxReplicaDelay
        return { text: `${d.toFixed(1)} s`, state: d > 30 ? 'crit' : d > 5 ? 'warn' : 'ok' }
      },
      history: () => s().stats.history.delay,
      baseline: 5,
    },
  ]

  interface VitalUi {
    v: Vital
    value: HTMLElement
    canvas: HTMLCanvasElement
    lastState: string
  }

  const vitalUi: VitalUi[] = []
  const vitalRow = el('div', { class: 'hud-vitals' })

  for (const v of VITALS) {
    const value = el('div', { class: 'hud-vital__v' })
    const canvas = el('canvas', { class: 'ch-spark hud-vital__spark' })
    const tile = el(
      'button',
      {
        class: 'hud-vital',
        type: 'button',
        title: `${v.label} — click to fly there`,
        on: {
          click: () => {
            ctx.bus.emit('focus', { id: v.focus })
            ctx.bus.emit('select', { id: v.focus })
          },
        },
      },
      el('div', { class: 'hud-vital__k', text: v.label }),
      value,
      canvas,
    )
    tile.style.setProperty('--vital', v.color)
    vitalRow.append(tile)
    vitalUi.push({ v, value, canvas, lastState: '' })
  }

  /* --- the cluster identity, and the graphics readout -------------------- */

  const brand = el(
    'div',
    { class: 'hud-brand' },
    el('span', { class: 'hud-brand__n', text: 'CH' }),
    el('span', { class: 'hud-brand__m', text: 'SimCity' }),
  )

  const fpsText = el('span', { class: 'hud-fps__v' })
  const qualitySelect = el('select', {
    class: 'ch-select hud-quality',
    title: 'Graphics quality',
    'aria-label': 'Graphics quality',
    on: {
      change: (e: Event) => {
        const level = (e.target as HTMLSelectElement).value as QualityLevel
        ctx.bus.emit('quality', { level })
      },
    },
  })
  for (const level of ['low', 'reduced', 'medium', 'high', 'ultra'] as QualityLevel[]) {
    qualitySelect.append(el('option', { value: level, text: level }))
  }
  qualitySelect.value = ctx.getQuality().level

  const themeBtn = el(
    'button',
    {
      class: 'ch-btn ch-btn--icon',
      type: 'button',
      title: 'Switch between day and night',
      'aria-label': 'Switch between day and night',
      on: {
        click: () => {
          toggleThemeMode()
          paintThemeBtn()
        },
      },
    },
    icon(themeMode() === 'day' ? 'moon' : 'sun', 14),
  )

  function paintThemeBtn(): void {
    const next = themeMode() === 'day' ? 'moon' : 'sun'
    const svg = themeBtn.querySelector('svg')
    if (svg && svg.dataset.icon !== next) themeBtn.replaceChild(icon(next, 14), svg)
  }

  const bar = el(
    'div',
    { class: 'hud-bar' },
    brand,
    vitalRow,
    el(
      'div',
      { class: 'hud-bar__right' },
      el('span', { class: 'hud-fps' }, el('span', { class: 'hud-fps__k', text: 'fps' }), fpsText),
      qualitySelect,
      themeBtn,
    ),
  )
  top.append(bar)

  /* ======================================================================
   * BOTTOM DOCK — transport and scenarios
   * ====================================================================*/

  const pauseBtn = el(
    'button',
    {
      class: 'ch-btn ch-btn--icon',
      type: 'button',
      title: 'Pause / resume (K)',
      'aria-label': 'Pause or resume',
      on: { click: () => ctx.sim.setKnob('paused', !s().knobs.paused) },
    },
    icon('pause', 14),
  )

  const speedText = el('span', { class: 'hud-speed__v', text: '1.0×' })
  const slowerBtn = el(
    'button',
    {
      class: 'ch-btn ch-btn--icon',
      type: 'button',
      title: 'Slower (,)',
      'aria-label': 'Slower',
      on: { click: () => nudgeSpeed(-1) },
    },
    icon('prev', 12),
  )
  const fasterBtn = el(
    'button',
    {
      class: 'ch-btn ch-btn--icon',
      type: 'button',
      title: 'Faster (.)',
      'aria-label': 'Faster',
      on: { click: () => nudgeSpeed(1) },
    },
    icon('next', 12),
  )

  function nudgeSpeed(dir: number): void {
    const steps = [0.1, 0.25, 0.5, 1, 2, 3, 5]
    const cur = s().knobs.timeScale
    let i = 0
    let best = Infinity
    for (let k = 0; k < steps.length; k++) {
      const d = Math.abs(steps[k] - cur)
      if (d < best) {
        best = d
        i = k
      }
    }
    const next = steps[Math.max(0, Math.min(steps.length - 1, i + dir))]
    ctx.sim.setKnob('timeScale', next)
  }

  const homeBtn = el(
    'button',
    {
      class: 'ch-btn ch-btn--icon',
      type: 'button',
      title: 'Back to the establishing shot (H)',
      'aria-label': 'Home view',
      on: { click: () => ctx.bus.emit('focus', { id: null }) },
    },
    icon('home', 14),
  )

  /**
   * F and the Fly button are the same affordance, and it is a TOGGLE. The
   * decision has to be made here, where the current mode is known: the
   * `camera:mode` event is a plain "be in this mode" command, and a listener
   * that ignores a request for the mode it is already in — which is the only
   * way to stop the rig's own announcement echoing back — can never see a
   * request for `fly` while flying as anything but a no-op.
   */
  function toggleFly(): void {
    ctx.bus.emit('camera:mode', { mode: ctx.getCamera().mode === 'fly' ? 'orbit' : 'fly' })
  }

  const flyBtn = el(
    'button',
    {
      class: 'ch-btn',
      type: 'button',
      title: 'Fly mode (F) — free flight, click the scene to capture the mouse',
      on: { click: () => toggleFly() },
    },
    icon('fly', 13),
    el('span', { text: 'Fly' }),
  )

  const tourBtn = el(
    'button',
    {
      class: 'ch-btn',
      type: 'button',
      title: 'Guided tour (T)',
      on: { click: () => ctx.bus.emit('tour:start', {}) },
    },
    icon('tour', 13),
    el('span', { text: 'Tour' }),
  )

  const searchBtn = el(
    'button',
    {
      class: 'ch-btn',
      type: 'button',
      title: 'Search every component and scenario (/)',
      on: { click: () => window.dispatchEvent(new CustomEvent('chsimcity:search')) },
    },
    icon('search', 13),
    el('span', { text: 'Search' }),
  )

  const helpBtn = el(
    'button',
    {
      class: 'ch-btn ch-btn--icon',
      type: 'button',
      title: 'Keyboard map and colour legend (?)',
      'aria-label': 'Help',
      on: { click: () => window.dispatchEvent(new CustomEvent('chsimcity:help')) },
    },
    icon('help', 14),
  )

  const scenarioSelect = el('select', {
    class: 'ch-select hud-scenario',
    title: 'Run a scenario',
    'aria-label': 'Run a scenario',
    on: {
      change: (e: Event) => {
        const id = (e.target as HTMLSelectElement).value
        ctx.sim.runScenario(id === '' ? null : id)
      },
    },
  })
  scenarioSelect.append(el('option', { value: '', text: 'no scenario' }))
  for (const sc of SCENARIOS) scenarioSelect.append(el('option', { value: sc.id, text: sc.name }))

  const dock = el(
    'div',
    { class: 'hud-dock' },
    el('div', { class: 'hud-dock__group' }, pauseBtn, slowerBtn, speedText, fasterBtn),
    el('div', { class: 'hud-dock__group' }, homeBtn, flyBtn, tourBtn, searchBtn, helpBtn),
    el('div', { class: 'hud-dock__group hud-dock__group--wide' }, scenarioSelect),
  )
  bottom.append(dock)

  /* ======================================================================
   * TOASTS
   * ====================================================================*/

  interface Toast {
    node: HTMLElement
    until: number
  }
  const toasts: Toast[] = []
  /** Most toasts on screen at once. Past this the oldest is retired early. */
  const TOAST_CAP = 4

  const offToast = ctx.bus.on('toast', ({ text, kind = 'info', ms = 4200 }) => {
    if (!toastStack) return
    const node = el('div', { class: `hud-toast is-${kind}`, text })
    toastStack.append(node)
    // The transition needs the element to have been laid out once.
    requestAnimationFrame(() => node.classList.add('is-on'))
    toasts.push({ node, until: performance.now() / 1000 + ms / 1000 })
    while (toasts.length > TOAST_CAP) {
      const dead = toasts.shift()
      dead?.node.remove()
    }
  })

  /* ======================================================================
   * NARRATION — the scenario beats
   * ====================================================================*/

  const narrateTitle = el('h3', { class: 'hud-narrate__t' })
  const narrateBody = el('p', { class: 'hud-narrate__b' })
  const narrate = el(
    'div',
    { class: 'hud-narrate' },
    narrateTitle,
    narrateBody,
    el(
      'button',
      {
        class: 'ch-btn ch-btn--icon hud-narrate__x',
        type: 'button',
        title: 'Dismiss',
        'aria-label': 'Dismiss',
        on: { click: () => hideNarration() },
      },
      icon('close', 12),
    ),
  )
  narrate.hidden = true
  bottom.parentElement?.append(narrate)

  let narrateUntil = 0

  function hideNarration(): void {
    narrate.classList.remove('is-on')
    narrateUntil = 0
    // Let the fade finish before it stops taking space.
    window.setTimeout(() => {
      if (narrateUntil === 0) narrate.hidden = true
    }, 260)
  }

  const offNarrate = ctx.bus.on('narrate', (payload) => {
    if (!payload) {
      hideNarration()
      return
    }
    setText(narrateTitle, payload.title)
    setText(narrateBody, payload.body)
    narrate.hidden = false
    requestAnimationFrame(() => narrate.classList.add('is-on'))
    narrateUntil = performance.now() / 1000 + (payload.seconds ?? 11)
  })

  /* ======================================================================
   * FLY OVERLAY
   *
   * Fly mode has two states people confuse, so the overlay names both. The
   * mouse is either CAPTURED — the pointer is locked, moving it looks around,
   * and Esc gives it back — or it is not, in which case you are still flying but
   * have to drag to look. Without this, releasing the pointer reads as the mode
   * having silently ended.
   * ====================================================================*/

  const flySpeed = el('span', { class: 'hud-fly__v' })
  const flyAlt = el('span', { class: 'hud-fly__v' })
  const flyHint = el('span', { class: 'hud-fly__hint' })
  const flyOverlay = el(
    'div',
    { class: 'hud-fly' },
    el('div', { class: 'hud-fly__cross' }),
    el(
      'div',
      { class: 'hud-fly__bar' },
      el('span', { class: 'hud-fly__k', text: 'FLY' }),
      el('span', { class: 'hud-fly__k', text: 'speed' }),
      flySpeed,
      el('span', { class: 'hud-fly__k', text: 'alt' }),
      flyAlt,
      flyHint,
    ),
  )
  flyOverlay.hidden = true
  bottom.parentElement?.append(flyOverlay)

  /* ======================================================================
   * Keyboard
   * ====================================================================*/

  /** District jump targets for keys 1–7. */
  const DISTRICT_KEYS: readonly string[] = [
    'clients',
    'dist',
    'node.0',
    'node.1',
    'node.2',
    'node.3',
    'keeper.ensemble',
  ]

  function onKeyDown(e: KeyboardEvent): void {
    if (isTypingTarget(e.target) || e.metaKey || e.ctrlKey || e.altKey) return

    // The PHYSICAL key, never the character: on a Cyrillic layout `e.key` for
    // this key is `а`, and switching on it made every shortcut here disappear.
    switch (physicalKey(e)) {
      case 'K':
      case 'P':
        ctx.sim.setKnob('paused', !s().knobs.paused)
        e.preventDefault()
        return
      case ',':
        nudgeSpeed(-1)
        return
      case '.':
        nudgeSpeed(1)
        return
      case 'H':
        ctx.bus.emit('focus', { id: null })
        return
      case 'T':
        ctx.bus.emit('tour:start', {})
        return
      case 'R':
        ctx.sim.reset()
        ctx.bus.emit('toast', { text: 'Cluster reset', kind: 'good', ms: 2200 })
        return
      case 'F':
        toggleFly()
        return
      case 'Escape':
        // The first Esc releases the pointer — the browser does that itself and
        // we never see the key. The second one, which we do see, leaves the mode.
        if (ctx.getCamera().mode === 'fly' && !ctx.getCamera().locked) {
          ctx.bus.emit('camera:mode', { mode: 'orbit' })
        }
        return
      case 'N':
        toggleThemeMode()
        paintThemeBtn()
        return
      default:
        break
    }

    const n = Number(physicalKey(e))
    if (Number.isInteger(n) && n >= 1 && n <= DISTRICT_KEYS.length) {
      const id = DISTRICT_KEYS[n - 1]
      ctx.bus.emit('focus', { id })
      ctx.bus.emit('select', { id })
    }
  }
  window.addEventListener('keydown', onKeyDown)

  /* ======================================================================
   * Bus wiring
   * ====================================================================*/

  const offQuality = ctx.bus.on('quality', ({ level }) => {
    if (qualitySelect.value !== level) qualitySelect.value = level
  })

  const offScenario = ctx.bus.on('scenario', ({ id }) => {
    const next = id ?? ''
    if (scenarioSelect.value !== next) scenarioSelect.value = next
    setClass(dock, 'is-scenario', !!id)
  })

  /* ======================================================================
   * Update
   * ====================================================================*/

  let acc = TICK
  let sparkAcc = SPARK_TICK
  let lastPaused: boolean | null = null
  let lastFlying: boolean | null = null
  let lastLocked: boolean | null = null

  return {
    update(dt: number) {
      acc += dt
      sparkAcc += dt

      if (acc >= TICK) {
        acc = 0
        for (const u of vitalUi) {
          let out: { text: string; state: '' | 'ok' | 'warn' | 'crit' }
          try {
            out = u.v.get()
          } catch {
            out = { text: '—', state: '' }
          }
          setText(u.value, out.text)
          if (out.state !== u.lastState) {
            u.value.className = 'hud-vital__v' + (out.state ? ` is-${out.state}` : '')
            u.lastState = out.state
          }
        }

        setText(fpsText, ctx.getFps().toFixed(0))
        setText(speedText, `${s().knobs.timeScale.toFixed(1)}×`)

        /* --- fly mode ---------------------------------------------------- */
        const cam = ctx.getCamera()
        const flying = cam.mode === 'fly'
        if (flying !== lastFlying) {
          lastFlying = flying
          setClass(flyBtn, 'is-active', flying)
          flyOverlay.hidden = !flying
          setClass(document.body, 'ch-flying', flying)
        }
        if (flying) {
          setText(flySpeed, `${cam.speed.toFixed(0)} u/s`)
          setText(flyAlt, `${cam.y.toFixed(0)} m`)
          if (cam.locked !== lastLocked) {
            lastLocked = cam.locked
            setText(
              flyHint,
              cam.locked
                ? 'Esc releases the mouse · wheel changes speed · Space / C for up and down'
                : 'click the scene to capture the mouse · Esc leaves fly mode',
            )
            setClass(flyOverlay, 'is-locked', cam.locked)
          }
        } else {
          lastLocked = null
        }

        const paused = s().knobs.paused
        if (paused !== lastPaused) {
          lastPaused = paused
          const svg = pauseBtn.querySelector('svg')
          if (svg) pauseBtn.replaceChild(icon(paused ? 'play' : 'pause', 14), svg)
          setClass(document.body, 'ch-paused', paused)
        }
      }

      if (sparkAcc >= SPARK_TICK) {
        sparkAcc = 0
        for (const u of vitalUi) {
          sparkline(u.canvas, u.v.history(), {
            color: u.v.color,
            fill: true,
            min: 0,
            baseline: u.v.baseline,
          })
        }
      }

      /* Toasts and narration expire on the WALL clock, not on simulated time —
       * a paused cluster must not freeze a warning on screen forever. */
      const now = performance.now() / 1000
      for (let i = toasts.length - 1; i >= 0; i--) {
        if (toasts[i].until > now) continue
        const dead = toasts.splice(i, 1)[0]
        dead.node.classList.remove('is-on')
        window.setTimeout(() => dead.node.remove(), 260)
      }
      if (narrateUntil > 0 && now > narrateUntil) hideNarration()
    },
    dispose() {
      window.removeEventListener('keydown', onKeyDown)
      offToast()
      offNarrate()
      offQuality()
      offScenario()
      bar.remove()
      dock.remove()
      narrate.remove()
      flyOverlay.remove()
      document.body.classList.remove('ch-flying')
      for (const t of toasts) t.node.remove()
      toasts.length = 0
    },
  }
}
