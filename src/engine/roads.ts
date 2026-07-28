import * as THREE from 'three'
import type { RouteDef, ThemeApi } from '../core/types'
import { ROUTES, routeCurve } from '../world/layout'
import { clamp } from '../core/util'

/* ============================================================================
 * ROADS — the static infrastructure the flow particles run on.
 *
 * A route is only drawn if it is marked `visible` in the cluster plan: the roads
 * that teach something (client → initiator, the initiator's fan-out, the write
 * path into the yard, the merge gantry, the fetch wires between replicas, the
 * Keeper traffic) are drawn; the per-reader-thread capillaries are not — they
 * would be visual noise.
 *
 * Roads are faint by design. They are dark infrastructure; the traffic on them
 * is the only thing that glows.
 * ==========================================================================*/

/** Samples along each road polyline. */
const SEGMENTS = 64
/** Roads shorter than this are junctions, not trunk roads — no sleepers. */
const TRUNK_MIN_LENGTH = 90
/** Sleeper spacing, world units. */
const TICK_SPACING = 16
/** Half-width of a sleeper. */
const TICK_HALF = 1.7
/** Keep sleepers off the endpoints, where roads meet buildings. */
const TICK_MARGIN = 9

const UP = new THREE.Vector3(0, 1, 0)
const SIDE = new THREE.Vector3(1, 0, 0)

const _p = new THREE.Vector3()
const _t = new THREE.Vector3()
const _perp = new THREE.Vector3()

/* --- the highlight -------------------------------------------------------
 * A traced duct is a TUBE, not a line, and the reason is not decoration.
 * `LineBasicMaterial` cannot be made thicker than one pixel in WebGL, so the
 * only emphasis a line has left is opacity — and a dark hairline at 0.9 against
 * the day theme's pale ground reads as one more road among forty, which is
 * precisely the confusion the highlight exists to end. Real thickness and a
 * neon material give it a channel the roads do not use at all. */
const TRACE_SEGMENTS = 128
/** World units. A part tower is about 3 across, so this reads without walling. */
const TRACE_RADIUS = 1.15
const TRACE_RADIAL = 6

export interface RoadsApi {
  group: THREE.Group
  /**
   * Light one route end to end, or clear it with `null`.
   *
   * ONE reusable line, refilled in place, rather than brightening the road
   * already drawn: most routes have no road at all (`visible: false`), and the
   * reader capillaries and the query fan-out — exactly the ducts a viewer most
   * needs traced — are among them. A dedicated overlay can trace any route in
   * ROUTES, drawn or not.
   */
  highlight(routeId: string | null): void
  dispose(): void
}

/**
 * Draw the road network. One `Line` per visible route, plus one merged
 * `LineSegments` of sleepers per colour+opacity pair — a few dozen draw calls
 * for the whole cluster.
 */
export function createRoads(theme: ThemeApi): RoadsApi {
  const group = new THREE.Group()
  group.name = 'roads'

  /** key = `${color}|${opacity}` → flat xyz pairs for LineSegments. */
  const ticks = new Map<string, number[]>()

  for (const id of Object.keys(ROUTES)) {
    const def: RouteDef = ROUTES[id]
    if (!def.visible) continue
    const curve = routeCurve(id)
    if (!curve) continue

    const opacity = def.roadOpacity ?? 0.16

    /* --- the road itself --------------------------------------------------*/
    const pos = new Float32Array((SEGMENTS + 1) * 3)
    for (let i = 0; i <= SEGMENTS; i++) {
      curve.getPointAt(i / SEGMENTS, _p)
      pos[i * 3] = _p.x
      pos[i * 3 + 1] = _p.y
      pos[i * 3 + 2] = _p.z
    }
    const geo = new THREE.BufferGeometry()
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3))
    const line = new THREE.Line(geo, theme.line(def.color, opacity))
    line.name = `road:${id}`
    line.renderOrder = -1
    line.raycast = () => {}
    group.add(line)

    /* --- sleepers ---------------------------------------------------------*/
    const length = curve.getLength()
    if (length < TRUNK_MIN_LENGTH) continue

    const tickOpacity = clamp(opacity * 1.6, 0.1, 0.32)
    const key = `${def.color}|${tickOpacity}`
    let buf = ticks.get(key)
    if (!buf) ticks.set(key, (buf = []))

    for (let s = TICK_MARGIN; s <= length - TICK_MARGIN; s += TICK_SPACING) {
      const u = s / length
      curve.getPointAt(u, _p)
      curve.getTangentAt(u, _t)
      _perp.crossVectors(_t, UP)
      if (_perp.lengthSq() < 1e-6) _perp.crossVectors(_t, SIDE) // vertical run
      _perp.normalize().multiplyScalar(TICK_HALF)
      buf.push(
        _p.x - _perp.x,
        _p.y - _perp.y,
        _p.z - _perp.z,
        _p.x + _perp.x,
        _p.y + _perp.y,
        _p.z + _perp.z,
      )
    }
  }

  for (const [key, buf] of ticks) {
    if (buf.length === 0) continue
    const sep = key.indexOf('|')
    const color = Number(key.slice(0, sep))
    const opacity = Number(key.slice(sep + 1))
    const geo = new THREE.BufferGeometry()
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(buf), 3))
    const seg = new THREE.LineSegments(geo, theme.line(color, opacity))
    seg.name = `road:ticks:${key}`
    seg.renderOrder = -1
    seg.raycast = () => {}
    group.add(seg)
  }

  /* --- the highlight overlay ---------------------------------------------- */

  /* The MATERIAL is swapped per highlight, never recoloured in place. Both of
   * the theme's factories are caches keyed by colour, and the theme repaints
   * their entries on a day/night switch — so setting `.color` on one here would
   * recolour every other object sharing that entry, and be undone by the next
   * theme toggle. Asking the cache for the route's own colour costs one
   * material per distinct route colour and stays theme-managed.
   *
   * The colour is the ROUTE's. Colour in this world is semantic and an overlay
   * does not get to invent one; what the highlight adds is thickness and glow,
   * which mean nothing on their own. */
  const trace = new THREE.Mesh(new THREE.BufferGeometry(), theme.neon(theme.color.ink, 1.5))
  trace.name = 'roads:trace'
  trace.raycast = () => {}
  trace.frustumCulled = false
  trace.userData.chNoShadow = true
  // Above the roads and the ground, so a traced duct is not half-buried in the
  // island it runs over.
  trace.renderOrder = 3
  trace.visible = false
  group.add(trace)

  function highlight(routeId: string | null): void {
    if (routeId === null) {
      trace.visible = false
      return
    }
    const curve = routeCurve(routeId)
    const def: RouteDef | undefined = ROUTES[routeId]
    if (!curve || !def) {
      trace.visible = false
      return
    }
    // Allocating a geometry per highlight is fine — this runs on a click, not
    // in the frame loop — but the old one is this module's to release.
    trace.geometry.dispose()
    trace.geometry = new THREE.TubeGeometry(curve, TRACE_SEGMENTS, TRACE_RADIUS, TRACE_RADIAL, false)
    trace.material = theme.neon(def.color, 1.5)
    trace.visible = true
  }

  // Only the trace geometry: every material in this module came from the
  // theme's caches, and the theme disposes those.
  function dispose(): void {
    trace.geometry.dispose()
  }

  return { group, highlight, dispose }
}
