import type { Bus, CameraMode, QualitySettings, SimApi } from '../core/types'
import type { Registry } from '../core/registry'

/* ============================================================================
 * Shared UI plumbing. Every HUD module takes a UiContext and builds DOM with
 * these helpers, so the whole interface stays one consistent object.
 * ==========================================================================*/

/** Where the camera is and what it is doing. Read per frame; never cached. */
export interface CameraReadout {
  mode: CameraMode
  /** Fly speed in world units per second. */
  speed: number
  /** World position, so the minimap can draw the viewer. */
  x: number
  y: number
  z: number
  /** Heading in radians, measured the way atan2(x, z) gives it. */
  yaw: number
  /** Vertical field of view in radians, for the minimap's view cone. */
  fov: number
  /** Aspect ratio, so the cone is the horizontal field and not the vertical one. */
  aspect: number
  /** True while the pointer is captured — the click that captured it must not select. */
  locked: boolean
}

export interface UiContext {
  bus: Bus
  sim: SimApi
  registry: Registry
  getFps(): number
  getQuality(): QualitySettings
  getFlowStats(): { active: number; dropped: number }
  getCamera(): CameraReadout
}

export interface UiModule {
  /**
   * Called every frame. `dt` is animation-safe; `elapsed` is accepted wall time
   * for clocks that must agree with the viewer's watch.
   */
  update(dt: number, elapsed?: number): void
  dispose(): void
}

/* ------------------------------ DOM helpers ------------------------------ */

type Attrs = Record<string, unknown> & {
  class?: string
  text?: string
  html?: string
  style?: Partial<CSSStyleDeclaration> | string
  on?: Record<string, EventListenerOrEventListenerObject>
  data?: Record<string, string>
}

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Attrs = {},
  ...children: (Node | string | null | undefined | false)[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue
    if (k === 'class') node.className = String(v)
    else if (k === 'text') node.textContent = String(v)
    else if (k === 'html') node.innerHTML = String(v)
    else if (k === 'style') {
      if (typeof v === 'string') node.setAttribute('style', v)
      else Object.assign(node.style, v)
    } else if (k === 'on') {
      for (const [ev, fn] of Object.entries(v as Record<string, EventListener>)) node.addEventListener(ev, fn)
    } else if (k === 'data') {
      for (const [dk, dv] of Object.entries(v as Record<string, string>)) node.dataset[dk] = dv
    } else if (k in node) {
      // Property assignment (value, checked, disabled, …).
      ;(node as unknown as Record<string, unknown>)[k] = v
    } else {
      node.setAttribute(k, String(v))
    }
  }
  for (const c of children) {
    if (c == null || c === false) continue
    node.append(typeof c === 'string' ? document.createTextNode(c) : c)
  }
  return node
}

export function clear(node: Element): void {
  while (node.firstChild) node.removeChild(node.firstChild)
}

/** Set textContent only when it actually changed — avoids layout thrash at 60fps. */
export function setText(node: { textContent: string | null }, value: string): void {
  if (node.textContent !== value) node.textContent = value
}

/** Toggle a class only on change. */
export function setClass(node: Element, cls: string, on: boolean): void {
  if (node.classList.contains(cls) !== on) node.classList.toggle(cls, on)
}

/* ------------------------------- keyboard -------------------------------- */

/**
 * Punctuation whose printed character depends on the layout. The name on the
 * left is the physical key; the character on the right is what it produces on
 * a US layout, which is what the shortcut tables are written in.
 */
const PUNCT_CODES: Record<string, string> = {
  Slash: '/',
  Comma: ',',
  Period: '.',
  Minus: '-',
  Equal: '=',
  BracketLeft: '[',
  BracketRight: ']',
  Backquote: '`',
  Semicolon: ';',
  Quote: "'",
  Backslash: '\\',
}

/**
 * Which key was physically pressed, independent of the keyboard layout.
 *
 * `KeyboardEvent.key` is the CHARACTER the layout produces, not the key. On a
 * Cyrillic layout the `F` key arrives as `а`, `T` as `е` and `/` as `.`, so
 * every shortcut written as `e.key === 'f'` silently stops existing — which is
 * exactly what happened here: fly, the tour, search, pause, reset and the
 * theme toggle were all dead on any non-Latin layout, while WASD kept working
 * because `engine/camera.ts` was already switching on `e.code`.
 *
 * This returns the US-layout name of the key: an uppercase letter, a digit, or
 * one of the punctuation characters above. Keys that carry no character at all
 * — `Escape`, the arrows, `Enter` — are layout-independent already and come
 * back as their `key` value, so callers can switch on both in one statement.
 *
 * `code` is empty on synthetic events and on some IME and virtual keyboards,
 * so `key` remains the fallback rather than an error.
 */
export function physicalKey(e: KeyboardEvent): string {
  const code = e.code
  if (code) {
    if (code.length === 4 && code.startsWith('Key')) return code[3]
    if (code.length === 6 && code.startsWith('Digit')) return code[5]
    if (code.length === 7 && code.startsWith('Numpad') && code[6] >= '0' && code[6] <= '9') return code[6]
    const punct = PUNCT_CODES[code]
    if (punct !== undefined) return punct
  }
  const k = e.key
  return k.length === 1 ? k.toUpperCase() : k
}

/**
 * Is the event going to something the visitor is typing into? A shortcut must
 * never steal a character from a text field or a `<select>`'s type-ahead.
 */
export function isTypingTarget(t: EventTarget | null): boolean {
  const node = t as HTMLElement | null
  if (!node || typeof node.tagName !== 'string') return false
  const tag = node.tagName
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || node.isContentEditable === true
}

/* --------------------------------- icons --------------------------------- */

const ICON_PATHS: Record<string, string> = {
  play: 'M5 3.5v9l8-4.5z',
  pause: 'M5.5 3.5h2.2v9H5.5zm4.8 0h2.2v9h-2.2z',
  reset: 'M8 3a5 5 0 1 0 4.6 3M12.8 2.4v3.4H9.4',
  tour: 'M3.2 14V2.2M3.5 3h8l-1.8 2.4 1.8 2.4h-8',
  help: 'M6 6a2 2 0 1 1 2.6 1.9c-.5.2-.6.6-.6 1v.4M8 12.1h.01',
  search: 'M7.2 11.4a4.2 4.2 0 1 0 0-8.4 4.2 4.2 0 0 0 0 8.4zm3.2-1 3.1 3.1',
  close: 'M4 4l8 8M12 4l-8 8',
  chevron: 'M6 4l4 4-4 4',
  camera: 'M2.5 5.5h2l1-1.5h5l1 1.5h2v7h-11zM8 11a2.2 2.2 0 1 0 0-4.4A2.2 2.2 0 0 0 8 11z',
  gear: 'M8 10a2 2 0 1 0 0-4 2 2 0 0 0 0 4zM8 1.6v1.6M8 12.8v1.6M2.5 4.8l1.4.8M12.1 10.4l1.4.8M2.5 11.2l1.4-.8M12.1 5.6l1.4-.8',
  layers: 'M8 2 1.8 5.4 8 8.8l6.2-3.4zM2 8.6 8 12l6-3.4M2 11.4 8 14.8l6-3.4',
  warn: 'M8 2 1.5 13.5h13zM8 6.4v3.2M8 11.6h.01',
  next: 'M4 3.5l6 4.5-6 4.5zM11.5 3.5v9',
  prev: 'M12 3.5l-6 4.5 6 4.5zM4.5 3.5v9',
  home: 'M2.5 7.5 8 2.8l5.5 4.7M4 7v6.2h8V7',
  sun: 'M8 3.2V1.5M8 14.5v-1.7M3.2 8H1.5M14.5 8h-1.7M4.6 4.6 3.4 3.4M12.6 12.6l-1.2-1.2M11.4 4.6l1.2-1.2M3.4 12.6l1.2-1.2M11 8a3 3 0 1 1-6 0 3 3 0 0 1 6 0z',
  moon: 'M12.8 10.5A5.8 5.8 0 0 1 5.5 3.2 5.8 5.8 0 1 0 12.8 10.5z',
  parts: 'M2.5 13.5V9h3v4.5zM6.5 13.5V5h3v8.5zM10.5 13.5V7h3v6.5z',
  merge: 'M3 3v4a3 3 0 0 0 3 3h7M13 10l-2.4-2.2M13 10l-2.4 2.2',
  fly: 'M2 8h12M8 2.5 13.5 8 8 13.5',
}

export function icon(name: keyof typeof ICON_PATHS | string, size = 14): SVGSVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  svg.setAttribute('viewBox', '0 0 16 16')
  svg.setAttribute('width', String(size))
  svg.setAttribute('height', String(size))
  svg.setAttribute('fill', 'none')
  svg.setAttribute('aria-hidden', 'true')
  svg.dataset.icon = name
  const p = document.createElementNS('http://www.w3.org/2000/svg', 'path')
  p.setAttribute('d', ICON_PATHS[name] ?? ICON_PATHS.help)
  p.setAttribute('stroke', 'currentColor')
  p.setAttribute('stroke-width', '1.4')
  p.setAttribute('stroke-linecap', 'round')
  p.setAttribute('stroke-linejoin', 'round')
  if (name === 'play' || name === 'pause' || name === 'next' || name === 'prev' || name === 'parts') {
    p.setAttribute('fill', 'currentColor')
    p.setAttribute('stroke-width', '0.8')
  }
  svg.append(p)
  return svg
}

/* ------------------------------ sparklines ------------------------------- */

export interface SparkOpts {
  color?: string
  fill?: boolean
  min?: number
  max?: number
  /** Draw a dashed baseline at this value. */
  baseline?: number
}

/**
 * Draw a rolling-history sparkline. Sizes the backing store to the element's box
 * exactly once per size change, so it stays crisp on HiDPI without reallocating
 * every frame.
 */
export function sparkline(canvas: HTMLCanvasElement, data: readonly number[], opts: SparkOpts = {}): void {
  const dpr = Math.min(2, window.devicePixelRatio || 1)
  const w = canvas.clientWidth || 120
  const h = canvas.clientHeight || 26
  if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
    canvas.width = Math.round(w * dpr)
    canvas.height = Math.round(h * dpr)
  }
  const ctx = canvas.getContext('2d')
  if (!ctx) return
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  ctx.clearRect(0, 0, w, h)
  if (data.length < 2) return

  let lo = opts.min ?? Infinity
  let hi = opts.max ?? -Infinity
  if (opts.min == null || opts.max == null) {
    for (const v of data) {
      if (opts.min == null && v < lo) lo = v
      if (opts.max == null && v > hi) hi = v
    }
  }
  if (!isFinite(lo)) lo = 0
  if (!isFinite(hi)) hi = 1
  if (hi - lo < 1e-6) hi = lo + 1

  const pad = 2
  const color = opts.color ?? '#4fd1c5'
  const x = (i: number) => (i / (data.length - 1)) * w
  const y = (v: number) => h - pad - ((v - lo) / (hi - lo)) * (h - pad * 2)

  if (opts.baseline != null && opts.baseline >= lo && opts.baseline <= hi) {
    ctx.strokeStyle = 'rgba(120,170,235,0.22)'
    ctx.setLineDash([2, 3])
    ctx.lineWidth = 1
    ctx.beginPath()
    ctx.moveTo(0, y(opts.baseline))
    ctx.lineTo(w, y(opts.baseline))
    ctx.stroke()
    ctx.setLineDash([])
  }

  ctx.beginPath()
  ctx.moveTo(x(0), y(data[0]))
  for (let i = 1; i < data.length; i++) ctx.lineTo(x(i), y(data[i]))

  if (opts.fill) {
    ctx.save()
    ctx.lineTo(w, h)
    ctx.lineTo(0, h)
    ctx.closePath()
    const g = ctx.createLinearGradient(0, 0, 0, h)
    g.addColorStop(0, color + '44')
    g.addColorStop(1, color + '00')
    ctx.fillStyle = g
    ctx.fill()
    ctx.restore()
    ctx.beginPath()
    ctx.moveTo(x(0), y(data[0]))
    for (let i = 1; i < data.length; i++) ctx.lineTo(x(i), y(data[i]))
  }

  ctx.strokeStyle = color
  ctx.lineWidth = 1.4
  ctx.lineJoin = 'round'
  ctx.stroke()

  // Head dot.
  ctx.fillStyle = color
  ctx.beginPath()
  ctx.arc(x(data.length - 1), y(data[data.length - 1]), 1.9, 0, Math.PI * 2)
  ctx.fill()
}

/* ------------------------------ small bits ------------------------------- */

/** A labelled metric tile that only rewrites the DOM when the value changes. */
export function metricTile(label: string): {
  root: HTMLElement
  set(v: string, state?: '' | 'ok' | 'warn' | 'crit'): void
} {
  const v = el('div', { class: 'ch-metric__v' })
  const root = el('div', { class: 'ch-metric' }, el('div', { class: 'ch-metric__k', text: label }), v)
  let lastState = ''
  return {
    root,
    set(value: string, state: '' | 'ok' | 'warn' | 'crit' = '') {
      setText(v, value)
      if (state !== lastState) {
        v.className = 'ch-metric__v' + (state ? ` is-${state}` : '')
        lastState = state
      }
    },
  }
}

/** Keep a range input's CSS --fill custom property in sync for the gradient track. */
export function syncRangeFill(input: HTMLInputElement): void {
  const min = Number(input.min || 0)
  const max = Number(input.max || 100)
  const val = Number(input.value)
  const pct = max === min ? 0 : ((val - min) / (max - min)) * 100
  input.style.setProperty('--fill', `${pct}%`)
}

/**
 * Log-scaled slider mapping, for things like `insertBlockRows` that span four
 * orders of magnitude. A linear slider spends 90% of its travel in a range
 * nobody cares about.
 */
export const logToLinear = (v: number, min: number, max: number) =>
  (Math.log(Math.max(v, min)) - Math.log(min)) / (Math.log(max) - Math.log(min))
export const linearToLog = (t: number, min: number, max: number) =>
  Math.exp(Math.log(min) + t * (Math.log(max) - Math.log(min)))
