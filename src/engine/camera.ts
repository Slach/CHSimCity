import * as THREE from 'three'
import type { Bus, CameraApi, CameraMode, FocusSpec } from '../core/types'
import { clamp, clamp01, easeInOutCubic, damp, reduceMotion } from '../core/util'
import { ANCHOR } from '../world/layout'

/* ============================================================================
 * THE CAMERA RIG
 *
 * One kinematic state, four modes.
 *
 *   orbit  — the default. A pivot in the world, a spherical offset around it.
 *            Drag is 1:1; release glides; the wheel dollies toward the cursor
 *            ray rather than toward the pivot, which is the difference between
 *            a CAD toy and a walkthrough.
 *   fly    — pointer-locked yaw/pitch with accelerated view-space translation.
 *   focus  — a scripted tween to frame a component.
 *   tour   — a scripted CatmullRom path with a parallel look-at path.
 *
 * The orbit state is kept continuously valid *during* scripted moves (the pivot
 * is re-derived from the live camera transform every frame), so release() is a
 * pure mode flip with zero snap. That is the whole trick: the user can grab the
 * camera at any instant of any animation and nothing jumps.
 *
 * Everything mutable is hoisted; update() allocates nothing.
 * ==========================================================================*/

export interface CameraRig extends CameraApi {
  home(instant?: boolean): void
  setPivot(p: THREE.Vector3 | [number, number, number]): void
  readonly pivot: THREE.Vector3
  readonly speed: number
}

/* --------------------------------------------------------------------------
 * Tuning. Every number here is a feel decision.
 * ------------------------------------------------------------------------*/

const MIN_DIST = 8
/** Far enough out to hold the whole cluster, which is ~1.4 km corner to corner. */
const MAX_DIST = 2100
/** Never flip over the poles; 3.05 rad lets you get under an island and look up
 *  into its storage excavation. */
const PHI_MIN = 0.03
const PHI_MAX = 3.05

/** Orbit inertia decay (1/s). ~0.25 s to settle. */
const SPIN_DECAY = 13
const PAN_DECAY = 13
const DOLLY_RATE = 12
const PIVOT_RATE = 18
/** Velocity estimator responsiveness while dragging. */
const VEL_TRACK = 26

/** Keyboard translation acceleration (1/s). */
const KEY_ACCEL = 9
/** Fly look sensitivity, radians per pixel. */
const LOOK_SENS = 0.0022
const PITCH_LIMIT = 1.5359 // 88°
const MIN_FLY_SPEED = 4
const MAX_FLY_SPEED = 520
const DEFAULT_FLY_SPEED = 60

const BOOST = 3
const PRECISION = 0.25

/** Wheel: exp(px * k). One notch (~100px) ≈ 22%. */
const ZOOM_K = 0.002
const SPEED_K = 0.0018

const FOCUS_DUR = 1.05
/** Upward framing bias for auto-derived focus directions. */
const FOCUS_UP_BIAS = 0.436 // 25°
/** Fraction of a tour path spent easing in and out. */
const PATH_EASE = 0.18

/**
 * The establishing shot: BEHIND THE APPLICATION TIER, looking south.
 *
 * You arrive where a client arrives. The clients are at z ≈ -430, north of
 * everything, so the camera sits north of them and looks south down the
 * cluster's own axis — and the frame then reads in the order things actually
 * happen: the application tier in the foreground, the four servers across the
 * middle each with its own `Distributed` table facing you, and the Keeper
 * quorum furthest away.
 *
 * This used to be the other way round, from the Keeper end. That framing put
 * the clients at the far edge and made the cluster look like something data
 * flows *out* of, with a single front door between them and the shards. There
 * is no such door: every server has the `Distributed` table, and which one
 * serves a statement is the application's choice — which is a fact about this
 * end of the world, so this is the end to stand at.
 *
 * The distance is derived, not guessed. The built cluster runs z = -470 .. +400,
 * 870 units deep, and at this camera's 52° vertical field of view the vertical
 * extent covered at distance d is 2·d·tan(26°) ≈ 0.98·d — so ~1050 units of
 * distance is what holds 870 with a margin. Pull the camera in and the Keeper
 * quorum leaves the frame; push it out and the islands stop being readable.
 */
const HOME_POS = new THREE.Vector3(-180, 520, -900)
const HOME_PIVOT = new THREE.Vector3(0, 0, -20)

const CLUSTER_CENTER = new THREE.Vector3(
  ANCHOR.clusterCenter[0],
  ANCHOR.clusterCenter[1],
  ANCHOR.clusterCenter[2],
)
const WORLD_UP = new THREE.Vector3(0, 1, 0)

/** Below this speed² a velocity is dust: snap it to zero so nothing creeps. */
const DEAD_VEL = 1e-4

/**
 * One box for the eye and the pivot alike, a little larger than the ground
 * plane. It is only enforced against *user-driven* motion: a scripted move or a
 * re-adopted pivot is never yanked back, which would show up as a snap.
 */
const LIMIT_XZ = 1600
const LIMIT_Y_LO = -320
const LIMIT_Y_HI = 1100

/* --------------------------------------------------------------------------
 * Module-scope scratch. Nothing below allocates per frame.
 * ------------------------------------------------------------------------*/

const _v1 = new THREE.Vector3()
const _v2 = new THREE.Vector3()
const _v3 = new THREE.Vector3()
const _fwd = new THREE.Vector3()
const _right = new THREE.Vector3()
const _upv = new THREE.Vector3()
const _sph = new THREE.Spherical()
const _q1 = new THREE.Quaternion()
const _m4 = new THREE.Matrix4()
const _euler = new THREE.Euler(0, 0, 0, 'YXZ')

const MOVE_CODES = new Set([
  'KeyW',
  'KeyA',
  'KeyS',
  'KeyD',
  'KeyQ',
  'KeyE',
  'KeyC',
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
  'Space',
  'PageUp',
  'PageDown',
])

const FLY_ONLY_CODES = new Set(['Space', 'KeyE', 'KeyC', 'KeyQ'])

function isTypingTarget(t: EventTarget | null): boolean {
  const el = t as HTMLElement | null
  if (!el || typeof el.tagName !== 'string') return false
  const tag = el.tagName
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable === true
}

/** Wheel deltas normalised to CSS pixels. */
function wheelPixels(e: WheelEvent): number {
  if (e.deltaMode === 1) return e.deltaY * 16
  if (e.deltaMode === 2) return e.deltaY * 100
  return e.deltaY
}

/**
 * Arc-length reparameterisation with smoothstep ramps at the ends only:
 * constant speed through the middle of a tour shot, no dead-stop feel.
 * ∫ smoothstep = x³ − x⁴/2, which is 0.5 at x = 1.
 */
function easeEnds(t: number): number {
  const a = PATH_EASE
  const total = 1 - a
  const u = clamp01(t)
  if (u < a) {
    const x = u / a
    return (a * (x * x * x - (x * x * x * x) / 2)) / total
  }
  if (u < 1 - a) return (a / 2 + (u - a)) / total
  const x = (1 - u) / a
  return (total - a * (x * x * x - (x * x * x * x) / 2)) / total
}

/* ==========================================================================*/

export function createCameraRig(
  camera: THREE.PerspectiveCamera,
  domElement: HTMLElement,
  bus: Bus,
): CameraRig {
  /* ---- state -------------------------------------------------------------*/

  let mode: CameraMode = 'orbit'
  /** The mode we hand control back to when a scripted move ends. */
  let userMode: 'orbit' | 'fly' = 'orbit'

  // orbit: `pivot`/`dist` chase their targets; theta/phi are driven directly so
  // dragging is exactly 1:1.
  const pivot = HOME_PIVOT.clone()
  const pivotT = HOME_PIVOT.clone()
  let theta = 0
  let phi = 1
  let dist = 600
  let distT = 600

  let velTheta = 0
  let velPhi = 0
  const velPivot = new THREE.Vector3()
  const kbVel = new THREE.Vector3()

  // fly
  let yaw = 0
  let pitch = 0
  let flySpeed = DEFAULT_FLY_SPEED
  const flyVel = new THREE.Vector3()

  // viewport
  let viewW = Math.max(1, domElement.clientWidth || window.innerWidth)
  let viewH = Math.max(1, domElement.clientHeight || window.innerHeight)

  // pending input, consumed in update()
  let inRotX = 0
  let inRotY = 0
  let inPanX = 0
  let inPanY = 0
  let inLookX = 0
  let inLookY = 0
  let pendingZoom = 1
  let zoomNdcX = 0
  let zoomNdcY = 0

  let dragOrbit = false
  let dragPan = false
  let dragLook = false
  let locked = false
  let disposed = false

  // scripted moves
  let tweenT = 0
  let tweenDur = FOCUS_DUR
  const tweenP0 = new THREE.Vector3()
  const tweenP1 = new THREE.Vector3()
  const tweenQ0 = new THREE.Quaternion()
  const tweenQ1 = new THREE.Quaternion()
  const tweenTarget = new THREE.Vector3()
  let tweenD0 = 0
  let tweenD1 = 0

  let pathPos: THREE.CatmullRomCurve3 | null = null
  let pathLook: THREE.CatmullRomCurve3 | null = null
  let pathT = 0
  let pathDur = 1
  let pathResolve: (() => void) | null = null

  // touch
  const ptrIds: number[] = []
  const ptrX = new Map<number, number>()
  const ptrY = new Map<number, number>()
  let pinchActive = false
  let pinchDist = 0
  let pinchMx = 0
  let pinchMy = 0
  let pinchAngle = 0

  const keys = new Set<string>()
  let shiftDown = false
  let altDown = false

  camera.up.copy(WORLD_UP)
  camera.rotation.order = 'YXZ'

  /* ---- helpers -----------------------------------------------------------*/

  function setMode_(m: CameraMode): void {
    if (m === mode) return
    mode = m
    if (m === 'orbit' || m === 'fly') userMode = m
    bus.emit('camera:mode', { mode: m })
  }

  const scriptedNow = () => mode === 'focus' || mode === 'tour'

  /**
   * Rebuild the orbit state from wherever the camera currently is, putting the
   * pivot `d` units ahead of the eye. The eye position is preserved exactly:
   * when the polar clamp bites (you came out of fly mode staring at the sky) it
   * moves the *pivot*, never the camera, so nothing jumps under the user.
   */
  function adoptOrbit(d: number): void {
    const dd = clamp(d, MIN_DIST, MAX_DIST)
    _fwd.set(0, 0, -1).applyQuaternion(camera.quaternion)
    _v1.copy(_fwd).multiplyScalar(-dd) // pivot → eye
    _sph.setFromVector3(_v1)
    theta = _sph.theta
    phi = clamp(_sph.phi, PHI_MIN, PHI_MAX)
    dist = dd
    distT = dd
    _sph.radius = dd
    _sph.phi = phi
    _sph.theta = theta
    _v2.setFromSpherical(_sph)
    pivot.copy(camera.position).sub(_v2)
    pivotT.copy(pivot)
  }

  /** Applied only where the user actively drives the pivot. */
  function clampPivotTarget(): void {
    pivotT.x = clamp(pivotT.x, -LIMIT_XZ, LIMIT_XZ)
    pivotT.y = clamp(pivotT.y, LIMIT_Y_LO, LIMIT_Y_HI)
    pivotT.z = clamp(pivotT.z, -LIMIT_XZ, LIMIT_XZ)
  }

  function syncOrbitFromCamera(d: number): void {
    adoptOrbit(d)
    velTheta = 0
    velPhi = 0
    velPivot.set(0, 0, 0)
    kbVel.set(0, 0, 0)
  }

  function syncFlyFromCamera(): void {
    _euler.setFromQuaternion(camera.quaternion, 'YXZ')
    yaw = _euler.y
    pitch = clamp(_euler.x, -PITCH_LIMIT, PITCH_LIMIT)
    flyVel.set(0, 0, 0)
  }

  /** Drop the scripted move and settle its promise. Does not touch the transform. */
  function cancelScript(): void {
    const resolve = pathResolve
    pathResolve = null
    pathPos = null
    pathLook = null
    tweenT = tweenDur
    if (resolve) resolve()
  }

  function requestLock(): void {
    if (locked || disposed) return
    const el = domElement as HTMLElement & { requestPointerLock?: () => unknown }
    if (typeof el.requestPointerLock !== 'function') return
    try {
      const p = el.requestPointerLock()
      if (p && typeof (p as Promise<void>).catch === 'function') (p as Promise<void>).catch(() => {})
    } catch {
      // The browser refused (no gesture, or an iframe). Drag-look still works.
    }
  }

  /* ---- input -------------------------------------------------------------*/

  function interrupt(): void {
    // Any user input during a scripted move hands control straight back.
    if (scriptedNow()) release()
  }

  function ndcFromEvent(e: { clientX: number; clientY: number }): void {
    const r = domElement.getBoundingClientRect()
    zoomNdcX = ((e.clientX - r.left) / Math.max(1, r.width)) * 2 - 1
    zoomNdcY = -(((e.clientY - r.top) / Math.max(1, r.height)) * 2 - 1)
  }

  function onPointerDown(e: PointerEvent): void {
    // Right-click belongs to the browser's own menu in every camera mode.
    if (e.pointerType !== 'touch' && e.button === 2) return

    interrupt()
    ptrIds.push(e.pointerId)
    ptrX.set(e.pointerId, e.clientX)
    ptrY.set(e.pointerId, e.clientY)
    if (typeof domElement.setPointerCapture === 'function') {
      try {
        domElement.setPointerCapture(e.pointerId)
      } catch {
        // Capture is a convenience; without it a fast drag off-canvas just ends.
      }
    }

    if (e.pointerType === 'touch') {
      if (ptrIds.length === 2) beginPinch()
      return
    }

    if (mode === 'fly') {
      dragLook = true
      requestLock()
      return
    }
    // Left-drag pans the ground the way a map does; shift or middle orbits.
    if (e.button === 1 || e.shiftKey || (e.ctrlKey && e.button === 0)) dragOrbit = true
    else if (e.button === 0) dragPan = true
  }

  function onPointerMove(e: PointerEvent): void {
    const px = ptrX.get(e.pointerId)
    const py = ptrY.get(e.pointerId)
    ptrX.set(e.pointerId, e.clientX)
    ptrY.set(e.pointerId, e.clientY)

    if (locked) {
      inLookX += e.movementX
      inLookY += e.movementY
      return
    }

    if (px === undefined || py === undefined) return
    const dx = e.clientX - px
    const dy = e.clientY - py

    if (e.pointerType === 'touch' && ptrIds.length >= 2) {
      updatePinch()
      return
    }

    if (dragLook) {
      inLookX += dx
      inLookY += dy
      return
    }
    if (dragOrbit) {
      inRotX += dx
      inRotY += dy
      return
    }
    if (dragPan || (e.pointerType === 'touch' && ptrIds.length === 1)) {
      inPanX += dx
      inPanY += dy
    }
  }

  function onPointerUp(e: PointerEvent): void {
    const i = ptrIds.indexOf(e.pointerId)
    if (i >= 0) ptrIds.splice(i, 1)
    ptrX.delete(e.pointerId)
    ptrY.delete(e.pointerId)
    if (ptrIds.length < 2) pinchActive = false
    if (ptrIds.length === 0) {
      dragOrbit = false
      dragPan = false
      dragLook = false
    }
    if (typeof domElement.releasePointerCapture === 'function') {
      try {
        domElement.releasePointerCapture(e.pointerId)
      } catch {
        // Already released; nothing to do.
      }
    }
  }

  function beginPinch(): void {
    pinchActive = true
    const [a, b] = ptrIds
    const ax = ptrX.get(a) ?? 0
    const ay = ptrY.get(a) ?? 0
    const bx = ptrX.get(b) ?? 0
    const by = ptrY.get(b) ?? 0
    pinchDist = Math.hypot(bx - ax, by - ay)
    pinchMx = (ax + bx) / 2
    pinchMy = (ay + by) / 2
    pinchAngle = Math.atan2(by - ay, bx - ax)
  }

  function updatePinch(): void {
    if (!pinchActive || ptrIds.length < 2) return
    const [a, b] = ptrIds
    const ax = ptrX.get(a) ?? 0
    const ay = ptrY.get(a) ?? 0
    const bx = ptrX.get(b) ?? 0
    const by = ptrY.get(b) ?? 0
    const d = Math.hypot(bx - ax, by - ay)
    const mx = (ax + bx) / 2
    const my = (ay + by) / 2
    const ang = Math.atan2(by - ay, bx - ax)

    if (pinchDist > 1 && d > 1) {
      distT = clamp(distT * (pinchDist / d), MIN_DIST, MAX_DIST)
      zoomNdcX = 0
      zoomNdcY = 0
    }
    // Twist yaws, vertical drag of the midpoint tilts, horizontal pans.
    inRotX += (ang - pinchAngle) * -320
    inRotY += my - pinchMy
    inPanX += mx - pinchMx

    pinchDist = d
    pinchMx = mx
    pinchMy = my
    pinchAngle = ang
  }

  function onWheel(e: WheelEvent): void {
    interrupt()
    e.preventDefault()
    const px = wheelPixels(e)
    if (mode === 'fly') {
      // In fly mode the wheel changes how fast you move, not where you are.
      flySpeed = clamp(flySpeed * Math.exp(-px * SPEED_K), MIN_FLY_SPEED, MAX_FLY_SPEED)
      return
    }
    ndcFromEvent(e)
    pendingZoom *= Math.exp(px * ZOOM_K)
  }

  function onKeyDown(e: KeyboardEvent): void {
    if (isTypingTarget(e.target)) return
    if (e.code === 'ShiftLeft' || e.code === 'ShiftRight') shiftDown = true
    if (e.code === 'AltLeft' || e.code === 'AltRight') altDown = true
    if (!MOVE_CODES.has(e.code)) return
    if (mode === 'orbit' && FLY_ONLY_CODES.has(e.code) && e.code !== 'KeyE' && e.code !== 'KeyQ') {
      // Space in orbit mode is not ours; leave it for the HUD.
      if (e.code === 'Space') return
    }
    interrupt()
    keys.add(e.code)
    if (e.code === 'Space' || e.code === 'PageUp' || e.code === 'PageDown') e.preventDefault()
  }

  function onKeyUp(e: KeyboardEvent): void {
    if (e.code === 'ShiftLeft' || e.code === 'ShiftRight') shiftDown = false
    if (e.code === 'AltLeft' || e.code === 'AltRight') altDown = false
    keys.delete(e.code)
  }

  function onBlur(): void {
    keys.clear()
    shiftDown = false
    altDown = false
    dragOrbit = false
    dragPan = false
    dragLook = false
    ptrIds.length = 0
    ptrX.clear()
    ptrY.clear()
  }

  function onLockChange(): void {
    locked = document.pointerLockElement === domElement
    if (!locked) dragLook = false
  }

  domElement.addEventListener('pointerdown', onPointerDown)
  domElement.addEventListener('pointermove', onPointerMove)
  domElement.addEventListener('pointerup', onPointerUp)
  domElement.addEventListener('pointercancel', onPointerUp)
  domElement.addEventListener('wheel', onWheel, { passive: false })
  window.addEventListener('keydown', onKeyDown)
  window.addEventListener('keyup', onKeyUp)
  window.addEventListener('blur', onBlur)
  document.addEventListener('pointerlockchange', onLockChange)

  /* ---- orbit integration -------------------------------------------------*/

  /**
   * World units one screen pixel is worth at the pivot's depth. This is what
   * makes a left-drag move the ground exactly as far as the cursor moved,
   * regardless of zoom — the property that makes the camera feel like a map.
   */
  function pixelScale(): number {
    const fovRad = (camera.fov * Math.PI) / 180
    return (2 * Math.tan(fovRad / 2) * dist) / Math.max(1, viewH)
  }

  function integrateOrbit(dt: number): void {
    const dragging = dragOrbit || dragPan || pinchActive

    /* --- rotation: 1:1 while dragging, inertial after ------------------- */
    if (inRotX !== 0 || inRotY !== 0) {
      const dTheta = -inRotX * 0.005
      const dPhi = -inRotY * 0.005
      theta += dTheta
      phi = clamp(phi + dPhi, PHI_MIN, PHI_MAX)
      velTheta = damp(velTheta, dTheta / Math.max(dt, 1e-4), VEL_TRACK, dt)
      velPhi = damp(velPhi, dPhi / Math.max(dt, 1e-4), VEL_TRACK, dt)
      inRotX = 0
      inRotY = 0
    } else if (!dragging && !reduceMotion()) {
      theta += velTheta * dt
      phi = clamp(phi + velPhi * dt, PHI_MIN, PHI_MAX)
      velTheta = damp(velTheta, 0, SPIN_DECAY, dt)
      velPhi = damp(velPhi, 0, SPIN_DECAY, dt)
      if (velTheta * velTheta < DEAD_VEL) velTheta = 0
      if (velPhi * velPhi < DEAD_VEL) velPhi = 0
    } else {
      velTheta = 0
      velPhi = 0
    }

    /* --- pan: grab the ground ------------------------------------------- */
    if (inPanX !== 0 || inPanY !== 0) {
      const s = pixelScale()
      // Screen-right and screen-up projected onto the ground plane, so a drag
      // moves the world under the cursor rather than sliding the camera.
      _right.set(1, 0, 0).applyQuaternion(camera.quaternion).setY(0)
      if (_right.lengthSq() < 1e-6) _right.set(1, 0, 0)
      _right.normalize()
      _upv.set(0, 0, -1).applyQuaternion(camera.quaternion).setY(0)
      if (_upv.lengthSq() < 1e-6) _upv.set(0, 0, -1)
      _upv.normalize()

      _v1.copy(_right).multiplyScalar(-inPanX * s)
      _v1.addScaledVector(_upv, -inPanY * s)
      pivotT.add(_v1)
      clampPivotTarget()
      velPivot.copy(_v1).multiplyScalar(1 / Math.max(dt, 1e-4))
      inPanX = 0
      inPanY = 0
    } else if (!dragging && !reduceMotion()) {
      pivotT.addScaledVector(velPivot, dt)
      clampPivotTarget()
      velPivot.multiplyScalar(Math.exp(-PAN_DECAY * dt))
      if (velPivot.lengthSq() < DEAD_VEL) velPivot.set(0, 0, 0)
    } else {
      velPivot.set(0, 0, 0)
    }

    /* --- keyboard translation ------------------------------------------- */
    const boost = shiftDown ? BOOST : altDown ? PRECISION : 1
    _v1.set(0, 0, 0)
    if (keys.has('KeyW') || keys.has('ArrowUp')) _v1.z -= 1
    if (keys.has('KeyS') || keys.has('ArrowDown')) _v1.z += 1
    if (keys.has('KeyA') || keys.has('ArrowLeft')) _v1.x -= 1
    if (keys.has('KeyD') || keys.has('ArrowRight')) _v1.x += 1
    if (keys.has('PageUp')) _v1.y += 1
    if (keys.has('PageDown')) _v1.y -= 1
    if (_v1.lengthSq() > 0) {
      _v1.normalize()
      _right.set(1, 0, 0).applyQuaternion(camera.quaternion).setY(0).normalize()
      _upv.set(0, 0, -1).applyQuaternion(camera.quaternion).setY(0).normalize()
      _v2.copy(_right).multiplyScalar(_v1.x)
      _v2.addScaledVector(_upv, -_v1.z)
      _v2.y += _v1.y
      // Speed scales with how far out you are, so one keypress covers the same
      // fraction of the frame at every zoom level.
      const speed = clamp(dist * 0.9, 40, 900) * boost
      kbVel.lerp(_v2.multiplyScalar(speed), 1 - Math.exp(-KEY_ACCEL * dt))
    } else {
      kbVel.multiplyScalar(Math.exp(-KEY_ACCEL * dt))
    }
    if (kbVel.lengthSq() > DEAD_VEL) {
      pivotT.addScaledVector(kbVel, dt)
      clampPivotTarget()
    }

    /* --- dolly ---------------------------------------------------------- */
    if (pendingZoom !== 1) {
      const before = distT
      distT = clamp(distT * pendingZoom, MIN_DIST, MAX_DIST)
      // Dolly toward the cursor ray, not toward the pivot: the point under the
      // cursor stays put, which is what makes zooming feel like a map.
      if (zoomNdcX !== 0 || zoomNdcY !== 0) {
        const shrink = 1 - distT / Math.max(1e-6, before)
        if (Math.abs(shrink) > 1e-6) {
          const s = pixelScale()
          _right.set(1, 0, 0).applyQuaternion(camera.quaternion)
          _upv.set(0, 1, 0).applyQuaternion(camera.quaternion)
          _v1.copy(_right).multiplyScalar(zoomNdcX * (viewW / 2) * s * shrink)
          _v1.addScaledVector(_upv, zoomNdcY * (viewH / 2) * s * shrink)
          pivotT.add(_v1)
          clampPivotTarget()
        }
      }
      pendingZoom = 1
    }

    dist = damp(dist, distT, DOLLY_RATE, dt)
    pivot.lerp(pivotT, 1 - Math.exp(-PIVOT_RATE * dt))

    /* --- compose -------------------------------------------------------- */
    _sph.set(dist, phi, theta)
    _v1.setFromSpherical(_sph)
    camera.position.copy(pivot).add(_v1)
    camera.position.y = clamp(camera.position.y, LIMIT_Y_LO, LIMIT_Y_HI)
    camera.up.copy(WORLD_UP)
    camera.lookAt(pivot)
  }

  /* ---- fly integration ---------------------------------------------------*/

  function integrateFly(dt: number): void {
    if (inLookX !== 0 || inLookY !== 0) {
      yaw -= inLookX * LOOK_SENS
      pitch = clamp(pitch - inLookY * LOOK_SENS, -PITCH_LIMIT, PITCH_LIMIT)
      inLookX = 0
      inLookY = 0
    }
    _euler.set(pitch, yaw, 0, 'YXZ')
    camera.quaternion.setFromEuler(_euler)

    const boost = shiftDown ? BOOST : altDown ? PRECISION : 1
    _v1.set(0, 0, 0)
    if (keys.has('KeyW') || keys.has('ArrowUp')) _v1.z -= 1
    if (keys.has('KeyS') || keys.has('ArrowDown')) _v1.z += 1
    if (keys.has('KeyA') || keys.has('ArrowLeft')) _v1.x -= 1
    if (keys.has('KeyD') || keys.has('ArrowRight')) _v1.x += 1
    if (keys.has('Space') || keys.has('KeyE') || keys.has('PageUp')) _v1.y += 1
    if (keys.has('KeyC') || keys.has('KeyQ') || keys.has('PageDown')) _v1.y -= 1

    if (_v1.lengthSq() > 0) {
      _v1.normalize()
      // Horizontal movement is view-relative; vertical is world-relative, which
      // is what stops "up" meaning "up and backwards" when you are looking down.
      _fwd.set(0, 0, -1).applyQuaternion(camera.quaternion)
      _right.set(1, 0, 0).applyQuaternion(camera.quaternion)
      _v2.copy(_right).multiplyScalar(_v1.x)
      _v2.addScaledVector(_fwd, -_v1.z)
      _v2.y += _v1.y
      _v2.normalize().multiplyScalar(flySpeed * boost)
      flyVel.lerp(_v2, 1 - Math.exp(-KEY_ACCEL * dt))
    } else {
      flyVel.multiplyScalar(Math.exp(-KEY_ACCEL * dt))
    }

    camera.position.addScaledVector(flyVel, dt)
    camera.position.x = clamp(camera.position.x, -LIMIT_XZ, LIMIT_XZ)
    camera.position.y = clamp(camera.position.y, LIMIT_Y_LO, LIMIT_Y_HI)
    camera.position.z = clamp(camera.position.z, -LIMIT_XZ, LIMIT_XZ)

    // Keep the orbit state valid the whole time, so leaving fly mode is a pure
    // mode flip with no snap.
    adoptOrbit(dist)
  }

  /* ---- scripted moves ----------------------------------------------------*/

  function focusOn(spec: FocusSpec, opts: { instant?: boolean; duration?: number } = {}): void {
    tweenTarget.set(spec.target[0], spec.target[1], spec.target[2])
    const d = clamp(spec.distance, MIN_DIST, MAX_DIST)

    // A focus with no direction is framed from wherever the camera already is,
    // lifted a little: flying to a component should not also spin the world.
    if (spec.dir) {
      _v1.set(spec.dir[0], spec.dir[1], spec.dir[2])
      if (_v1.lengthSq() < 1e-8) _v1.set(0.4, 0.5, 1)
    } else {
      _v1.copy(camera.position).sub(tweenTarget)
      if (_v1.lengthSq() < 1e-8) _v1.set(0.4, 0.5, 1)
      _v1.normalize()
      _v1.y = Math.max(_v1.y, FOCUS_UP_BIAS)
    }
    _v1.normalize().multiplyScalar(d)
    tweenP1.copy(tweenTarget).add(_v1)

    _m4.lookAt(tweenP1, tweenTarget, WORLD_UP)
    tweenQ1.setFromRotationMatrix(_m4)

    if (opts.instant || reduceMotion()) {
      camera.position.copy(tweenP1)
      camera.quaternion.copy(tweenQ1)
      syncOrbitFromCamera(d)
      setMode_(userMode)
      return
    }

    cancelScript()
    tweenP0.copy(camera.position)
    tweenQ0.copy(camera.quaternion)
    tweenD0 = dist
    tweenD1 = d
    tweenT = 0
    tweenDur = Math.max(0.15, opts.duration ?? FOCUS_DUR)
    setMode_('focus')
  }

  function flyPath(
    points: [number, number, number][],
    lookAt: [number, number, number][],
    duration: number,
  ): Promise<void> {
    cancelScript()
    if (points.length < 2) return Promise.resolve()
    pathPos = new THREE.CatmullRomCurve3(
      points.map((p) => new THREE.Vector3(p[0], p[1], p[2])),
      false,
      'catmullrom',
      0.5,
    )
    pathLook =
      lookAt.length >= 2
        ? new THREE.CatmullRomCurve3(
            lookAt.map((p) => new THREE.Vector3(p[0], p[1], p[2])),
            false,
            'catmullrom',
            0.5,
          )
        : null
    pathT = 0
    pathDur = Math.max(0.3, duration)
    setMode_('tour')
    return new Promise<void>((resolve) => {
      pathResolve = resolve
    })
  }

  function release(): void {
    cancelScript()
    if (userMode === 'fly') {
      syncFlyFromCamera()
      setMode_('fly')
      return
    }
    syncOrbitFromCamera(dist)
    setMode_('orbit')
  }

  function integrateScript(dt: number): void {
    if (pathPos) {
      pathT += dt / pathDur
      const u = easeEnds(clamp01(pathT))
      pathPos.getPointAt(u, _v1)
      camera.position.copy(_v1)
      if (pathLook) pathLook.getPointAt(u, _v2)
      else _v2.copy(CLUSTER_CENTER)
      camera.up.copy(WORLD_UP)
      camera.lookAt(_v2)
      // The orbit pivot follows the look-at point, so a grab mid-flight lands
      // exactly where the camera was already pointing.
      dist = clamp(camera.position.distanceTo(_v2), MIN_DIST, MAX_DIST)
      adoptOrbit(dist)
      if (pathT >= 1) {
        const resolve = pathResolve
        pathResolve = null
        pathPos = null
        pathLook = null
        if (resolve) resolve()
        release()
      }
      return
    }

    tweenT += dt
    const u = easeInOutCubic(clamp01(tweenT / tweenDur))
    camera.position.lerpVectors(tweenP0, tweenP1, u)
    camera.quaternion.slerpQuaternions(tweenQ0, tweenQ1, u)
    dist = tweenD0 + (tweenD1 - tweenD0) * u
    adoptOrbit(dist)
    if (tweenT >= tweenDur) release()
  }

  /* ---- frame -------------------------------------------------------------*/

  function update(dt: number): void {
    const d = clamp(dt, 0, 0.1)
    switch (mode) {
      case 'focus':
      case 'tour':
        integrateScript(d)
        break
      case 'fly':
        integrateFly(d)
        break
      default:
        integrateOrbit(d)
    }
    camera.updateMatrixWorld()
  }

  function setMode(m: CameraMode): void {
    if (m === mode) return
    if (m === 'fly') {
      cancelScript()
      syncFlyFromCamera()
      setMode_('fly')
      return
    }
    if (m === 'orbit') {
      cancelScript()
      syncOrbitFromCamera(dist)
      if (locked && document.exitPointerLock) document.exitPointerLock()
      setMode_('orbit')
      return
    }
    setMode_(m)
  }

  function home(instant = false): void {
    focusOn(
      {
        target: [HOME_PIVOT.x, HOME_PIVOT.y, HOME_PIVOT.z],
        distance: HOME_POS.distanceTo(HOME_PIVOT),
        dir: [HOME_POS.x - HOME_PIVOT.x, HOME_POS.y - HOME_PIVOT.y, HOME_POS.z - HOME_PIVOT.z],
      },
      { instant, duration: 1.4 },
    )
  }

  function setPivot(p: THREE.Vector3 | [number, number, number]): void {
    if (Array.isArray(p)) pivotT.set(p[0], p[1], p[2])
    else pivotT.copy(p)
    clampPivotTarget()
  }

  function resize(w: number, h: number): void {
    viewW = Math.max(1, w)
    viewH = Math.max(1, h)
  }

  function dispose(): void {
    disposed = true
    cancelScript()
    domElement.removeEventListener('pointerdown', onPointerDown)
    domElement.removeEventListener('pointermove', onPointerMove)
    domElement.removeEventListener('pointerup', onPointerUp)
    domElement.removeEventListener('pointercancel', onPointerUp)
    domElement.removeEventListener('wheel', onWheel)
    window.removeEventListener('keydown', onKeyDown)
    window.removeEventListener('keyup', onKeyUp)
    window.removeEventListener('blur', onBlur)
    document.removeEventListener('pointerlockchange', onLockChange)
    if (locked && document.exitPointerLock) document.exitPointerLock()
  }

  // Start from the establishing shot without a flight.
  camera.position.copy(HOME_POS)
  camera.lookAt(HOME_PIVOT)
  syncOrbitFromCamera(HOME_POS.distanceTo(HOME_PIVOT))

  return {
    camera,
    get mode() {
      return mode
    },
    setMode,
    focusOn,
    flyPath,
    release,
    update,
    get altitude() {
      return camera.position.distanceTo(CLUSTER_CENTER)
    },
    get scripted() {
      return scriptedNow()
    },
    resize,
    dispose,
    home,
    setPivot,
    get pivot() {
      return pivot
    },
    get speed() {
      return flySpeed
    },
  }
}
