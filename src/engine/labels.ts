import * as THREE from 'three'
import { CSS2DObject, CSS2DRenderer } from 'three/examples/jsm/renderers/CSS2DRenderer.js'

import '../styles/labels.css'
import { COLOR, hexCss } from '../core/theme'
import type { Registry } from '../core/registry'
import type { Bus, ComponentDef, DistrictId, QualitySettings, SimState } from '../core/types'

/* ============================================================================
 * LABELS — map-grade annotation.
 *
 * A cluster with a hundred named parts cannot simply project every name: capping
 * the *count* does nothing about two chips landing on the same pixels. So this
 * layer does what a map renderer does, in three parts:
 *
 *  1. ZOOM HIERARCHY. Every anchor is scored against its own distance to the
 *     camera, so the far shard stays coarse while the island you flew to
 *     annotates itself in detail:
 *
 *        tier 0    districts and landmarks, visible from far out
 *        tier 1    structures
 *        tier 2    detail, only up close
 *
 *     Neighbouring levels overlap in a fade band, so one hands over to the next
 *     instead of blinking.
 *
 *  2. SCREEN-SPACE COLLISION. Each pass projects the candidates to pixels, sorts
 *     them by priority and places them greedily against a uniform grid of the
 *     rects already down. A chip that does not fit at its home offset is tried at
 *     several alternates before it is given up on.
 *
 *  3. HYSTERESIS. Recomputing placement from scratch makes boundary labels
 *     strobe as the camera drifts, which reads far worse than overlap. So a shown
 *     label outranks an equal-tier hidden one, tolerates a few pixels of real
 *     overlap before it is dropped, and cannot be dropped inside its minimum
 *     dwell. A hidden one needs clear space and a short cooldown to come back.
 *
 * Cost: the full pass runs at ~9 Hz, never per frame. Chip boxes are measured
 * once at construction and re-measured only when their content really changes
 * width; every read in a pass happens before every write, so a pass costs at
 * most one layout. The hot path allocates nothing.
 * ==========================================================================*/

/* --- zoom hierarchy: world units from the camera to the anchor ------------- */
/**
 * Per tier: gone beyond TIER_OUT, full below TIER_OUT - TIER_BAND.
 *
 * Tier 0 has to survive the ESTABLISHING SHOT, which sits ~1070 units from the
 * pivot and therefore 1000–1250 from each island's anchor. At 900 the district
 * names all faded out at exactly the moment the whole cluster first came into
 * view, which is the one moment they matter most.
 */
const TIER_OUT = [1700, 520, 200]
const TIER_BAND = [340, 130, 60]
/** Past this the chip drops its role line and its readout. */
const FAR_DIST = 340
/** Below this much of its level's fade, a label is not worth the space. */
const MIN_VIS = 0.12
/** …and above 1/VIS_GAIN of it, it is drawn at full strength. */
const VIS_GAIN = 2.2

/* --- priority bands, lowest wins ------------------------------------------ */
const B_SELECTED = 0
const B_HOVERED = 1
const B_FOCUS = 2
const B_TIER = [4, 6, 7]
/** Bands sit this far apart; distance is the within-band tiebreak. */
const BAND_STEP = 100000
/** A shown label beats a hidden one of the same band — never crosses a band. */
const STICKY = 40000

/* --- timing --------------------------------------------------------------- */
/** Full placement pass ~9x/sec. Faster is invisible and costs a layout. */
const PASS_SEC = 1 / 9
/** Readouts tick at 6 Hz; faster just makes numbers unreadable. */
const READOUT_SEC = 1 / 6
/** Must match the opacity transition on .lbl. */
const FADE_SEC = 0.22
/**
 * A label cannot be collided away inside this long of appearing, nor come back
 * inside HIDE_COOLDOWN of being dropped. Both are measured against the WALL
 * clock, not the frame delta: main.ts clamps dt to 0.1 s so a stalled frame
 * cannot teleport the scene, and accumulating that would stretch a 0.7 s pin
 * into seven real seconds on a slow machine.
 */
const MIN_DWELL = 0.7
const HIDE_COOLDOWN = 0.3
/** How long a tour or scenario focus keeps its priority boost. */
const FOCUS_TTL = 30

/* --- placement geometry, pixels ------------------------------------------- */
const GAP_X = 16
const GAP_Y = 16
/** A hidden label needs this much clear space around it to be placed… */
const PAD_NEW = 8
/** …a shown one tolerates this much real overlap before it is dropped. */
const PAD_KEEP = -3
/** What a label that MUST be placed will squeeze into as a last resort. */
const PAD_CRAMP = -14
/** Keep chips this far off the viewport edge. */
const EDGE = 6
/**
 * Candidate offsets, tried in this order: home, other side, lifted, centred,
 * below. 0 = centred over the anchor, which is the only thing that will seat a
 * wide chip whose anchor sits mid-screen.
 */
const VAR_SIDE = [1, -1, 1, -1, 0, 1, -1, 0]
const VAR_UP = [1, 1, 1, 1, 1, -1, -1, 1]
const VAR_LIFT = [0, 0, 30, 30, 0, 0, 0, 56]
const N_VAR = 8

/* --- collision grid ------------------------------------------------------- */
const CELL = 96
const CELL_CAP = 20
const MAX_RECTS = 96

/** Fallback accent per district, overridden by ComponentDef.color. */
const DISTRICT_COLOR: Record<DistrictId, number> = {
  clients: COLOR.client,
  nodes: COLOR.node,
  storage: COLOR.hot,
  merges: COLOR.merge,
  ttl: COLOR.ttl,
  replication: COLOR.replication,
  keeper: COLOR.keeper,
  world: COLOR.ink,
}

/** A plausible readout, so the very first measurement reserves room for one. */
const READ_FILLER = '000000 parts · 0000 rows/s'

/* --- module-scope scratch: the hot path must not allocate ------------------ */
const _proj = new THREE.Matrix4()
const _v4 = new THREE.Vector4()

/** 0 = off, 1 = armed (mounted, not yet transitioned), 2 = on, 3 = fading out. */
type LabelPhase = 0 | 1 | 2 | 3

interface Entry {
  id: string
  def: ComponentDef
  rank: 0 | 1 | 2
  el: HTMLDivElement
  chip: HTMLElement
  read: HTMLElement | null
  obj: CSS2DObject
  pos: THREE.Vector3

  /* measured chip box, in both forms */
  nearW: number
  nearH: number
  farW: number
  farH: number
  needMeasure: boolean
  measuredRead: number

  /* per pass */
  dist: number
  onScreen: boolean
  sx: number
  sy: number
  band: number
  prio: number
  alpha: number
  place: boolean

  /* sticky state — wall-clock seconds, see MIN_DWELL */
  shown: boolean
  sinceT: number
  variant: number
  dx: number
  dy: number

  /* DOM write cache */
  far: boolean
  phase: LabelPhase
  fadeT: number
  lastRead: string
  lastOpacity: number
  lastDx: number
  lastDy: number
  nudged: boolean
}

export interface LabelsApi {
  /** Add this to the scene — the CSS2D objects hang off it. */
  group: THREE.Object3D
  update(dt: number, camera: THREE.PerspectiveCamera, sim: SimState): void
  render(scene: THREE.Scene, camera: THREE.PerspectiveCamera): void
  resize(w: number, h: number): void
  setQuality(q: QualitySettings): void
  dispose(): void
}

export function createLabels(container: HTMLElement, registry: Registry, bus: Bus): LabelsApi {
  const group = new THREE.Group()
  group.name = 'labels'

  const renderer = new CSS2DRenderer()
  // We own stacking order (see .lbl.is-selected); skip the per-frame sort and
  // the z-index write it does on every element.
  renderer.sortObjects = false
  const dom = renderer.domElement
  dom.className = 'lbl-layer'
  dom.style.position = 'absolute'
  dom.style.top = '0'
  dom.style.left = '0'
  dom.style.pointerEvents = 'none'
  container.appendChild(dom)

  let viewW = container.clientWidth || window.innerWidth
  let viewH = container.clientHeight || window.innerHeight
  renderer.setSize(viewW, viewH)

  /** Off-screen host that sizes chips before they are ever mounted. */
  const measureHost = document.createElement('div')
  measureHost.className = 'lbl-measure'
  dom.appendChild(measureHost)

  const entries: Entry[] = []
  const byId = new Map<string, Entry>()
  /** Reused between passes; never re-allocated. */
  const cand: Entry[] = []
  const pendingMeasure: Entry[] = []
  let componentCount = 0

  let maxLabels = 26
  let selectedId: string | null = null
  let hoveredId: string | null = null
  let focusId: string | null = null
  let focusUntil = 0
  /** Wall clock, seconds, sampled once per frame. */
  let now = performance.now() / 1000
  /** Which chip the pointer is physically over, so we only emit on change. */
  let domHoverId: string | null = null
  let passT = PASS_SEC
  let readT = 0

  /* --------------------------------- DOM --------------------------------- */

  function makeEntry(def: ComponentDef): Entry {
    const accent = def.color ?? DISTRICT_COLOR[def.district] ?? COLOR.ink
    const el = document.createElement('div')
    el.className = 'lbl'
    el.style.setProperty('--lbl-accent', hexCss(accent))
    el.dataset.id = def.id

    const leader = document.createElement('span')
    leader.className = 'lbl__leader'
    const dot = document.createElement('span')
    dot.className = 'lbl__dot'

    const chip = document.createElement('div')
    chip.className = 'lbl__chip'

    const nameEl = document.createElement('span')
    nameEl.className = 'lbl__name'
    nameEl.textContent = def.name
    chip.appendChild(nameEl)

    if (def.role) {
      const roleEl = document.createElement('span')
      roleEl.className = 'lbl__role'
      roleEl.textContent = def.role
      chip.appendChild(roleEl)
    }

    let read: HTMLElement | null = null
    if (def.readout) {
      read = document.createElement('span')
      read.className = 'lbl__read'
      // Reserve a plausible readout width for the first measurement; the real
      // string replaces it on the first pass this label is a candidate.
      read.textContent = READ_FILLER
      chip.appendChild(read)
    }

    el.appendChild(leader)
    el.appendChild(dot)
    el.appendChild(chip)

    const obj = new CSS2DObject(el)
    // (0,0) against a zero-height .lbl puts the anchor exactly on the element's
    // origin, so every chip offset below is measured from the world point.
    obj.center.set(0, 0)
    obj.visible = false

    const at = def.labelAt ?? def.focus.target
    const e: Entry = {
      id: def.id,
      def,
      rank: def.tier,
      el,
      chip,
      read,
      obj,
      pos: new THREE.Vector3(at[0], at[1], at[2]),
      nearW: 130,
      nearH: 34,
      farW: 96,
      farH: 20,
      needMeasure: false,
      measuredRead: READ_FILLER.length,
      dist: 0,
      onScreen: false,
      sx: 0,
      sy: 0,
      band: B_TIER[2],
      prio: 0,
      alpha: 0,
      place: false,
      shown: false,
      sinceT: -1e6,
      variant: 0,
      dx: GAP_X,
      dy: -GAP_Y - 34,
      far: false,
      phase: 0,
      fadeT: 0,
      lastRead: '',
      lastOpacity: -1,
      lastDx: NaN,
      lastDy: NaN,
      nudged: false,
    }
    obj.position.copy(e.pos)
    if (def.id === selectedId) el.classList.add('is-selected')
    if (def.id === hoveredId) el.classList.add('is-hovered')
    return e
  }

  /**
   * Size every new chip in both forms, off-screen, before it can be placed. Two
   * layouts per batch — and none afterwards for anything whose text never
   * changes width.
   */
  function measureBatch(): void {
    const n = pendingMeasure.length
    if (!n) return
    for (let i = 0; i < n; i++) measureHost.appendChild(pendingMeasure[i].el)
    for (let i = 0; i < n; i++) {
      const e = pendingMeasure[i]
      e.nearW = e.chip.offsetWidth
      e.nearH = e.chip.offsetHeight
    }
    for (let i = 0; i < n; i++) pendingMeasure[i].el.classList.add('is-far')
    for (let i = 0; i < n; i++) {
      const e = pendingMeasure[i]
      e.farW = e.chip.offsetWidth
      e.farH = e.chip.offsetHeight
    }
    for (let i = 0; i < n; i++) {
      const e = pendingMeasure[i]
      e.el.classList.remove('is-far')
      if (e.read) e.read.textContent = ''
      measureHost.removeChild(e.el)
      group.add(e.obj)
    }
    pendingMeasure.length = 0
  }

  /** Pick up components registered since the last frame. */
  function sync(): void {
    const all = registry.all()
    let added = 0
    for (let i = 0; i < all.length; i++) {
      const def = all[i]
      if (byId.has(def.id)) continue
      const e = makeEntry(def)
      byId.set(def.id, e)
      entries.push(e)
      pendingMeasure.push(e)
      added++
    }
    componentCount = all.length
    if (added) measureBatch()
  }

  /* ------------------------------ interaction ---------------------------- */

  function idFrom(target: EventTarget | null): string | null {
    const node = target as HTMLElement | null
    if (!node || typeof node.closest !== 'function') return null
    const host = node.closest('.lbl') as HTMLElement | null
    return host?.dataset.id ?? null
  }

  function onClick(ev: MouseEvent): void {
    const id = idFrom(ev.target)
    if (!id) return
    ev.stopPropagation()
    bus.emit('select', { id })
  }

  function onDblClick(ev: MouseEvent): void {
    const id = idFrom(ev.target)
    if (!id) return
    ev.stopPropagation()
    bus.emit('focus', { id })
  }

  function onOver(ev: PointerEvent): void {
    const id = idFrom(ev.target)
    if (!id || id === domHoverId) return
    domHoverId = id
    bus.emit('hover', { id })
  }

  function onOut(ev: PointerEvent): void {
    if (!domHoverId) return
    // Moving between the chip and its dot must not read as "left the label".
    if (idFrom(ev.relatedTarget) === domHoverId) return
    domHoverId = null
    bus.emit('hover', { id: null })
  }

  // Delegated: four listeners for the whole layer instead of four per chip.
  dom.addEventListener('click', onClick)
  dom.addEventListener('dblclick', onDblClick)
  dom.addEventListener('pointerover', onOver)
  dom.addEventListener('pointerout', onOut)

  const offSelect = bus.on('select', ({ id }) => {
    if (id === selectedId) return
    byId.get(selectedId ?? '')?.el.classList.remove('is-selected')
    selectedId = id
    byId.get(id ?? '')?.el.classList.add('is-selected')
    passT = PASS_SEC // the selection must show even if it was budgeted out
  })

  const offHover = bus.on('hover', ({ id }) => {
    if (id === hoveredId) return
    byId.get(hoveredId ?? '')?.el.classList.remove('is-hovered')
    hoveredId = id
    byId.get(id ?? '')?.el.classList.add('is-hovered')
    passT = PASS_SEC
  })

  // The tour and the scenarios aim the camera through 'focus'; whatever they are
  // pointing at outranks everything but the user's own selection.
  const offFocus = bus.on('focus', ({ id }) => {
    focusId = id
    focusUntil = id ? performance.now() / 1000 + FOCUS_TTL : 0
    passT = PASS_SEC
  })

  /* ------------------------- HUD-aware placement box ---------------------- */

  const hudTop = document.getElementById('hud-top')
  const hudBottom = document.getElementById('hud-bottom')
  const hudLeft = document.getElementById('hud-left')
  const hudRight = document.getElementById('hud-right')
  const hudToasts = document.getElementById('toast-stack')
  let boxL = 0
  let boxT = 0
  let boxR = 0
  let boxB = 0

  /** A label under the console or the inspector is invisible — do not spend one. */
  function readBox(): void {
    boxL = EDGE
    boxT = EDGE
    boxR = viewW - EDGE
    boxB = viewH - EDGE
    if (hudTop) {
      const r = hudTop.getBoundingClientRect()
      if (r.height > 0) boxT = Math.max(boxT, r.bottom + 6)
    }
    if (hudBottom) {
      const r = hudBottom.getBoundingClientRect()
      if (r.height > 0) boxB = Math.min(boxB, r.top - 6)
    }
    if (hudLeft) {
      const r = hudLeft.getBoundingClientRect()
      if (r.width > 0) boxL = Math.max(boxL, r.right + 6)
    }
    if (hudRight) {
      const r = hudRight.getBoundingClientRect()
      if (r.width > 0) boxR = Math.min(boxR, r.left - 6)
    }
    // A layout we did not anticipate must never squeeze the labels out entirely.
    if (boxR - boxL < 260 || boxB - boxT < 180) {
      boxL = EDGE
      boxT = EDGE
      boxR = viewW - EDGE
      boxB = viewH - EDGE
    }
  }

  /* ----------------------------- collision grid --------------------------- */

  const rX = new Float32Array(MAX_RECTS)
  const rY = new Float32Array(MAX_RECTS)
  const rW = new Float32Array(MAX_RECTS)
  const rH = new Float32Array(MAX_RECTS)
  let rectN = 0
  let gCols = 0
  let gRows = 0
  let gCells = new Int32Array(0)
  let gCounts = new Int32Array(0)
  let gDegraded = false

  function ensureGrid(): void {
    const c = Math.max(1, Math.ceil(viewW / CELL))
    const r = Math.max(1, Math.ceil(viewH / CELL))
    if (c === gCols && r === gRows) return
    gCols = c
    gRows = r
    gCells = new Int32Array(c * r * CELL_CAP)
    gCounts = new Int32Array(c * r)
  }

  function gridReset(): void {
    gCounts.fill(0)
    rectN = 0
    gDegraded = false
  }

  function cellIdx(v: number, max: number): number {
    const i = Math.floor(v / CELL)
    return i < 0 ? 0 : i > max ? max : i
  }

  function addRect(x: number, y: number, w: number, h: number): void {
    if (rectN >= MAX_RECTS) {
      gDegraded = true
      return
    }
    const i = rectN++
    rX[i] = x
    rY[i] = y
    rW[i] = w
    rH[i] = h
    const c0 = cellIdx(x, gCols - 1)
    const c1 = cellIdx(x + w, gCols - 1)
    const r0 = cellIdx(y, gRows - 1)
    const r1 = cellIdx(y + h, gRows - 1)
    for (let r = r0; r <= r1; r++) {
      for (let c = c0; c <= c1; c++) {
        const k = r * gCols + c
        const n = gCounts[k]
        if (n >= CELL_CAP) {
          // One overfull cell drops this pass to a linear scan. With under a
          // hundred rects that is still microseconds, and it cannot miss a hit.
          gDegraded = true
          continue
        }
        gCells[k * CELL_CAP + n] = i
        gCounts[k] = n + 1
      }
    }
  }

  function hitsRect(i: number, x: number, y: number, w: number, h: number): boolean {
    return x < rX[i] + rW[i] && x + w > rX[i] && y < rY[i] + rH[i] && y + h > rY[i]
  }

  function hits(x: number, y: number, w: number, h: number): boolean {
    if (gDegraded) {
      for (let i = 0; i < rectN; i++) if (hitsRect(i, x, y, w, h)) return true
      return false
    }
    const c0 = cellIdx(x, gCols - 1)
    const c1 = cellIdx(x + w, gCols - 1)
    const r0 = cellIdx(y, gRows - 1)
    const r1 = cellIdx(y + h, gRows - 1)
    for (let r = r0; r <= r1; r++) {
      for (let c = c0; c <= c1; c++) {
        const k = r * gCols + c
        const n = gCounts[k]
        const base = k * CELL_CAP
        for (let j = 0; j < n; j++) if (hitsRect(gCells[base + j], x, y, w, h)) return true
      }
    }
    return false
  }

  /* -------------------------------- the pass ------------------------------ */

  let vx = 0
  let vy = 0

  /** Chip top-left for variant v, in screen pixels. Writes vx / vy. */
  function variantAt(e: Entry, v: number, w: number, h: number): void {
    const side = VAR_SIDE[v]
    vx = side > 0 ? e.sx + GAP_X : side < 0 ? e.sx - GAP_X - w : e.sx - w * 0.5
    vy = VAR_UP[v] > 0 ? e.sy - GAP_Y - h - VAR_LIFT[v] : e.sy + GAP_Y + VAR_LIFT[v]
  }

  function fits(e: Entry, v: number, w: number, h: number, pad: number): boolean {
    variantAt(e, v, w, h)
    if (vx - pad < boxL || vx + w + pad > boxR || vy - pad < boxT || vy + h + pad > boxB) return false
    return !hits(vx - pad, vy - pad, w + pad * 2, h + pad * 2)
  }

  function reserveHudRect(node: HTMLElement | null): void {
    if (!node) return
    const r = node.getBoundingClientRect()
    if (r.width <= 0 || r.height <= 0) return
    addRect(r.left - 6, r.top - 6, r.width + 12, r.height + 12)
  }

  function pass(camera: THREE.PerspectiveCamera): void {
    /* ---- READ PHASE — nothing below here may touch the DOM ------------- */
    readBox()
    for (let i = 0; i < entries.length; i++) {
      const e = entries[i]
      if (!e.needMeasure || e.phase === 0) continue
      const w = e.chip.offsetWidth
      if (w > 0) {
        // Whichever form it happens to be wearing right now.
        if (e.far) {
          e.farW = w
          e.farH = e.chip.offsetHeight
        } else {
          e.nearW = w
          e.nearH = e.chip.offsetHeight
        }
        e.needMeasure = false
      }
    }

    /* ---- score ---------------------------------------------------------- */
    _proj.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse)
    const hw = viewW * 0.5
    const hh = viewH * 0.5
    cand.length = 0

    for (let i = 0; i < entries.length; i++) {
      const e = entries[i]
      e.place = false
      e.onScreen = false
      e.dist = camera.position.distanceTo(e.pos)
      if (!e.def.object.visible) continue

      _v4.set(e.pos.x, e.pos.y, e.pos.z, 1).applyMatrix4(_proj)
      const cw = _v4.w
      if (cw <= 1e-6) continue // behind the camera
      const nz = _v4.z / cw
      if (nz < -1 || nz > 1) continue // CSS2DRenderer would hide it anyway
      const sx = (_v4.x / cw) * hw + hw
      const sy = -(_v4.y / cw) * hh + hh
      // There is no value in a leader pointing behind an inspector to something
      // the visitor cannot see.
      if (sx < boxL - 90 || sx > boxR + 90 || sy < boxT - 90 || sy > boxB + 90) continue
      e.sx = sx
      e.sy = sy
      e.onScreen = true

      const forced = e.id === selectedId || e.id === hoveredId
      const focused = !forced && now < focusUntil && e.id === focusId
      let band = B_TIER[e.rank]
      let vis = fadeOut(e.dist, TIER_OUT[e.rank], TIER_BAND[e.rank])
      if (vis <= MIN_VIS && !forced && !focused) continue

      if (forced) {
        band = e.id === selectedId ? B_SELECTED : B_HOVERED
        vis = 1
      } else if (focused) {
        band = B_FOCUS
        vis = 1
      }

      e.band = band
      e.alpha = vis * VIS_GAIN > 1 ? 1 : vis * VIS_GAIN
      e.prio = band * BAND_STEP + (e.dist < 60000 ? e.dist : 60000) - (e.shown ? STICKY : 0)
      cand.push(e)
    }

    cand.sort(byPrio)

    /* ---- place ---------------------------------------------------------- */
    ensureGrid()
    gridReset()
    reserveHudRect(hudToasts)
    let budget = maxLabels

    for (let i = 0; i < cand.length; i++) {
      const e = cand[i]
      const w = e.far ? e.farW : e.nearW
      const h = e.far ? e.farH : e.nearH
      // Selected and hovered are placed first and are never collided away;
      // anything inside its dwell is held down so nothing can blink.
      const age = now - e.sinceT
      const pinned = e.band <= B_HOVERED || (e.shown && age < MIN_DWELL)
      const cooling = !e.shown && age < HIDE_COOLDOWN && e.band > B_FOCUS
      const pad = e.shown ? PAD_KEEP : PAD_NEW
      let v = -1

      if ((budget > 0 || pinned) && (!cooling || pinned)) {
        // Preserve the last successful slot whenever it remains valid. Trying
        // "home" first defeats the placer's own hysteresis: two labels can
        // repeatedly reclaim one another's pixels at a fixed camera.
        if (e.shown && fits(e, e.variant, w, h, pad)) v = e.variant
        else if (fits(e, 0, w, h, pad)) v = 0
        else {
          for (let k = 1; k < N_VAR; k++) {
            if (k === e.variant) continue
            if (fits(e, k, w, h, pad)) {
              v = k
              break
            }
          }
        }
      }
      // A pinned label has to go down somewhere — it is the selection, or too
      // young to drop without strobing. Take the least-bad slot.
      if (v < 0 && pinned) {
        for (let k = 0; k < N_VAR; k++) {
          if (fits(e, k, w, h, PAD_CRAMP)) {
            v = k
            break
          }
        }
        if (v < 0) v = e.variant
      }

      if (v < 0) continue
      variantAt(e, v, w, h)
      e.variant = v
      e.dx = vx - e.sx
      e.dy = vy - e.sy
      e.place = true
      budget--
      addRect(vx, vy, w, h)
    }

    /* ---- WRITE PHASE ---------------------------------------------------- */
    for (let i = 0; i < entries.length; i++) {
      const e = entries[i]

      const far = e.dist > FAR_DIST
      if (far !== e.far) {
        e.far = far
        e.el.classList.toggle('is-far', far)
        // The form we are switching into may have been sized before this chip
        // grew a readout, so take its box again next pass.
        e.needMeasure = true
      }

      if (e.place && (e.dx !== e.lastDx || e.dy !== e.lastDy)) {
        e.lastDx = e.dx
        e.lastDy = e.dy
        const w = e.far ? e.farW : e.nearW
        const h = e.far ? e.farH : e.nearH
        // The leader runs from the anchor to whichever chip corner is nearest.
        const cx = e.dx > 0 ? e.dx : e.dx + w < 0 ? e.dx + w : 0
        const cy = e.dy > 0 ? e.dy : e.dy + h < 0 ? e.dy + h : 0
        const st = e.el.style
        st.setProperty('--lbl-dx', `${e.dx.toFixed(1)}px`)
        st.setProperty('--lbl-dy', `${e.dy.toFixed(1)}px`)
        st.setProperty('--lbl-lead', `${Math.sqrt(cx * cx + cy * cy).toFixed(1)}px`)
        st.setProperty('--lbl-lead-a', `${((Math.atan2(cy, cx) * 180) / Math.PI).toFixed(1)}deg`)
        const nudged = e.variant !== 0
        if (nudged !== e.nudged) {
          e.nudged = nudged
          e.el.classList.toggle('is-nudged', nudged)
        }
      }
    }
  }

  /* --------------------------------- frame -------------------------------- */

  function update(dt: number, camera: THREE.PerspectiveCamera, sim: SimState): void {
    now = performance.now() / 1000
    if (componentCount !== registry.all().length) {
      sync()
      passT = PASS_SEC
    }
    passT += dt
    if (passT >= PASS_SEC) {
      passT = 0
      pass(camera)
    }

    for (let i = 0; i < entries.length; i++) {
      const e = entries[i]

      if (e.place !== e.shown) {
        e.shown = e.place
        e.sinceT = now
      }

      const target = e.shown ? e.alpha : 0
      if (target > 0.01) {
        if (e.phase === 0) {
          // Mount this frame, transition next frame — otherwise the element goes
          // from display:none straight to its final style and never fades.
          e.obj.visible = true
          e.phase = 1
          setOpacity(e, 0)
        } else {
          if (e.phase !== 2) {
            e.el.classList.add('is-on')
            e.phase = 2
          }
          setOpacity(e, target)
        }
      } else if (e.phase === 1 || e.phase === 2) {
        e.el.classList.remove('is-on')
        setOpacity(e, 0)
        e.phase = 3
        e.fadeT = FADE_SEC
      } else if (e.phase === 3) {
        e.fadeT -= dt
        if (e.fadeT <= 0) {
          e.obj.visible = false
          e.phase = 0
        }
      }
    }

    readT += dt
    if (readT >= READOUT_SEC) {
      readT = 0
      for (let i = 0; i < entries.length; i++) {
        const e = entries[i]
        if (!e.read || e.far || !e.def.readout) continue
        if (e.phase === 0 && !e.place) continue
        let text = ''
        try {
          text = e.def.readout(sim)
        } catch {
          text = ''
        }
        if (text !== e.lastRead) {
          // The readout is tabular, so the same length is the same pixels —
          // only a real width change is worth a re-measure.
          if (text.length !== e.measuredRead) {
            e.measuredRead = text.length
            e.needMeasure = true
          }
          e.lastRead = text
          e.read.textContent = text
        }
      }
    }
  }

  function setOpacity(e: Entry, v: number): void {
    if (Math.abs(v - e.lastOpacity) < 0.012) return
    e.lastOpacity = v
    e.el.style.opacity = v.toFixed(3)
  }

  function render(scene: THREE.Scene, camera: THREE.PerspectiveCamera): void {
    renderer.render(scene, camera)
  }

  function resize(w: number, h: number): void {
    viewW = w
    viewH = h
    renderer.setSize(w, h)
    passT = PASS_SEC
  }

  function setQuality(q: QualitySettings): void {
    maxLabels = Math.max(4, Math.floor(q.maxLabels))
    passT = PASS_SEC
  }

  function dispose(): void {
    dom.removeEventListener('click', onClick)
    dom.removeEventListener('dblclick', onDblClick)
    dom.removeEventListener('pointerover', onOver)
    dom.removeEventListener('pointerout', onOut)
    offSelect()
    offHover()
    offFocus()
    for (let i = 0; i < entries.length; i++) {
      const e = entries[i]
      group.remove(e.obj) // CSS2DObject's 'removed' handler unmounts the element
      e.el.remove()
    }
    entries.length = 0
    cand.length = 0
    pendingMeasure.length = 0
    byId.clear()
    measureHost.remove()
    dom.remove()
  }

  return { group, update, render, resize, setQuality, dispose }
}

/* --------------------------------- helpers -------------------------------- */

function byPrio(a: Entry, b: Entry): number {
  return a.prio - b.prio
}

/** 0 below `edge - band`, 1 above `edge`, smooth in between. */
function fadeIn(d: number, edge: number, band: number): number {
  const t = (d - (edge - band)) / band
  return t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t)
}

/** 1 below `edge - band`, 0 above `edge`, smooth in between. */
function fadeOut(d: number, edge: number, band: number): number {
  return 1 - fadeIn(d, edge, band)
}
