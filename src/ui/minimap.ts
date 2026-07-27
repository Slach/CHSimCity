import { cssColor } from '../core/theme'
import { N_KEEPERS, N_NODES } from '../core/types'
import type { SimState } from '../core/types'
import { clamp01 } from '../core/util'
import { CITY, DISTRICT_BOUNDS, keeperPos, nodeHost, nodeOrigin } from '../world/layout'
import { el, setText } from './uikit'
import type { UiContext, UiModule } from './uikit'

/* ============================================================================
 * THE MINIMAP
 *
 * A plan of the cluster, drawn from the same numbers the 3D scene is built
 * from, so it can never disagree with it: every footprint here comes out of
 * `world/layout.ts` and nothing is transcribed.
 *
 * It answers three questions the 3D view answers badly:
 *
 *   WHERE AM I          the viewer's position and the horizontal field of view,
 *                       as a cone. In fly mode, at 400 units up and pointed at
 *                       a wall, the establishing geography is gone; this keeps
 *                       it.
 *   WHICH NODE IS SICK  each island is filled by its own worst signal — part
 *                       count against `parts_to_throw_insert`, replica delay,
 *                       read-only, down — so a problem is visible without
 *                       flying to it.
 *   HOW DO I GET THERE  click a district to fly to it.
 *
 * It redraws at 12 Hz, not per frame. The camera cone moves continuously and a
 * quarter of a degree of stale heading is not perceptible, while a per-frame
 * canvas repaint at this size is a real cost on the software renderer.
 * ==========================================================================*/

/** Redraws per second. */
const DRAW_HZ = 12

/** Padding inside the canvas, in CSS pixels. */
const PAD = 8

/** Everything the map has to hold, in world units. Derived, never transcribed. */
const WORLD = (() => {
  // DISTRICT_BOUNDS.world is deliberately generous — it is the picking
  // fallback — so fit to what is actually BUILT instead: the union of the real
  // districts, plus a margin so an island on the edge is not clipped.
  let x0 = Infinity
  let x1 = -Infinity
  let z0 = Infinity
  let z1 = -Infinity
  for (const key of Object.keys(DISTRICT_BOUNDS)) {
    if (key === 'world') continue
    const d = DISTRICT_BOUNDS[key]
    x0 = Math.min(x0, d.x[0])
    x1 = Math.max(x1, d.x[1])
    z0 = Math.min(z0, d.z[0])
    z1 = Math.max(z1, d.z[1])
  }
  const margin = 40
  return { x0: x0 - margin, x1: x1 + margin, z0: z0 - margin, z1: z1 + margin }
})()

interface Hotspot {
  /** Component id to fly to. */
  id: string
  label: string
  /** Screen-space rect in CSS pixels, filled on every draw. */
  x: number
  y: number
  w: number
  h: number
}

export function createMinimap(ctx: UiContext): UiModule {
  const mount = document.getElementById('minimap')
  if (!mount) {
    console.warn('[CHSimCity] #minimap is missing — the map has nowhere to live')
    return { update() {}, dispose() {} }
  }

  const canvas = el('canvas', { class: 'map__c' })
  const caption = el('div', { class: 'map__cap', text: 'cluster' })
  const host = el(
    'div',
    { class: 'map', title: 'Click a district to fly to it' },
    canvas,
    caption,
  )
  host.setAttribute('role', 'group')
  host.setAttribute('aria-label', 'Cluster minimap')
  mount.append(host)

  const hotspots: Hotspot[] = []
  let hovered: Hotspot | null = null

  /* --- sizing -------------------------------------------------------------
   * The canvas backing store follows the element's CSS box and the device
   * pixel ratio, and is only reallocated when one of them actually changes —
   * resizing a canvas clears it and is not free. */

  let cssW = 0
  let cssH = 0
  let dpr = 1

  function sizeCanvas(): boolean {
    const w = canvas.clientWidth || 1
    const h = canvas.clientHeight || 1
    const d = Math.min(2, window.devicePixelRatio || 1)
    if (w === cssW && h === cssH && d === dpr) return false
    cssW = w
    cssH = h
    dpr = d
    canvas.width = Math.round(w * d)
    canvas.height = Math.round(h * d)
    return true
  }

  /* --- world → map projection --------------------------------------------
   * North is up, east is right, and the scale is uniform so the plan is not
   * distorted: a square island has to look square or the map is lying about
   * the geography it exists to convey. */

  let scale = 1
  let originX = 0
  let originY = 0

  function computeProjection(): void {
    const w = cssW - PAD * 2
    const h = cssH - PAD * 2
    const spanX = WORLD.x1 - WORLD.x0
    const spanZ = WORLD.z1 - WORLD.z0
    scale = Math.min(w / spanX, h / spanZ)
    originX = PAD + (w - spanX * scale) / 2 - WORLD.x0 * scale
    originY = PAD + (h - spanZ * scale) / 2 - WORLD.z0 * scale
  }

  const mx = (worldX: number): number => originX + worldX * scale
  const my = (worldZ: number): number => originY + worldZ * scale

  /* --- health -------------------------------------------------------------
   * One node, one colour, and the WORST signal wins. A node that is up but
   * read-only is not healthy, and a node that is down is not merely amber. */

  function nodeState(s: SimState, node: number): { color: string; why: string } {
    const nd = s.nodes[node]
    if (nd.status === 'down') return { color: cssColor('crit'), why: 'down' }
    if (nd.replication.readOnly) return { color: cssColor('warn'), why: 'read-only' }
    if (nd.replication.absoluteDelay > 30) {
      return { color: cssColor('crit'), why: `${nd.replication.absoluteDelay.toFixed(0)} s behind` }
    }
    if (nd.replication.absoluteDelay > 5) {
      return { color: cssColor('warn'), why: `${nd.replication.absoluteDelay.toFixed(0)} s behind` }
    }
    let parts = 0
    for (const t of nd.tables) parts += t.activeParts
    // The threshold is per table per node, which is how ClickHouse applies it.
    const worst = Math.max(...nd.tables.map((t) => t.activeParts))
    if (worst >= s.knobs.partsToThrowInsert * 0.8) return { color: cssColor('crit'), why: `${parts} parts` }
    if (worst >= s.knobs.partsToDelayInsert * 0.8) return { color: cssColor('warn'), why: `${parts} parts` }
    return { color: cssColor('partActive'), why: `${parts} parts` }
  }

  /* --- drawing ------------------------------------------------------------ */

  function rect(
    g: CanvasRenderingContext2D,
    id: string,
    label: string,
    x0: number,
    z0: number,
    x1: number,
    z1: number,
    fill: string | null,
    stroke: string,
    lineWidth = 1,
  ): void {
    const px = mx(x0)
    const py = my(z0)
    const pw = Math.max(2, mx(x1) - px)
    const ph = Math.max(2, my(z1) - py)
    if (fill) {
      g.fillStyle = fill
      g.fillRect(px, py, pw, ph)
    }
    g.strokeStyle = stroke
    g.lineWidth = lineWidth
    g.strokeRect(px + 0.5, py + 0.5, pw - 1, ph - 1)
    hotspots.push({ id, label, x: px, y: py, w: pw, h: ph })
  }

  function draw(s: SimState): void {
    const g = canvas.getContext('2d')
    if (!g) return
    computeProjection()
    hotspots.length = 0

    g.setTransform(dpr, 0, 0, dpr, 0, 0)
    g.clearRect(0, 0, cssW, cssH)

    /* --- the ground, so the map reads as a place and not a diagram -------- */
    g.fillStyle = cssColor('ground')
    g.globalAlpha = 0.35
    g.fillRect(0, 0, cssW, cssH)
    g.globalAlpha = 1

    /* --- the client terminal and the initiator ---------------------------- */
    const cb = DISTRICT_BOUNDS.clients
    rect(
      g,
      'clients',
      'Application tier',
      cb.x[0],
      cb.z[0],
      cb.x[1],
      cb.z[1],
      withAlpha(cssColor('client'), 0.2),
      cssColor('client'),
    )
    const db = DISTRICT_BOUNDS.distributed
    // The initiator warms when it is holding blocks no shard has yet seen —
    // the one thing about it worth noticing from across the room.
    let spooled = 0
    for (const n of s.distributed.pendingBlocks) spooled += n
    const distColor = spooled > 8 ? cssColor('warn') : cssColor('distributed')
    rect(
      g,
      'dist',
      spooled > 0 ? `Distributed — ${spooled} blocks spooled` : 'Distributed',
      db.x[0],
      db.z[0],
      db.x[1],
      db.z[1],
      withAlpha(distColor, 0.2),
      distColor,
    )

    /* --- the four islands ------------------------------------------------- */
    const halfW = CITY.node.w / 2
    const halfD = CITY.node.d / 2
    for (let n = 0; n < N_NODES; n++) {
      const o = nodeOrigin(n)
      const st = nodeState(s, n)
      rect(
        g,
        `node.${n}`,
        `${nodeHost(n)} — ${st.why}`,
        o[0] - halfW,
        o[2] - halfD,
        o[0] + halfW,
        o[2] + halfD,
        withAlpha(st.color, 0.3),
        st.color,
        1.4,
      )
      // The yard inside it, so the island reads as a machine with contents.
      const yw = CITY.yard.deckW / 2
      const yd = CITY.yard.deckD / 2
      g.fillStyle = withAlpha(st.color, 0.55)
      g.fillRect(mx(o[0] - yw), my(o[2] - yd), (yw * 2) * scale, (yd * 2) * scale)
    }

    /* --- Keeper ------------------------------------------------------------ */
    const kb = DISTRICT_BOUNDS.keeper
    const keeperUp = s.knobs.keeperConnected
    rect(
      g,
      'keeper.ensemble',
      keeperUp ? 'ClickHouse Keeper' : 'Keeper — UNREACHABLE',
      kb.x[0],
      kb.z[0],
      kb.x[1],
      kb.z[1],
      withAlpha(keeperUp ? cssColor('keeper') : cssColor('crit'), 0.22),
      keeperUp ? cssColor('keeper') : cssColor('crit'),
      keeperUp ? 1 : 1.6,
    )
    for (let i = 0; i < N_KEEPERS; i++) {
      const p = keeperPos(i)
      const leader = s.keepers[i]?.role === 'leader'
      g.fillStyle = keeperUp ? cssColor(leader ? 'ok' : 'keeper') : cssColor('crit')
      const r = leader ? 3 : 2.2
      g.beginPath()
      g.arc(mx(p[0]), my(p[2]), r, 0, Math.PI * 2)
      g.fill()
    }

    /* --- the hovered district gets a brighter edge ------------------------ */
    if (hovered) {
      g.strokeStyle = cssColor('ink')
      g.lineWidth = 1.6
      g.strokeRect(hovered.x + 0.5, hovered.y + 0.5, hovered.w - 1, hovered.h - 1)
    }

    /* --- the viewer -------------------------------------------------------
     * The cone is the HORIZONTAL field of view, derived from the vertical one
     * and the aspect ratio — drawing the vertical field on a plan would make the
     * map claim a much narrower view than the screen actually shows.
     *
     * The establishing shot sits ~900 units south of the cluster, which is well
     * outside the fitted bounds, so the viewer is OFF THE MAP more often than
     * on it. Widening the bounds to contain the camera would shrink the cluster
     * to a third of the canvas to make room for empty ground, so instead the
     * marker is clamped to the edge and drawn as an arrowhead pointing the way
     * the camera is looking. An off-map viewer is still an answer to "where am
     * I"; a missing one is not. */
    const cam = ctx.getCamera()
    const rawX = mx(cam.x)
    const rawY = my(cam.z)
    const inset = 5
    const px = Math.max(inset, Math.min(cssW - inset, rawX))
    const py = Math.max(inset, Math.min(cssH - inset, rawY))
    const offMap = px !== rawX || py !== rawY
    const accent = cssColor(cam.mode === 'fly' ? 'warn' : 'ink')

    if (!offMap) {
      const halfH = Math.atan(Math.tan(cam.fov / 2) * cam.aspect)
      // How far the cone reaches: scaled by altitude, because a viewer 500 m up
      // genuinely takes in more ground than one at street level.
      const reach = clamp01(cam.y / 900) * 260 + 120
      g.save()
      g.translate(px, py)
      // Screen space: +x is world east and +y is world south, so a heading of 0
      // (north, -Z) has to point at -y.
      g.rotate(cam.yaw)
      const rPix = Math.max(1, reach * scale)
      const grad = g.createRadialGradient(0, 0, 0, 0, 0, rPix)
      grad.addColorStop(0, withAlpha(cssColor('reader'), 0.42))
      grad.addColorStop(1, withAlpha(cssColor('reader'), 0))
      g.fillStyle = grad
      g.beginPath()
      g.moveTo(0, 0)
      // -PI/2 puts the arc's centre on -y, which is north.
      g.arc(0, 0, rPix, -Math.PI / 2 - halfH, -Math.PI / 2 + halfH)
      g.closePath()
      g.fill()
      g.restore()

      g.fillStyle = accent
      g.beginPath()
      g.arc(px, py, 3, 0, Math.PI * 2)
      g.fill()
      g.strokeStyle = withAlpha(cssColor('bg'), 0.8)
      g.lineWidth = 1
      g.stroke()
    } else {
      // An arrowhead on the edge, pointing where the camera is looking.
      g.save()
      g.translate(px, py)
      g.rotate(cam.yaw)
      g.fillStyle = accent
      g.globalAlpha = 0.85
      g.beginPath()
      g.moveTo(0, -5)
      g.lineTo(4, 4)
      g.lineTo(0, 1.5)
      g.lineTo(-4, 4)
      g.closePath()
      g.fill()
      g.restore()
      g.globalAlpha = 1
    }

    /* --- north --------------------------------------------------------- */
    g.fillStyle = cssColor('inkDim')
    g.font = '600 9px ui-monospace, monospace'
    g.textAlign = 'center'
    g.textBaseline = 'top'
    g.fillText('N', cssW / 2, 2)
  }

  /** `cssColor` returns #rrggbb; canvas needs an alpha channel appended. */
  function withAlpha(hex: string, a: number): string {
    const v = Math.round(clamp01(a) * 255)
      .toString(16)
      .padStart(2, '0')
    return `${hex}${v}`
  }

  /* --- interaction -------------------------------------------------------- */

  function at(ev: PointerEvent | MouseEvent): Hotspot | null {
    const r = canvas.getBoundingClientRect()
    const x = ev.clientX - r.left
    const y = ev.clientY - r.top
    // Last drawn wins: the islands are pushed after the district rectangles
    // that contain them, so the smaller, more specific target is found first.
    for (let i = hotspots.length - 1; i >= 0; i--) {
      const h = hotspots[i]
      if (x >= h.x && x <= h.x + h.w && y >= h.y && y <= h.y + h.h) return h
    }
    return null
  }

  function onMove(ev: PointerEvent): void {
    const h = at(ev)
    if (h === hovered) return
    hovered = h
    setText(caption, h ? h.label : 'cluster')
    canvas.style.cursor = h ? 'pointer' : 'default'
  }

  function onLeave(): void {
    hovered = null
    setText(caption, 'cluster')
    canvas.style.cursor = 'default'
  }

  function onClick(ev: MouseEvent): void {
    const h = at(ev)
    if (!h) return
    ctx.bus.emit('focus', { id: h.id })
    ctx.bus.emit('select', { id: h.id })
  }

  canvas.addEventListener('pointermove', onMove)
  canvas.addEventListener('pointerleave', onLeave)
  canvas.addEventListener('click', onClick)

  /* --- frame -------------------------------------------------------------- */

  let acc = 1 / DRAW_HZ

  return {
    update(dt: number) {
      acc += dt
      const resized = sizeCanvas()
      if (!resized && acc < 1 / DRAW_HZ) return
      acc = 0
      draw(ctx.sim.state)
    },
    dispose() {
      canvas.removeEventListener('pointermove', onMove)
      canvas.removeEventListener('pointerleave', onLeave)
      canvas.removeEventListener('click', onClick)
      host.remove()
    },
  }
}
