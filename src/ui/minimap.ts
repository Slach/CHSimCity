import { cssColor } from '../core/theme'
import { N_KEEPERS, N_NODES } from '../core/types'
import type { SimState } from '../core/types'
import { clamp, clamp01 } from '../core/util'
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
 *   WHAT IS OUT THERE   every district, labelled, in its own semantic colour —
 *                       the same colour the district has in the scene.
 *   WHICH NODE IS SICK  an island in trouble abandons its own colour for warn
 *                       or crit, so a problem is visible without flying to it.
 *
 * Click a district to fly to it; click the empty ground to go back to the
 * establishing shot.
 * ==========================================================================*/

/** Padding inside the canvas, in CSS pixels. */
const PAD = 7

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
  const margin = 30
  return { x0: x0 - margin, x1: x1 + margin, z0: z0 - margin, z1: z1 + margin }
})()

/** Aspect the canvas element is sized to, so the plan fills it. */
export const MAP_ASPECT = (WORLD.x1 - WORLD.x0) / (WORLD.z1 - WORLD.z0)

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
  const caption = el('div', { class: 'map__cap', text: 'click to fly there' })
  const host = el('div', { class: 'map' }, canvas, caption)
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

  function sizeCanvas(): void {
    const w = canvas.clientWidth || 1
    const h = canvas.clientHeight || 1
    const d = Math.min(2, window.devicePixelRatio || 1)
    if (w === cssW && h === cssH && d === dpr) return
    cssW = w
    cssH = h
    dpr = d
    canvas.width = Math.round(w * d)
    canvas.height = Math.round(h * d)
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
   * read-only is not healthy, and a node that is down is not merely amber.
   *
   * A healthy island keeps the palette's `node` colour, the same one it has in
   * the scene. An unhealthy one gives it up: on a map this small a semantic
   * fill nobody can read is worth less than an island that is obviously the
   * wrong colour. */

  function nodeState(s: SimState, node: number): { color: string; why: string; alert: boolean } {
    const nd = s.nodes[node]
    if (nd.status === 'down') return { color: cssColor('crit'), why: 'down', alert: true }
    if (nd.replication.readOnly) return { color: cssColor('warn'), why: 'read-only', alert: true }
    const delay = nd.replication.absoluteDelay
    if (delay > 30) return { color: cssColor('crit'), why: `${delay.toFixed(0)} s behind`, alert: true }
    if (delay > 5) return { color: cssColor('warn'), why: `${delay.toFixed(0)} s behind`, alert: true }
    let parts = 0
    for (const t of nd.tables) parts += t.activeParts
    // The threshold is per table per node, which is how ClickHouse applies it.
    let worst = 0
    for (const t of nd.tables) worst = Math.max(worst, t.activeParts)
    if (worst >= s.knobs.partsToThrowInsert * 0.8) {
      return { color: cssColor('crit'), why: `${parts} parts`, alert: true }
    }
    if (worst >= s.knobs.partsToDelayInsert * 0.8) {
      return { color: cssColor('warn'), why: `${parts} parts`, alert: true }
    }
    // Blocks this server accepted through its own `Distributed` table and has
    // not forwarded yet. They are on THIS disk, so a backlog here is this
    // island's problem and belongs to this island's colour.
    let spooled = 0
    for (const b of nd.distributed.pendingBlocks) spooled += b
    if (spooled > 8) return { color: cssColor('warn'), why: `${spooled} blocks spooled`, alert: true }
    return { color: cssColor('node'), why: `${parts} parts`, alert: false }
  }

  /* --- drawing ------------------------------------------------------------ */

  /** `cssColor` returns #rrggbb; canvas needs an alpha channel appended. */
  function withAlpha(hex: string, a: number): string {
    const v = Math.round(clamp01(a) * 255)
      .toString(16)
      .padStart(2, '0')
    return `${hex}${v}`
  }

  /**
   * One district footprint: a filled rect, an edge, a name, and a hit target.
   * The label is drawn inside the rect rather than beside it, so the map needs
   * no legend and reads at a glance — the thing the previous version got
   * wrong, where a district was a pale unlabelled box and the only way to find
   * out what it was was to hover it.
   */
  function district(
    g: CanvasRenderingContext2D,
    id: string,
    name: string,
    caption: string,
    x0: number,
    z0: number,
    x1: number,
    z1: number,
    color: string,
    emphasis = 1,
  ): void {
    const px = mx(x0)
    const py = my(z0)
    const pw = Math.max(3, mx(x1) - px)
    const ph = Math.max(3, my(z1) - py)

    g.fillStyle = withAlpha(color, 0.2 * emphasis)
    g.fillRect(px, py, pw, ph)
    g.strokeStyle = withAlpha(color, 0.7 * emphasis)
    g.lineWidth = emphasis > 1 ? 1.5 : 1
    g.strokeRect(px + 0.5, py + 0.5, pw - 1, ph - 1)

    // Measured, not estimated from the character count: a label that overflows
    // its footprint by two pixels is worse than no label, and the monospace
    // assumption is one theme change away from being wrong.
    if (ph > 9 && g.measureText(name).width + 6 < pw) {
      g.fillStyle = withAlpha(color, 0.95)
      g.fillText(name, px + pw / 2, py + ph / 2)
    }
    hotspots.push({ id, label: caption, x: px, y: py, w: pw, h: ph })
  }

  function draw(s: SimState): void {
    const g = canvas.getContext('2d')
    if (!g) return
    computeProjection()
    hotspots.length = 0

    g.setTransform(dpr, 0, 0, dpr, 0, 0)
    g.clearRect(0, 0, cssW, cssH)
    g.font = '600 7px ui-monospace, SFMono-Regular, Menlo, monospace'
    g.textAlign = 'center'
    g.textBaseline = 'middle'

    /* --- the extent of the built world, as a faint frame ------------------ */
    g.strokeStyle = withAlpha(cssColor('grid'), 0.75)
    g.lineWidth = 1
    g.strokeRect(
      mx(WORLD.x0) + 0.5,
      my(WORLD.z0) + 0.5,
      (WORLD.x1 - WORLD.x0) * scale - 1,
      (WORLD.z1 - WORLD.z0) * scale - 1,
    )

    /* --- north to south, which is also the order data travels ------------- */
    const cb = DISTRICT_BOUNDS.clients
    district(g, 'clients', 'CLIENTS', 'Application tier', cb.x[0], cb.z[0], cb.x[1], cb.z[1], cssColor('client'))

    // No initiator footprint between the clients and the shards: there is no
    // such place. `Distributed` is a table on each of the four islands, so the
    // per-island signal below carries it instead.

    /* --- the four islands --------------------------------------------------
     * Drawn after the `nodes` band that contains them and pushed onto the
     * hotspot list later, so hit-testing — which walks backwards — finds the
     * island rather than the band it sits in. */
    const nb = DISTRICT_BOUNDS.nodes
    g.strokeStyle = withAlpha(cssColor('grid'), 0.9)
    g.lineWidth = 1
    g.strokeRect(mx(nb.x[0]) + 0.5, my(nb.z[0]) + 0.5, (nb.x[1] - nb.x[0]) * scale - 1, (nb.z[1] - nb.z[0]) * scale - 1)

    const halfW = CITY.node.w / 2
    const halfD = CITY.node.d / 2
    for (let n = 0; n < N_NODES; n++) {
      const o = nodeOrigin(n)
      const st = nodeState(s, n)
      district(
        g,
        `node.${n}`,
        nodeHost(n).toUpperCase(),
        `${nodeHost(n)} — ${st.why}`,
        o[0] - halfW,
        o[2] - halfD,
        o[0] + halfW,
        o[2] + halfD,
        st.color,
        st.alert ? 1.6 : 1,
      )
      // The parts yard inside it, so an island reads as a machine with
      // contents rather than an empty plot.
      const yw = (CITY.yard.deckW / 2) * scale
      const yd = (CITY.yard.deckD / 2) * scale
      g.fillStyle = withAlpha(st.color, 0.4)
      g.fillRect(mx(o[0]) - yw, my(o[2]) - yd, yw * 2, yd * 2)
    }

    /* --- Keeper ------------------------------------------------------------ */
    const kb = DISTRICT_BOUNDS.keeper
    const keeperUp = s.knobs.keeperConnected
    district(
      g,
      'keeper.ensemble',
      'KEEPER',
      keeperUp ? 'ClickHouse Keeper' : 'Keeper — UNREACHABLE',
      kb.x[0],
      kb.z[0],
      kb.x[1],
      kb.z[1],
      keeperUp ? cssColor('keeper') : cssColor('crit'),
      keeperUp ? 1 : 1.6,
    )
    for (let i = 0; i < N_KEEPERS; i++) {
      const p = keeperPos(i)
      const leader = s.keepers[i]?.role === 'leader'
      g.fillStyle = keeperUp ? cssColor(leader ? 'ok' : 'keeper') : cssColor('crit')
      g.beginPath()
      g.arc(mx(p[0]), my(p[2]), leader ? 2.8 : 2, 0, Math.PI * 2)
      g.fill()
    }

    /* --- the hovered district gets a brighter edge ------------------------ */
    if (hovered) {
      g.strokeStyle = cssColor('ink')
      g.lineWidth = 1.5
      g.strokeRect(hovered.x + 0.5, hovered.y + 0.5, hovered.w - 1, hovered.h - 1)
    }

    /* --- the viewer -------------------------------------------------------
     * The cone is the HORIZONTAL field of view, derived from the vertical one
     * and the aspect ratio — drawing the vertical field on a plan would make
     * the map claim a much narrower view than the screen actually shows.
     *
     * The establishing shot sits well south of the cluster, outside the fitted
     * bounds, so the viewer is off the map more often than on it. Widening the
     * bounds to contain the camera would shrink the cluster to a third of the
     * canvas to make room for empty ground, so the marker is CLAMPED to the
     * edge instead and keeps its cone. A viewer pinned to the south edge and
     * looking north is still a true answer to "where am I"; the arrowhead this
     * replaces was four pixels of chrome that told nobody anything. */
    const cam = ctx.getCamera()
    const inset = 4
    const px = clamp(mx(cam.x), inset, cssW - inset)
    const py = clamp(my(cam.z), inset, cssH - inset)
    const accent = cssColor(cam.mode === 'fly' ? 'merge' : 'ink')

    const halfFov = Math.atan(Math.tan(cam.fov / 2) * cam.aspect)
    // How far the cone reaches: scaled by altitude, because a viewer 500 m up
    // genuinely takes in more ground than one at street level.
    const reach = Math.max(1, (clamp01(cam.y / 900) * 320 + 140) * scale)

    g.save()
    g.translate(px, py)
    // Screen space: +x is world east and +y is world south. `cam.yaw` is
    // clockwise from north, so rotating by it and drawing the arc centred on
    // -y (north) points the cone where the camera looks.
    g.rotate(cam.yaw)
    const grad = g.createRadialGradient(0, 0, 0, 0, 0, reach)
    grad.addColorStop(0, withAlpha(accent, 0.34))
    grad.addColorStop(1, withAlpha(accent, 0))
    g.fillStyle = grad
    g.beginPath()
    g.moveTo(0, 0)
    g.arc(0, 0, reach, -Math.PI / 2 - halfFov, -Math.PI / 2 + halfFov)
    g.closePath()
    g.fill()
    // A centre line, so the exact bearing is readable and not just the spread.
    g.strokeStyle = withAlpha(accent, 0.5)
    g.lineWidth = 1
    g.beginPath()
    g.moveTo(0, 0)
    g.lineTo(0, -reach * 0.8)
    g.stroke()
    g.restore()

    g.fillStyle = accent
    g.beginPath()
    g.arc(px, py, 2.8, 0, Math.PI * 2)
    g.fill()
    g.strokeStyle = withAlpha(cssColor('bg'), 0.85)
    g.lineWidth = 1
    g.stroke()

    /* --- chrome: which way is north, and which camera you are driving ----- */
    g.font = '600 8px ui-monospace, SFMono-Regular, Menlo, monospace'
    g.textBaseline = 'top'
    g.textAlign = 'left'
    g.fillStyle = withAlpha(cssColor('inkDim'), 0.8)
    g.fillText('N ▲', 4, 3)
    g.textAlign = 'right'
    g.textBaseline = 'bottom'
    g.fillStyle = withAlpha(accent, 0.9)
    g.fillText(cam.mode.toUpperCase(), cssW - 4, cssH - 3)
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

  const REST = 'click to fly there'

  function onMove(ev: PointerEvent): void {
    const h = at(ev)
    if (h === hovered) return
    hovered = h
    setText(caption, h ? h.label : REST)
    canvas.style.cursor = h ? 'pointer' : 'default'
  }

  function onLeave(): void {
    hovered = null
    setText(caption, REST)
    canvas.style.cursor = 'default'
  }

  function onClick(ev: MouseEvent): void {
    const h = at(ev)
    if (h) {
      ctx.bus.emit('focus', { id: h.id })
      ctx.bus.emit('select', { id: h.id })
      return
    }
    // Empty ground: back to the establishing shot. Clicking a map and having
    // nothing happen reads as a broken map.
    ctx.bus.emit('focus', { id: null })
  }

  canvas.addEventListener('pointermove', onMove)
  canvas.addEventListener('pointerleave', onLeave)
  canvas.addEventListener('click', onClick)

  /* --- frame --------------------------------------------------------------
   * Every frame. The cone tracks a camera that is being flown by hand, and at
   * this size — under 200 by 240 CSS pixels of 2D canvas — the repaint does
   * not show up against a scene that is drawing hundreds of instanced meshes. */

  return {
    update() {
      sizeCanvas()
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
