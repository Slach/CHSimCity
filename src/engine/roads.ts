import * as THREE from 'three'
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js'
import type { RouteDef, ThemeApi } from '../core/types'
import { ROUTES, routeCurve } from '../world/layout'

/* ============================================================================
 * ROADS — the static infrastructure the flow particles run on.
 *
 * A route is only drawn if it is marked `visible` in the cluster plan: the roads
 * that teach something (client → initiator and the answer home, the initiator's
 * fan-out, the write path into the yard, the merge gantry, the fetch wires
 * between replicas, the Keeper traffic) are drawn; the per-reader-thread
 * capillaries are not — they would be visual noise.
 *
 * A road is a translucent TUBE, not a line. `LineBasicMaterial` cannot be made
 * thicker than one pixel in WebGL, and a hairline at 0.16 opacity simply is not
 * there from cluster range — which made every duct look like packets crossing
 * empty sky. A tube wide enough that the packets travel INSIDE it turns the
 * same route into a piece of infrastructure: the duct is the pipe, the traffic
 * is the freight in it.
 *
 * Roads are still faint by design. The tube's intensity stays below the bloom
 * threshold (0.85, see engine/renderer.ts): infrastructure never glows, the
 * traffic on it is the only thing that does. `depthWrite` is off and the wall
 * is front-faces only, so a packet inside the tube is seen through exactly one
 * translucent wall and a duct never occludes the one behind it.
 * ==========================================================================*/

/** Samples along each duct. */
const SEGMENTS = 64
/** Radial resolution. The material is unlit, so this is silhouette only. */
const RADIAL = 8
/**
 * Wall radius, world units. Sized so a packet stays inside the tube: a spawn
 * rides a lane offset of up to ±1.0 lateral (see flows.ts) plus a typical pod
 * half-width of ~0.7. Oversized freight — a 1M-row INSERT — bulges out, and
 * that is honest: the batch is bigger than the pipe.
 */
const ROAD_RADIUS = 1.6
/** Below the bloom threshold on purpose — a duct is structure, not meaning. */
const TUBE_INTENSITY = 0.55

/* --- the highlight -------------------------------------------------------
 * A traced duct is a fatter, neon tube over the road's own. It must clear
 * ROAD_RADIUS by a visible margin, or the highlight sits buried inside the
 * wall of the very duct it is tracing. */
const TRACE_SEGMENTS = 128
const TRACE_RADIUS = 2.0
const TRACE_RADIAL = 8

/* Module-scope scratch — pickRoute and the build loop allocate nothing. */
const _p = new THREE.Vector3()
const _hits: THREE.Intersection[] = []

export interface RoadsApi {
  group: THREE.Group
  /**
   * Light one route end to end, or clear it with `null`.
   *
   * ONE reusable mesh, refilled in place, rather than brightening the road
   * already drawn: most routes have no road at all (`visible: false`), and the
   * reader capillaries and the query fan-out — exactly the ducts a viewer most
   * needs traced — are among them. A dedicated overlay can trace any route in
   * ROUTES, drawn or not.
   */
  highlight(routeId: string | null): void
  /**
   * The duct the ray strikes, or null. The tubes are merged per colour for the
   * draw call count, so the mesh hit cannot name a route — the nearest baked
   * centreline to the struck point on the wall does. `distance` is along the
   * ray, so the caller can weigh the wall against whatever else the ray hit.
   * Runs on a click, never per frame.
   */
  pickRoute(raycaster: THREE.Raycaster): { route: string; distance: number } | null
  dispose(): void
}

/**
 * Draw the road network: one translucent tube per visible route, merged into
 * one mesh per colour+opacity pair — a handful of draw calls for the whole
 * cluster's plumbing.
 */
export function createRoads(theme: ThemeApi): RoadsApi {
  const group = new THREE.Group()
  group.name = 'roads'

  /** key = `${color}|${opacity}` → tube geometries awaiting one merge. */
  const pending = new Map<string, THREE.BufferGeometry[]>()
  /** The merged buffers are this module's to release. */
  const owned: THREE.BufferGeometry[] = []
  /** The tube meshes, the only things pickRoute raycasts. */
  const walls: THREE.Mesh[] = []
  /** Baked centrelines of every DRAWN route, xyz-flat — pickRoute's map. */
  const spines: { id: string; pts: Float32Array }[] = []

  for (const id of Object.keys(ROUTES)) {
    const def: RouteDef = ROUTES[id]
    if (!def.visible) continue
    const curve = routeCurve(id)
    if (!curve) continue

    const tube = new THREE.TubeGeometry(curve, SEGMENTS, ROAD_RADIUS, RADIAL, false)
    // MeshBasicMaterial reads neither, and the merged buffer lives all session.
    tube.deleteAttribute('normal')
    tube.deleteAttribute('uv')

    const key = `${def.color}|${def.roadOpacity ?? 0.16}`
    let buf = pending.get(key)
    if (!buf) pending.set(key, (buf = []))
    buf.push(tube)

    const pts = new Float32Array((SEGMENTS + 1) * 3)
    for (let i = 0; i <= SEGMENTS; i++) {
      curve.getPointAt(i / SEGMENTS, _p)
      pts[i * 3] = _p.x
      pts[i * 3 + 1] = _p.y
      pts[i * 3 + 2] = _p.z
    }
    spines.push({ id, pts })
  }

  for (const [key, geos] of pending) {
    const geo = mergeGeometries(geos, false)
    for (const g of geos) g.dispose()
    if (!geo) continue
    owned.push(geo)

    const sep = key.indexOf('|')
    const color = Number(key.slice(0, sep))
    const opacity = Number(key.slice(sep + 1))
    const mesh = new THREE.Mesh(
      geo,
      theme.neon(color, TUBE_INTENSITY, { transparent: true, opacity, depthWrite: false }),
    )
    mesh.name = `road:${key}`
    // First among the transparent pass, so halos and the trace blend over it.
    mesh.renderOrder = -1
    mesh.userData.chNoShadow = true
    // Default raycast stays ON: pickRoute below is the only raycaster that
    // ever sees these — the picker's own pass intersects registry roots only.
    group.add(mesh)
    walls.push(mesh)
  }
  pending.clear()

  /**
   * FrontSide raycast means the wall struck is the one the viewer sees, and a
   * struck point is at most ROAD_RADIUS from its own centreline — measured to
   * the SEGMENT, not to the nearest sample: on a 700-unit route the samples
   * are ~11 apart, and a wall point midway between two of them is five units
   * from either while still on the pipe. A little slack covers the polyline's
   * deviation from the smooth curve; anything further out than that is a
   * junction-adjacent graze and stays unpicked rather than guessed.
   */
  const GRAB2 = 2.2 * 2.2

  function pickRoute(raycaster: THREE.Raycaster): { route: string; distance: number } | null {
    _hits.length = 0
    raycaster.intersectObjects(walls, false, _hits)
    if (_hits.length === 0) return null
    const hit = _hits[0].point
    const distance = _hits[0].distance
    let best: string | null = null
    let bestD2 = GRAB2
    for (const s of spines) {
      const pts = s.pts
      for (let i = 0; i + 5 < pts.length; i += 3) {
        const ax = pts[i]
        const ay = pts[i + 1]
        const az = pts[i + 2]
        const ex = pts[i + 3] - ax
        const ey = pts[i + 4] - ay
        const ez = pts[i + 5] - az
        const len2 = ex * ex + ey * ey + ez * ez
        let t = len2 > 0 ? ((hit.x - ax) * ex + (hit.y - ay) * ey + (hit.z - az) * ez) / len2 : 0
        t = t < 0 ? 0 : t > 1 ? 1 : t
        const dx = ax + ex * t - hit.x
        const dy = ay + ey * t - hit.y
        const dz = az + ez * t - hit.z
        const d2 = dx * dx + dy * dy + dz * dz
        if (d2 < bestD2) {
          bestD2 = d2
          best = s.id
        }
      }
    }
    _hits.length = 0
    return best === null ? null : { route: best, distance }
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

  // Every material in this module came from the theme's caches, and the theme
  // disposes those; the geometries are ours.
  function dispose(): void {
    for (const g of owned) g.dispose()
    owned.length = 0
    trace.geometry.dispose()
  }

  return { group, highlight, pickRoute, dispose }
}
