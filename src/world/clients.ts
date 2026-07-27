import * as THREE from 'three'
import { COLOR } from '../core/theme'
import type { SimState, WorldFactory, WorldModule } from '../core/types'
import { clamp01, damp, fmtNum, makeRng } from '../core/util'
import { ANCHOR, rid } from './layout'

/* ============================================================================
 * THE CLIENT TERMINAL
 *
 * The application tier, and it is deliberately OUTSIDE the cluster: it stands on
 * its own apron, north of the boundary, and it talks to exactly one thing — the
 * `Distributed` table on the initiator. It has no idea how many shards there
 * are, which is the entire point of that engine.
 *
 * Two docks, because the two things a client does have almost nothing in common:
 *
 *   WRITE DOCK (west)   INSERTs leave here in blocks. The stack of pallets on it
 *                       is the batch size, and it is the single most important
 *                       number a ClickHouse client controls.
 *   READ DOCK (east)    SELECTs leave here and results come back to it.
 * ==========================================================================*/

const TERMINAL_W = 118
const TERMINAL_D = 34
const TERMINAL_H = 15

/** Visible pallets on the write dock. One pallet stands for a slice of the batch. */
const N_PALLETS = 10

const _c = new THREE.Color()
const _p = new THREE.Vector3()
const _q = new THREE.Quaternion()
const _sc = new THREE.Vector3()
const _m = new THREE.Matrix4()

export const createClients: WorldFactory = (ctx): WorldModule => {
  const { theme } = ctx
  const group = new THREE.Group()
  group.name = 'district:clients'

  const owned: { dispose(): void }[] = []
  function own<T extends { dispose(): void }>(x: T): T {
    owned.push(x)
    return x
  }

  const rng = makeRng(0x2b1c99)

  const matStruct = theme.mat('client.struct', {
    color: 0x2a3a52,
    roughness: 0.8,
    metalness: 0.18,
    emissive: 0x0a1220,
  })
  const matTrim = theme.mat('client.trim', {
    color: 0x18222f,
    roughness: 0.92,
    metalness: 0.06,
    emissive: 0x060a11,
  })
  const neonWhite = theme.neon(0xffffff, 1)
  const unitBox = theme.box(1, 1, 1)

  const tz = ANCHOR.clientTerminal[2]

  /* --- the terminal ------------------------------------------------------- */

  const apron = new THREE.Mesh(theme.box(TERMINAL_W + 34, 1.4, TERMINAL_D + 26), matTrim)
  apron.position.set(0, 0.7, tz)
  apron.receiveShadow = true
  group.add(apron)

  const shed = new THREE.Mesh(theme.box(TERMINAL_W, TERMINAL_H, TERMINAL_D), matStruct)
  shed.position.set(0, TERMINAL_H / 2 + 1.4, tz)
  shed.castShadow = true
  shed.receiveShadow = true
  group.add(shed)

  const roof = new THREE.Mesh(theme.box(TERMINAL_W + 6, 1.2, TERMINAL_D + 6), matTrim)
  roof.position.set(0, TERMINAL_H + 2.6, tz)
  roof.castShadow = true
  group.add(roof)

  const sign = theme.textTexture('application tier', { size: 52, color: '#dbe7ff' })
  const signPlate = new THREE.Mesh(
    own(new THREE.PlaneGeometry(60, 8)),
    own(new THREE.MeshBasicMaterial({ map: sign, transparent: true, depthWrite: false, toneMapped: false })),
  )
  signPlate.position.set(0, TERMINAL_H * 0.66, tz + TERMINAL_D / 2 + 0.3)
  signPlate.raycast = () => {}
  group.add(signPlate)

  /* --- the write dock ----------------------------------------------------- */

  // A stack of pallets whose height is the batch size. `insertBlockRows` is the
  // one dial on this whole terminal that decides whether the cluster is healthy,
  // so it gets a physical representation and not a caption.
  const palletMesh = new THREE.InstancedMesh(unitBox, neonWhite, N_PALLETS)
  palletMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
  palletMesh.frustumCulled = false
  palletMesh.userData.chNoShadow = true
  for (let i = 0; i < N_PALLETS; i++) {
    _p.set(-26, 2.4 + i * 1.5, tz + TERMINAL_D / 2 + 10)
    _sc.set(11, 1.1, 8)
    _q.identity()
    _m.compose(_p, _q, _sc)
    palletMesh.setMatrixAt(i, _m)
    _c.setRGB(0, 0, 0)
    palletMesh.setColorAt(i, _c)
  }
  palletMesh.instanceColor!.setUsage(THREE.DynamicDrawUsage)
  palletMesh.instanceMatrix.needsUpdate = true
  group.add(palletMesh)

  const writeDock = new THREE.Mesh(theme.box(16, 2.4, 12), matStruct)
  writeDock.position.set(-26, 1.2 + 1.4, tz + TERMINAL_D / 2 + 10)
  writeDock.castShadow = true
  group.add(writeDock)

  /* --- the read dock ------------------------------------------------------ */

  const readDock = new THREE.Mesh(theme.box(16, 2.4, 12), matStruct)
  readDock.position.set(26, 1.2 + 1.4, tz + TERMINAL_D / 2 + 10)
  readDock.castShadow = true
  group.add(readDock)

  const readLamp = new THREE.Mesh(own(new THREE.SphereGeometry(1.9, 10, 8)), neonWhite)
  readLamp.position.set(26, 8, tz + TERMINAL_D / 2 + 10)
  readLamp.raycast = () => {}
  readLamp.userData.chNoShadow = true
  group.add(readLamp)

  const writeLamp = new THREE.Mesh(own(new THREE.SphereGeometry(1.9, 10, 8)), neonWhite)
  writeLamp.position.set(-26, 19, tz + TERMINAL_D / 2 + 10)
  writeLamp.raycast = () => {}
  writeLamp.userData.chNoShadow = true
  group.add(writeLamp)

  /* --- a few masts so the terminal reads as a building, not a box --------- */

  const unitCyl = theme.cyl(0.5, 0.5, 1, 10)
  for (let i = 0; i < 6; i++) {
    const mast = new THREE.Mesh(unitCyl, matTrim)
    const x = -TERMINAL_W / 2 + 8 + i * ((TERMINAL_W - 16) / 5)
    mast.position.set(x, TERMINAL_H + 6, tz - TERMINAL_D / 2 + 4)
    mast.scale.set(0.8, 8 + rng() * 5, 0.8)
    mast.castShadow = true
    group.add(mast)
  }

  /* --- registration ------------------------------------------------------- */

  ctx.register({
    id: 'clients',
    name: 'Application tier',
    role: 'talks to one Distributed table and knows nothing about shards',
    kind: 'client',
    district: 'clients',
    object: shed,
    tier: 0,
    focus: { target: [0, 10, tz], distance: 180, dir: [0.2, 0.5, -0.9] },
    labelAt: [0, TERMINAL_H + 16, tz],
    color: COLOR.client,
    readout: (s: SimState) =>
      `${s.knobs.insertsPerSec.toFixed(0)} INSERT/s × ${fmtNum(s.knobs.insertBlockRows)} rows · ${s.knobs.selectsPerSec.toFixed(0)} SELECT/s`,
  })

  ctx.register({
    id: 'clients.batch',
    name: 'INSERT batch',
    role: 'rows per INSERT — the number that decides everything downstream',
    kind: 'concept',
    district: 'clients',
    object: writeDock,
    tier: 2,
    focus: { target: [-26, 10, tz + TERMINAL_D / 2 + 10], distance: 60, dir: [-0.4, 0.5, 0.8] },
    labelAt: [-26, 22, tz + TERMINAL_D / 2 + 10],
    color: COLOR.partPreactive,
    readout: (s: SimState) => `${fmtNum(s.knobs.insertBlockRows)} rows per block`,
  })

  /* --- update ------------------------------------------------------------- */

  let writeGlow = 0
  let readGlow = 0
  let insertTimer = 0
  let selectTimer = 0
  let lastInsertRows = 0

  function update(dt: number, sim: SimState, t: number): void {
    const k = sim.knobs

    /* The pallet stack: log-scaled, because a batch runs from a thousand rows to
     * a million and a linear stack would be either invisible or off the roof. */
    const litFrac = clamp01((Math.log10(Math.max(100, k.insertBlockRows)) - 2) / 4.2)
    const lit = Math.round(litFrac * N_PALLETS)
    for (let i = 0; i < N_PALLETS; i++) {
      // Under a thousand rows a batch is a known anti-pattern, so the bottom
      // pallets go amber and then red rather than simply being few.
      const hex = k.insertBlockRows < 2000 ? COLOR.crit : k.insertBlockRows < 20000 ? COLOR.warn : COLOR.client
      _c.setHex(hex).multiplyScalar(i < lit ? 1.4 : 0.06)
      palletMesh.setColorAt(i, _c)
    }
    palletMesh.instanceColor!.needsUpdate = true

    /* The world no longer invents the client's traffic.
     *
     * It used to emit one packet per tick along a single road to a single front
     * door, because there was only one road and only one door. Now the choice of
     * server IS the interesting part, so the packet has to leave from the model,
     * which is the only thing that knows which server was picked — see
     * `pickInitiator`. The lamps here just follow the application's activity. */
    writeGlow = Math.max(writeGlow, sim.clients.activity * (k.insertsPerSec > 0 ? 1 : 0))
    readGlow = Math.max(readGlow, sim.clients.activity * (k.selectsPerSec > 0 ? 1 : 0))

    writeGlow = damp(writeGlow, 0.12, 3.2, dt)
    readGlow = damp(readGlow, 0.12, 3.2, dt)

    const wm = writeLamp.material as THREE.MeshBasicMaterial
    _c.setHex(COLOR.client).multiplyScalar(0.2 + writeGlow * 1.8)
    wm.color.copy(_c)

    const rm = readLamp.material as THREE.MeshBasicMaterial
    _c.setHex(COLOR.ok).multiplyScalar(0.2 + readGlow * 1.8)
    rm.color.copy(_c)

    void t
    void lastInsertRows
    lastInsertRows = k.insertBlockRows
  }

  function dispose(): void {
    for (const o of owned) o.dispose()
    owned.length = 0
    palletMesh.dispose()
  }

  function setDetail(level: 0 | 1 | 2): void {
    palletMesh.visible = level >= 1
    signPlate.visible = level >= 1
  }

  return { id: 'clients', group, update, setDetail, dispose }
}
