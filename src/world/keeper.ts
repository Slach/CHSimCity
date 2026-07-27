import * as THREE from 'three'
import { COLOR } from '../core/theme'
import { N_KEEPERS } from '../core/types'
import type { SimState, WorldFactory, WorldModule } from '../core/types'
import { clamp01, damp, fmtNum } from '../core/util'
import { ANCHOR, keeperPos } from './layout'

/* ============================================================================
 * CLICKHOUSE KEEPER
 *
 * Three nodes, raft, one leader. Keeper holds NO USER DATA — only metadata:
 * block numbers, the replication log, part checksums, mutation entries. This
 * district is deliberately small next to the data islands, and that
 * disproportion is the point: it is a tiny service on which every write depends.
 *
 *   THE THREE HALLS      one per node. The leader stands a row forward and is
 *                        the only one that serves writes; the followers vote.
 *   THE LOG COLUMN       `/clickhouse/tables/{shard}/{table}/log`, drawn as a
 *                        stack of entries above the quorum. Every replica reads
 *                        this and nothing else to learn what to do.
 *   THE ZNODE FIELD      what Keeper is actually holding, and it grows with the
 *                        PART COUNT — which is why "too many parts" is a Keeper
 *                        memory incident as well as a merge one.
 * ==========================================================================*/

const HALL_W = 26
const HALL_D = 22
const HALL_H = 14

/** Visible entries in the log column. A window onto `/log`, newest at the top. */
const N_LOG_SLOTS = 16
/** Znode field: a grid of small posts whose lit count is the znode total. */
const ZNODE_COLS = 24
const ZNODE_ROWS = 4
const N_ZNODES = ZNODE_COLS * ZNODE_ROWS

const _c = new THREE.Color()
const _p = new THREE.Vector3()
const _q = new THREE.Quaternion()
const _sc = new THREE.Vector3()
const _m = new THREE.Matrix4()

export const createKeeper: WorldFactory = (ctx): WorldModule => {
  const { theme } = ctx
  const group = new THREE.Group()
  group.name = 'district:keeper'

  const owned: { dispose(): void }[] = []
  function own<T extends { dispose(): void }>(x: T): T {
    owned.push(x)
    return x
  }

  const matStruct = theme.mat('keeper.struct', {
    color: 0x2b2a4a,
    roughness: 0.8,
    metalness: 0.18,
    emissive: 0x0c0a1c,
  })
  const matTrim = theme.mat('keeper.trim', {
    color: 0x1a1930,
    roughness: 0.92,
    metalness: 0.06,
    emissive: 0x070613,
  })
  const neonWhite = theme.neon(0xffffff, 1)
  const neonSoft = theme.neon(0xffffff, 1, { transparent: true, opacity: 0.4 })
  const unitBox = theme.box(1, 1, 1)
  const unitCyl = theme.cyl(0.5, 0.5, 1, 12)

  /* --- the plinth --------------------------------------------------------- */

  const plinth = new THREE.Mesh(theme.box(216, 2.6, 96), matTrim)
  plinth.position.set(ANCHOR.keeper[0], 1.3, ANCHOR.keeper[2] + 4)
  plinth.receiveShadow = true
  group.add(plinth)

  /* --- the three halls ---------------------------------------------------- */

  interface Hall {
    slot: number
    shell: THREE.Mesh
    crown: THREE.Mesh
    lamp: THREE.Mesh
    beacon: THREE.Mesh
  }
  const halls: Hall[] = []

  for (let i = 0; i < N_KEEPERS; i++) {
    const pos = keeperPos(i)
    const shell = new THREE.Mesh(theme.box(HALL_W, HALL_H, HALL_D), matStruct)
    shell.position.set(pos[0], 2.6 + HALL_H / 2, pos[2])
    shell.castShadow = true
    shell.receiveShadow = true
    group.add(shell)

    // The crown carries the role: leader, follower, or dark. Nothing else about
    // the three halls differs, because in raft nothing else does.
    const crown = new THREE.Mesh(theme.box(HALL_W * 0.7, 1.8, HALL_D * 0.7), neonWhite)
    crown.position.set(pos[0], 2.6 + HALL_H + 1, pos[2])
    crown.raycast = () => {}
    crown.userData.chNoShadow = true
    group.add(crown)

    const lamp = new THREE.Mesh(own(new THREE.SphereGeometry(1.9, 10, 8)), neonWhite)
    lamp.position.set(pos[0], 2.6 + HALL_H + 5.4, pos[2])
    lamp.raycast = () => {}
    lamp.userData.chNoShadow = true
    group.add(lamp)

    // The leader's mast. It is the only visible asymmetry in the quorum, and it
    // moves when an election does.
    const mast = new THREE.Mesh(unitCyl, matTrim)
    mast.position.set(pos[0] + HALL_W / 2 - 3, 2.6 + HALL_H + 8, pos[2] - HALL_D / 2 + 3)
    mast.scale.set(1.1, 14, 1.1)
    mast.castShadow = true
    group.add(mast)

    const beacon = new THREE.Mesh(own(new THREE.SphereGeometry(1.5, 10, 8)), neonSoft)
    beacon.position.set(pos[0] + HALL_W / 2 - 3, 2.6 + HALL_H + 15.5, pos[2] - HALL_D / 2 + 3)
    beacon.raycast = () => {}
    beacon.userData.chNoShadow = true
    group.add(beacon)

    const tex = theme.textTexture(`keeper-${i + 1}`, { size: 40, color: '#dbe7ff' })
    const plate = new THREE.Mesh(
      own(new THREE.PlaneGeometry(19, 4)),
      own(new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false, toneMapped: false })),
    )
    plate.rotation.x = -Math.PI / 2
    plate.position.set(pos[0], 3, pos[2] + HALL_D / 2 + 5)
    plate.raycast = () => {}
    group.add(plate)

    halls.push({ slot: i, shell, crown, lamp, beacon })
  }

  /* --- the log column ----------------------------------------------------- */

  // `/log` as a physical stack above the quorum, newest at the top. Every replica
  // reads from this one place, so it stands over all three halls rather than
  // belonging to any of them.
  const logX = ANCHOR.keeperLog[0]
  const logZ = ANCHOR.keeperLog[2]
  const logBase = 2.6

  for (const px of [-13, 13]) {
    const post = new THREE.Mesh(theme.box(1.8, 46, 1.8), matStruct)
    post.position.set(logX + px, logBase + 23, logZ)
    post.castShadow = true
    group.add(post)
  }

  const logMesh = new THREE.InstancedMesh(unitBox, neonWhite, N_LOG_SLOTS)
  logMesh.name = 'keeper.log'
  logMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
  logMesh.frustumCulled = false
  logMesh.userData.chNoShadow = true
  for (let i = 0; i < N_LOG_SLOTS; i++) {
    _p.set(logX, logBase + 3 + i * 2.7, logZ)
    _sc.set(22, 1.7, 4.2)
    _q.identity()
    _m.compose(_p, _q, _sc)
    logMesh.setMatrixAt(i, _m)
    _c.setRGB(0, 0, 0)
    logMesh.setColorAt(i, _c)
  }
  logMesh.instanceColor!.setUsage(THREE.DynamicDrawUsage)
  logMesh.instanceMatrix.needsUpdate = true
  group.add(logMesh)

  const logSign = theme.textTexture('/log', { size: 48, color: '#dbe7ff' })
  const logPlate = new THREE.Mesh(
    own(new THREE.PlaneGeometry(18, 5)),
    own(new THREE.MeshBasicMaterial({ map: logSign, transparent: true, depthWrite: false, toneMapped: false })),
  )
  logPlate.position.set(logX, logBase + 52, logZ)
  logPlate.raycast = () => {}
  group.add(logPlate)

  /* --- the znode field ---------------------------------------------------- */

  // A field of small posts west of the quorum. The lit count is the znode total,
  // log-scaled, so the growth that matters — an order of magnitude — is visible.
  const znodeMesh = new THREE.InstancedMesh(unitBox, neonWhite, N_ZNODES)
  znodeMesh.name = 'keeper.znodes'
  znodeMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
  znodeMesh.frustumCulled = false
  znodeMesh.userData.chNoShadow = true
  const zx0 = ANCHOR.keeper[0] - 96
  const zz0 = ANCHOR.keeper[2] + 24
  for (let i = 0; i < N_ZNODES; i++) {
    const col = i % ZNODE_COLS
    const row = Math.floor(i / ZNODE_COLS)
    _p.set(zx0 + col * 2.6, 3.4, zz0 + row * 3.2)
    _sc.set(1.5, 1.6, 1.5)
    _q.identity()
    _m.compose(_p, _q, _sc)
    znodeMesh.setMatrixAt(i, _m)
    _c.setRGB(0, 0, 0)
    znodeMesh.setColorAt(i, _c)
  }
  znodeMesh.instanceColor!.setUsage(THREE.DynamicDrawUsage)
  znodeMesh.instanceMatrix.needsUpdate = true
  group.add(znodeMesh)

  const zPad = new THREE.Mesh(theme.box(ZNODE_COLS * 2.6 + 8, 1.4, ZNODE_ROWS * 3.2 + 8), matTrim)
  zPad.position.set(zx0 + ((ZNODE_COLS - 1) * 2.6) / 2, 2.7, zz0 + ((ZNODE_ROWS - 1) * 3.2) / 2)
  zPad.receiveShadow = true
  group.add(zPad)

  const zSign = theme.textTexture('znodes', { size: 38, color: '#a9bcd8' })
  const zPlate = new THREE.Mesh(
    own(new THREE.PlaneGeometry(22, 4)),
    own(new THREE.MeshBasicMaterial({ map: zSign, transparent: true, depthWrite: false, toneMapped: false })),
  )
  zPlate.rotation.x = -Math.PI / 2
  zPlate.position.set(zx0 + ((ZNODE_COLS - 1) * 2.6) / 2, 3.5, zz0 - 7)
  zPlate.raycast = () => {}
  group.add(zPlate)

  /* --- registration ------------------------------------------------------- */

  ctx.register({
    id: 'keeper.ensemble',
    name: 'ClickHouse Keeper',
    role: 'raft quorum — metadata only, and every write depends on it',
    kind: 'process',
    district: 'keeper',
    object: halls[1].shell,
    tier: 0,
    focus: { target: [ANCHOR.keeper[0], 14, ANCHOR.keeper[2]], distance: 220, dir: [0.15, 0.5, 0.85] },
    labelAt: [ANCHOR.keeper[0], 44, ANCHOR.keeper[2]],
    color: COLOR.keeper,
    readout: (s: SimState) => {
      if (!s.knobs.keeperConnected) return 'UNREACHABLE — replicated tables are read-only'
      const leader = s.keepers.find((k) => k.role === 'leader')
      return `leader keeper-${(leader?.slot ?? 1) + 1} · ${fmtNum(leader?.znodes ?? 0)} znodes · ${(
        leader?.requestsPerSec ?? 0
      ).toFixed(0)} req/s`
    },
  })

  ctx.register({
    id: 'keeper.log',
    name: '/log',
    role: 'the one place every replica learns what to do',
    kind: 'concept',
    district: 'keeper',
    object: logMesh,
    tier: 1,
    focus: { target: [logX, logBase + 26, logZ], distance: 100, dir: [0.3, 0.35, 0.9] },
    labelAt: [logX, logBase + 58, logZ],
    color: COLOR.replication,
    readout: (s: SimState) => {
      let minPointer = Infinity
      for (const n of s.nodes) if (n.replication.logPointer < minPointer) minPointer = n.replication.logPointer
      const behind = Math.max(0, s.keeperLogIndex - (isFinite(minPointer) ? minPointer : s.keeperLogIndex))
      return behind > 0
        ? `index ${s.keeperLogIndex} · slowest replica ${behind} entries behind`
        : `index ${s.keeperLogIndex} · every replica caught up`
    },
  })

  ctx.register({
    id: 'keeper.znodes',
    name: 'znodes',
    role: 'what Keeper holds — and it grows with the part count',
    kind: 'memory',
    district: 'keeper',
    object: zPad,
    tier: 2,
    focus: {
      target: [zx0 + ((ZNODE_COLS - 1) * 2.6) / 2, 4, zz0 + ((ZNODE_ROWS - 1) * 3.2) / 2],
      distance: 90,
      dir: [-0.3, 0.6, 0.7],
    },
    labelAt: [zx0 + ((ZNODE_COLS - 1) * 2.6) / 2, 16, zz0 + ((ZNODE_ROWS - 1) * 3.2) / 2],
    color: COLOR.keeper,
    readout: (s: SimState) => `${fmtNum(s.keepers[1]?.znodes ?? 0)} znodes across the ensemble`,
  })

  for (let i = 0; i < N_KEEPERS; i++) {
    const slot = i
    ctx.register({
      id: `keeper.${i}`,
      name: `keeper-${i + 1}`,
      role: 'one raft node',
      kind: 'process',
      district: 'keeper',
      object: halls[i].shell,
      tier: 2,
      focus: { target: [keeperPos(i)[0], 10, keeperPos(i)[2]], distance: 70, dir: [0.2, 0.5, 0.8] },
      labelAt: [keeperPos(i)[0], 2.6 + HALL_H + 20, keeperPos(i)[2]],
      color: COLOR.keeper,
      readout: (s: SimState) => {
        const k = s.keepers[slot]
        if (!k || k.role === 'down') return 'down'
        return `${k.role} · term ${k.term} · commit ${k.commitIndex}`
      },
    })
  }

  /* --- update ------------------------------------------------------------- */

  const crownLevel = new Float32Array(N_KEEPERS)
  const logLevel = new Float32Array(N_LOG_SLOTS)
  let znodeLit = 0
  let lastLogIndex = 0

  function update(dt: number, sim: SimState, t: number): void {
    const connected = sim.knobs.keeperConnected

    /* --- the three halls ------------------------------------------------ */
    for (let i = 0; i < N_KEEPERS; i++) {
      const k = sim.keepers[i]
      const isLeader = k.role === 'leader'
      const down = k.role === 'down'
      crownLevel[i] = damp(crownLevel[i], down ? 0 : isLeader ? 1 : 0.42, 4, dt)

      const cm = halls[i].crown.material as THREE.MeshBasicMaterial
      _c.setHex(down ? COLOR.crit : COLOR.keeper).multiplyScalar(
        down ? 0.3 + 0.7 * Math.abs(Math.sin(t * 5)) : crownLevel[i] * 1.7,
      )
      cm.color.copy(_c)

      const lm = halls[i].lamp.material as THREE.MeshBasicMaterial
      _c.setHex(down ? COLOR.crit : isLeader ? COLOR.ok : COLOR.keeper).multiplyScalar(
        down ? 0.6 : 0.4 + k.activity * 1.5,
      )
      lm.color.copy(_c)

      // The beacon marks the leader, and only the leader.
      const bm = halls[i].beacon.material as THREE.MeshBasicMaterial
      _c.setHex(COLOR.ok).multiplyScalar(isLeader ? 0.8 + 0.6 * Math.sin(t * 2.4) : 0)
      bm.color.copy(_c)
    }

    /* --- the log column ------------------------------------------------- */
    // A new entry lights the top slot and everything below it steps down one, so
    // the column reads as a stack being written to rather than a bar chart.
    const grew = sim.keeperLogIndex > lastLogIndex
    lastLogIndex = sim.keeperLogIndex
    if (grew) {
      for (let i = N_LOG_SLOTS - 1; i > 0; i--) logLevel[i] = logLevel[i - 1]
      logLevel[0] = 1
    }
    for (let i = 0; i < N_LOG_SLOTS; i++) {
      logLevel[i] = damp(logLevel[i], 0.1, 0.55, dt)
      // Slot 0 is the newest, so the stack is drawn top-down.
      const idx = N_LOG_SLOTS - 1 - i
      _c.setHex(connected ? COLOR.replication : COLOR.crit).multiplyScalar(
        connected ? 0.1 + logLevel[i] * 1.7 : 0.08,
      )
      logMesh.setColorAt(idx, _c)
    }
    logMesh.instanceColor!.needsUpdate = true

    /* --- the znode field ------------------------------------------------ */
    const znodes = sim.keepers[1]?.znodes ?? 0
    // Log-scaled over 100 .. 1,000,000: that is the range in which a real Keeper
    // goes from comfortable to out of heap.
    const want = znodes > 0 ? clamp01((Math.log10(Math.max(100, znodes)) - 2) / 4) : 0
    znodeLit = damp(znodeLit, want, 2, dt)
    const lit = Math.round(znodeLit * N_ZNODES)
    for (let i = 0; i < N_ZNODES; i++) {
      // Past three quarters of the field the colour warms and then goes critical:
      // znode count is a capacity, not a statistic.
      const frac = i / N_ZNODES
      const hex = frac > 0.86 ? COLOR.crit : frac > 0.68 ? COLOR.warn : COLOR.keeper
      _c.setHex(hex).multiplyScalar(i < lit ? 1.4 : 0.05)
      znodeMesh.setColorAt(i, _c)
    }
    znodeMesh.instanceColor!.needsUpdate = true
  }

  function setDetail(level: 0 | 1 | 2): void {
    znodeMesh.visible = level >= 1
    zPad.visible = level >= 1
    logPlate.visible = level >= 1
  }

  function dispose(): void {
    for (const o of owned) o.dispose()
    owned.length = 0
    logMesh.dispose()
    znodeMesh.dispose()
  }

  return { id: 'keeper', group, update, setDetail, dispose }
}
