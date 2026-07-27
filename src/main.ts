import * as THREE from 'three'

import './styles/tokens.css'
import './styles/ui.css'

import { createBus } from './core/bus'
import { Registry } from './core/registry'
import { createTheme, setThemeMode, themeMode } from './core/theme'
import {
  MAX_VISUAL_DELTA_SECONDS,
  createFrameTimebase,
  simulationAnimationDelta,
  wallDelta,
} from './core/timebase'
import { clamp, headingFromMatrix } from './core/util'
import type { ComponentDef, FlowRequest, WorldContext, WorldModule } from './core/types'

import { createRenderer } from './engine/renderer'
import { createCameraRig } from './engine/camera'
import { createFlows } from './engine/flows'
import { createRoads } from './engine/roads'
import { createLabels } from './engine/labels'
import { createPicker } from './engine/picker'

import { createSim } from './sim/model'

import { createSky } from './world/sky'
import { createGround } from './world/ground'
import { createClients } from './world/clients'
import { createDistributed } from './world/distributed'
import { createNodes } from './world/nodes'
import { createKeeper } from './world/keeper'

import { createHud } from './ui/hud'
import { createMinimap } from './ui/minimap'
import { createHelp } from './ui/help'
import { createControls } from './ui/controls'
import { createInspector } from './ui/panel'
import { createTour } from './ui/tour'
import { createSearch } from './ui/search'
import { BOOT_STEPS, failBoot, finishBoot, presentBootStep } from './ui/boot'
import type { UiContext, UiModule } from './ui/uikit'

/* ============================================================================
 * CHSimCity — boot.
 *
 * Order matters: renderer → camera → simulation → world → overlays → UI. The
 * world modules only ever read simulation state; the UI only ever talks to the
 * world through the bus. Nothing reaches across those lines.
 * ==========================================================================*/

const bootEl = document.getElementById('boot')
const bootFill = document.getElementById('boot-fill')
const bootStatus = document.getElementById('boot-status')
const bootSurface = { root: bootEl, fill: bootFill, status: bootStatus }

function progress(step: { pct: number; label: string }): Promise<void> {
  return presentBootStep(bootSurface, step)
}

function fatal(message: string, detail?: unknown): void {
  console.error('[CHSimCity]', message, detail)
  failBoot(bootSurface, message)
}

async function boot(): Promise<void> {
  const canvasRoot = document.getElementById('canvas-root')
  const labelsRoot = document.getElementById('labels-root')
  if (!canvasRoot || !labelsRoot) throw new Error('DOM shell is missing')

  /* --- WebGL2 gate --------------------------------------------------------- */
  const probe = document.createElement('canvas')
  const probeCtx = probe.getContext('webgl2')
  if (!probeCtx) {
    fatal('This browser has no WebGL2. Try a recent Chrome, Edge, Firefox or Safari.')
    return
  }
  // Hand the probe context straight back — browsers cap how many WebGL contexts
  // can be live at once, and the real one has not been created yet.
  probeCtx.getExtension('WEBGL_lose_context')?.loseContext()

  const bus = createBus()
  const registry = new Registry()
  const theme = createTheme()

  await progress(BOOT_STEPS.renderer)
  const gfx = createRenderer(canvasRoot, bus)
  const { scene, camera, renderer } = gfx

  await progress(BOOT_STEPS.camera)
  const rig = createCameraRig(camera, renderer.domElement, bus)

  await progress(BOOT_STEPS.simulation)
  const sim = createSim(bus)

  /* --- the context every district is built against ------------------------ */
  const ctx: WorldContext = {
    scene,
    camera,
    bus,
    sim: sim.state,
    quality: gfx.quality,
    theme,
    register: (def: ComponentDef) => registry.register(def),
    flow: (req: FlowRequest) => bus.emit('flow', req),
  }

  await progress(BOOT_STEPS.ground)
  scene.add(createSky(theme))
  const modules: WorldModule[] = []
  const add = (m: WorldModule) => {
    modules.push(m)
    scene.add(m.group)
    return m
  }
  add(createGround(ctx))

  await progress(BOOT_STEPS.nodes)
  add(createNodes(ctx))

  await progress(BOOT_STEPS.distributed)
  add(createClients(ctx))
  add(createDistributed(ctx))

  await progress(BOOT_STEPS.keeper)
  add(createKeeper(ctx))

  await progress(BOOT_STEPS.roads)
  scene.add(createRoads(theme))
  const flows = createFlows(scene, bus, gfx.quality, theme)
  const labels = createLabels(labelsRoot, registry, bus)
  scene.add(labels.group)
  const picker = createPicker({ dom: renderer.domElement, camera, registry, bus, theme })
  scene.add(picker.group)

  await progress(BOOT_STEPS.console)
  const uiCtx: UiContext = {
    bus,
    sim,
    registry,
    getFps: () => gfx.fps,
    getQuality: () => gfx.quality,
    getFlowStats: () => ({ active: flows.active, dropped: flows.dropped }),
    // Read live, never cached: the minimap's cone and the fly overlay's speed
    // both have to agree with where the camera actually is this frame.
    getCamera: () => ({
      mode: rig.mode,
      speed: rig.speed,
      x: camera.position.x,
      y: camera.position.y,
      z: camera.position.z,
      // Clockwise from north. See headingFromMatrix: the sign convention here
      // is the one that made the minimap's cone point backwards.
      yaw: headingFromMatrix(camera.matrix.elements),
      fov: (camera.fov * Math.PI) / 180,
      aspect: camera.aspect,
      locked: document.pointerLockElement === renderer.domElement,
    }),
  }
  const ui: UiModule[] = [
    createHud(uiCtx),
    createMinimap(uiCtx),
    createHelp(uiCtx),
    createControls(uiCtx),
    createInspector(uiCtx),
    createTour(uiCtx),
    createSearch(uiCtx),
  ]

  /* --- bus wiring --------------------------------------------------------- */

  bus.on('focus', ({ id, instant }) => {
    if (!id) {
      rig.home(instant)
      return
    }
    const def = registry.get(id)
    if (!def) {
      console.warn(`[CHSimCity] focus on unknown component "${id}"`)
      return
    }
    rig.focusOn(def.focus, { instant })
  })

  // The HUD's F key asks for a mode change; the rig announces the mode it ended
  // up in. Guard so the two cannot ping-pong.
  let applyingMode = false
  bus.on('camera:mode', ({ mode }) => {
    if (applyingMode || rig.mode === mode) return
    applyingMode = true
    try {
      // F toggles: asking for fly while already flying means "stop flying".
      rig.setMode(mode === 'fly' && rig.mode === 'fly' ? 'orbit' : mode)
    } finally {
      applyingMode = false
    }
  })

  // The HUD's quality select asks for a level; the renderer echoes the level it
  // ended up at. Same ping-pong guard.
  let applyingQuality = false
  bus.on('quality', ({ level }) => {
    if (!applyingQuality && level !== gfx.quality.level) {
      applyingQuality = true
      try {
        gfx.setQuality(level)
      } finally {
        applyingQuality = false
      }
    }
    flows.setQuality(gfx.quality)
    labels.setQuality(gfx.quality)
  })

  bus.on('sim:reset', () => {
    /* the model resets itself; this exists so other modules can react */
  })

  /* --- resize ------------------------------------------------------------- */

  const onResize = () => {
    gfx.resize()
    rig.resize(canvasRoot.clientWidth, canvasRoot.clientHeight)
    labels.resize(canvasRoot.clientWidth, canvasRoot.clientHeight)
  }
  window.addEventListener('resize', onResize)
  onResize()

  /* --- LOD ---------------------------------------------------------------- */

  let detail: 0 | 1 | 2 = 0
  const detailFor = (alt: number): 0 | 1 | 2 => (alt > 700 ? 0 : alt > 260 ? 1 : 2)

  /* --- the loop ----------------------------------------------------------- */

  const timer = new THREE.Timer()
  timer.connect(document)
  const frameTimebase = createFrameTimebase(sim.update)
  let running = true

  function frame(): void {
    if (!running) return
    requestAnimationFrame(frame)

    timer.update()
    // rawDt feeds FPS and adaptive quality. The world stays on the animation
    // clamp; the model consumes bounded wall time as fixed steps.
    const rawDt = timer.getDelta()
    const dt = clamp(rawDt, 0, MAX_VISUAL_DELTA_SECONDS)
    const elapsed = wallDelta(rawDt)
    const s = sim.state

    // 1. advance the model
    frameTimebase.advance(elapsed, s.knobs.paused, s.knobs.timeScale)
    const cityDt = simulationAnimationDelta(dt, s.knobs.paused, s.knobs.timeScale)

    // 2. camera, then everything that depends on where the camera is
    rig.update(dt)
    const nextDetail = detailFor(rig.altitude)
    if (nextDetail !== detail) {
      detail = nextDetail
      for (const m of modules) m.setDetail?.(detail)
    }

    // 3. the cluster
    for (let i = 0; i < modules.length; i++) modules[i].update(cityDt, s, s.t)
    flows.update(cityDt)
    picker.update(dt)

    // 4. draw
    gfx.render(dt, rawDt)
    labels.update(dt, camera, s)
    labels.render(scene, camera)

    // 5. chrome. The UI gets the accepted WALL delta as its second argument:
    // a tour chapter's length is how long a person needs to read it, and must
    // not stretch when the simulation is slowed down.
    for (let i = 0; i < ui.length; i++) ui[i].update(dt, elapsed)
  }

  await progress(BOOT_STEPS.firstFrame)
  rig.home(true)
  frame()

  finishBoot(bootSurface)

  /* --- teardown (hot reload / navigation) --------------------------------- */

  let disposed = false
  const dispose = () => {
    if (disposed) return
    disposed = true
    running = false
    window.removeEventListener('resize', onResize)
    timer.disconnect()
    for (const m of modules) m.dispose?.()
    for (const u of ui) u.dispose()
    flows.dispose()
    labels.dispose()
    picker.dispose()
    rig.dispose()
    gfx.dispose()
    theme.dispose()
  }
  // pagehide also fires when the page goes into the back/forward cache, where it
  // is expected to come back alive. Only tear down when it is a real unload.
  window.addEventListener('pagehide', (e: PageTransitionEvent) => {
    if (e.persisted) {
      running = false // pause; pageshow restarts the loop
      return
    }
    dispose()
  })
  window.addEventListener('pageshow', () => {
    if (running || disposed) return
    running = true
    timer.update() // swallow the delta accumulated while frozen
    frame()
  })
  if (import.meta.hot) import.meta.hot.dispose(dispose)

  // Handy in the console.
  const handle = { sim, registry, bus, rig, gfx, flows, setThemeMode, themeMode }
  Object.assign(window as unknown as Record<string, unknown>, { CHSIMCITY: handle })
}

boot().catch((err) => fatal('CHSimCity failed to start — see the console.', err))
