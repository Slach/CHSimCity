import * as THREE from 'three'
import { COLOR } from '../core/theme'
import { N_NODES, N_SHARDS } from '../core/types'
import type { SimState, WorldFactory, WorldModule } from '../core/types'
import { clamp01, damp, fmtBytes, fmtNum } from '../core/util'
import { ANCHOR, N_TABLES, TABLES, nodeHost, shardOf } from './layout'

/* ============================================================================
 * THE DISTRIBUTED INITIATOR
 *
 * A `Distributed` table stores nothing. It is a router with a query rewriter,
 * and this district is drawn as exactly that:
 *
 *   THE HASH WHEEL      the sharding expression. A block arrives, the wheel
 *                       turns, and the block leaves in N pieces. The two lit
 *                       arcs are the shards, and their WIDTH is the cumulative
 *                       share each has received — which is how a bad sharding
 *                       key becomes visible rather than merely suspected.
 *   THE SPOOL (west)    `data/<cluster>/shard<N>_replica<M>/`. In background mode the INSERT
 *                       returns as soon as the block is HERE, on the
 *                       initiator's own disk. If the initiator dies, those
 *                       blocks die with it. One silo per shard, and its fill is
 *                       how much has not been forwarded yet.
 *   THE MERGE FLOOR     where partial results from the shards are combined.
 *                       Only this node ever sees the whole answer.
 *   THE CLUSTER BOARD   `system.clusters`, as a board: four hosts, two shards,
 *                       and a lamp per host.
 * ==========================================================================*/

const WHEEL_SEGMENTS = 72
const WHEEL_RADIUS = 17

const _c = new THREE.Color()
const _c2 = new THREE.Color()
const _p = new THREE.Vector3()
const _q = new THREE.Quaternion()
const _sc = new THREE.Vector3()
const _m = new THREE.Matrix4()
const _e = new THREE.Euler()

export const createDistributed: WorldFactory = (ctx): WorldModule => {
  const { theme } = ctx
  const group = new THREE.Group()
  group.name = 'district:distributed'

  const owned: { dispose(): void }[] = []
  function own<T extends { dispose(): void }>(x: T): T {
    owned.push(x)
    return x
  }

  const matStruct = theme.mat('dist.struct', {
    color: 0x28364f,
    roughness: 0.78,
    metalness: 0.2,
    emissive: 0x0a1220,
  })
  const matTrim = theme.mat('dist.trim', {
    color: 0x17202e,
    roughness: 0.9,
    metalness: 0.08,
    emissive: 0x060a11,
  })
  const matGlass = theme.mat('dist.glass', {
    color: 0x3a5a80,
    roughness: 0.3,
    metalness: 0.06,
    transparent: true,
    opacity: 0.16,
    side: THREE.DoubleSide,
  })
  const neonWhite = theme.neon(0xffffff, 1)
  const unitBox = theme.box(1, 1, 1)
  const unitCyl = theme.cyl(0.5, 0.5, 1, 14)

  const dz = ANCHOR.distributed[2]

  /* --- the initiator's plinth -------------------------------------------- */

  const plinth = new THREE.Mesh(theme.box(120, 3, 66), matTrim)
  plinth.position.set(0, 1.5, dz)
  plinth.receiveShadow = true
  group.add(plinth)

  const hall = new THREE.Mesh(theme.box(56, 11, 40), matStruct)
  hall.position.set(0, 3 + 5.5, dz)
  hall.castShadow = true
  hall.receiveShadow = true
  group.add(hall)

  /* --- the sharding hash wheel ------------------------------------------- */

  // The wheel is a ring of segments; each shard owns a contiguous arc, and the
  // arcs are re-lit every frame from the cumulative row counts. Sharding is
  // modular arithmetic on a hash, so a ring is the honest shape for it.
  const wheelMesh = new THREE.InstancedMesh(unitBox, neonWhite, WHEEL_SEGMENTS)
  wheelMesh.name = 'dist.wheel'
  wheelMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
  wheelMesh.frustumCulled = false
  wheelMesh.userData.chNoShadow = true
  const wheelY = ANCHOR.shardHash[1]
  for (let i = 0; i < WHEEL_SEGMENTS; i++) {
    const a = (i / WHEEL_SEGMENTS) * Math.PI * 2
    _p.set(Math.cos(a) * WHEEL_RADIUS, wheelY, dz - 12 + Math.sin(a) * WHEEL_RADIUS)
    _e.set(0, -a, 0)
    _q.setFromEuler(_e)
    _sc.set(1.5, 2.2, 3.4)
    _m.compose(_p, _q, _sc)
    wheelMesh.setMatrixAt(i, _m)
    _c.setRGB(0, 0, 0)
    wheelMesh.setColorAt(i, _c)
  }
  wheelMesh.instanceColor!.setUsage(THREE.DynamicDrawUsage)
  wheelMesh.instanceMatrix.needsUpdate = true
  group.add(wheelMesh)

  const hub = new THREE.Mesh(unitCyl, matStruct)
  hub.position.set(0, wheelY - 1, dz - 12)
  hub.scale.set(9, 5, 9)
  hub.castShadow = true
  group.add(hub)

  const hubLamp = new THREE.Mesh(own(new THREE.SphereGeometry(2.4, 12, 10)), neonWhite)
  hubLamp.position.set(0, wheelY + 3.4, dz - 12)
  hubLamp.raycast = () => {}
  hubLamp.userData.chNoShadow = true
  group.add(hubLamp)

  for (const px of [-WHEEL_RADIUS - 3, WHEEL_RADIUS + 3]) {
    const pier = new THREE.Mesh(theme.box(2.2, wheelY - 3, 2.2), matTrim)
    pier.position.set(px, (wheelY - 3) / 2 + 3, dz - 12)
    pier.castShadow = true
    group.add(pier)
  }

  /* --- the background insert spool --------------------------------------- */

  // One silo per shard. Its fill is the bytes the initiator is holding and has
  // not forwarded — the data that is at risk in background mode.
  const siloFill: THREE.Mesh[] = []
  const SILO_H = 22
  for (let s = 0; s < N_SHARDS; s++) {
    const x = ANCHOR.insertSpool[0] + (s - (N_SHARDS - 1) / 2) * 22
    const shell = new THREE.Mesh(unitCyl, matGlass)
    shell.position.set(x, 3 + SILO_H / 2, ANCHOR.insertSpool[2])
    shell.scale.set(15, SILO_H, 15)
    group.add(shell)

    const ring = theme.edges(theme.cyl(0.5, 0.5, 1, 14), COLOR.distributed, 0.3)
    ring.position.copy(shell.position)
    ring.scale.copy(shell.scale)
    group.add(ring)

    const fill = new THREE.Mesh(unitCyl, theme.neon(COLOR.distributed, 1.2))
    fill.position.set(x, 3.2, ANCHOR.insertSpool[2])
    fill.scale.set(13, 0.4, 13)
    fill.raycast = () => {}
    fill.userData.chNoShadow = true
    group.add(fill)
    siloFill.push(fill)

    const tex = theme.textTexture(`shard ${s + 1}`, { size: 40, color: '#dbe7ff' })
    const plate = new THREE.Mesh(
      own(new THREE.PlaneGeometry(16, 4)),
      own(new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false, toneMapped: false })),
    )
    plate.rotation.x = -Math.PI / 2
    plate.position.set(x, 3.4, ANCHOR.insertSpool[2] + 13)
    plate.raycast = () => {}
    group.add(plate)
  }

  /* --- the result merge floor -------------------------------------------- */

  const mergeFloor = new THREE.Mesh(theme.box(40, 8, 30), matStruct)
  mergeFloor.position.set(ANCHOR.resultMerge[0], 3 + 4, ANCHOR.resultMerge[2])
  mergeFloor.castShadow = true
  mergeFloor.receiveShadow = true
  group.add(mergeFloor)

  const mergeLamp = new THREE.Mesh(own(new THREE.SphereGeometry(2.2, 12, 10)), neonWhite)
  mergeLamp.position.set(ANCHOR.resultMerge[0], 14, ANCHOR.resultMerge[2])
  mergeLamp.raycast = () => {}
  mergeLamp.userData.chNoShadow = true
  group.add(mergeLamp)

  /* --- system.clusters, as a board -------------------------------------- */

  const board = new THREE.Mesh(theme.box(96, 13, 2.4), matTrim)
  board.position.set(ANCHOR.clustersBoard[0], 8, ANCHOR.clustersBoard[2])
  board.castShadow = true
  group.add(board)

  const hostLamps: THREE.Mesh[] = []
  for (let n = 0; n < N_NODES; n++) {
    const x = -36 + n * 24
    const lamp = new THREE.Mesh(own(new THREE.SphereGeometry(1.7, 10, 8)), neonWhite)
    lamp.position.set(x, 11.5, ANCHOR.clustersBoard[2] + 1.6)
    lamp.raycast = () => {}
    lamp.userData.chNoShadow = true
    group.add(lamp)
    hostLamps.push(lamp)

    const tex = theme.textTexture(nodeHost(n), { size: 34, color: '#a9bcd8' })
    const plate = new THREE.Mesh(
      own(new THREE.PlaneGeometry(21, 3.2)),
      own(new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false, toneMapped: false })),
    )
    plate.position.set(x, 6.4, ANCHOR.clustersBoard[2] + 1.4)
    plate.raycast = () => {}
    group.add(plate)
  }

  const boardSign = theme.textTexture('system.clusters', { size: 44, color: '#dbe7ff' })
  const boardPlate = new THREE.Mesh(
    own(new THREE.PlaneGeometry(46, 6)),
    own(new THREE.MeshBasicMaterial({ map: boardSign, transparent: true, depthWrite: false, toneMapped: false })),
  )
  boardPlate.position.set(0, 17.5, ANCHOR.clustersBoard[2])
  boardPlate.raycast = () => {}
  group.add(boardPlate)

  /* --- registration ------------------------------------------------------ */

  ctx.register({
    id: 'dist',
    name: 'Distributed',
    role: 'the initiator — it stores nothing and routes everything',
    kind: 'network',
    district: 'distributed',
    object: hall,
    tier: 0,
    focus: { target: [0, 10, dz], distance: 200, dir: [0.3, 0.5, -0.85] },
    labelAt: [0, 34, dz],
    color: COLOR.distributed,
    readout: (s: SimState) => {
      const d = s.distributed
      let pending = 0
      for (const p of d.pendingBlocks) pending += p
      return pending > 0
        ? `${pending} blocks spooled locally · fan-out ${d.fanOut}`
        : `fan-out ${d.fanOut} · ${fmtNum(d.rowsMerged)} rows merged`
    },
  })

  ctx.register({
    id: 'dist.shardhash',
    name: 'sharding key',
    role: 'sipHash64(key) % shards — where every row goes',
    kind: 'concept',
    district: 'distributed',
    object: hub,
    tier: 1,
    focus: { target: [0, wheelY, dz - 12], distance: 70, dir: [0.2, 0.85, -0.4] },
    labelAt: [0, wheelY + 12, dz - 12],
    color: COLOR.distributed,
    readout: (s: SimState) => {
      const r = s.distributed.rowsToShard
      const total = r[0] + r[1]
      if (total <= 0) return 'no rows routed yet'
      // The skew, stated as a percentage, because that is the number that tells
      // you whether the sharding key was a good choice.
      const skew = Math.abs(r[0] - r[1]) / total
      return `${fmtNum(r[0])} / ${fmtNum(r[1])} rows · ${(skew * 100).toFixed(1)}% skew`
    },
  })

  ctx.register({
    id: 'dist.spool',
    name: 'background insert spool',
    role: 'blocks on the initiator’s own disk, not yet in any shard',
    kind: 'storage',
    district: 'distributed',
    object: siloFill[0],
    tier: 2,
    focus: { target: [ANCHOR.insertSpool[0], 14, ANCHOR.insertSpool[2]], distance: 70, dir: [-0.6, 0.5, -0.6] },
    labelAt: [ANCHOR.insertSpool[0], 30, ANCHOR.insertSpool[2]],
    color: COLOR.distributed,
    readout: (s: SimState) => {
      const d = s.distributed
      let blocks = 0
      let bytes = 0
      for (let i = 0; i < N_SHARDS; i++) {
        blocks += d.pendingBlocks[i]
        bytes += d.pendingBytes[i]
      }
      if (s.knobs.distributedInsert === 'foreground') return 'foreground insert — nothing is spooled'
      return blocks > 0 ? `${blocks} blocks · ${fmtBytes(bytes)} at risk` : 'empty'
    },
  })

  ctx.register({
    id: 'dist.merge',
    name: 'result merge',
    role: 'partial results from every shard, combined here',
    kind: 'process',
    district: 'distributed',
    object: mergeFloor,
    tier: 2,
    focus: { target: [ANCHOR.resultMerge[0], 8, ANCHOR.resultMerge[2]], distance: 66, dir: [0.7, 0.5, -0.5] },
    labelAt: [ANCHOR.resultMerge[0], 20, ANCHOR.resultMerge[2]],
    color: COLOR.ok,
    readout: (s: SimState) =>
      `${fmtNum(s.distributed.rowsMerged)} rows · ${fmtBytes(s.distributed.bytesFromRemote)} from remote`,
  })

  ctx.register({
    id: 'dist.clusters',
    name: 'system.clusters',
    role: `${N_SHARDS} shards × ${N_NODES / N_SHARDS} replicas`,
    kind: 'concept',
    district: 'distributed',
    object: board,
    tier: 2,
    focus: { target: [0, 10, ANCHOR.clustersBoard[2]], distance: 90, dir: [0.1, 0.4, -0.9] },
    labelAt: [0, 24, ANCHOR.clustersBoard[2]],
    color: COLOR.node,
    readout: (s: SimState) => {
      let up = 0
      for (const n of s.nodes) if (n.status === 'up') up++
      return `${up} of ${N_NODES} hosts reachable`
    },
  })

  /* --- update ------------------------------------------------------------ */

  let hubGlow = 0
  let mergeGlow = 0
  const siloLevel = new Float32Array(N_SHARDS)
  let lastMerged = 0

  function update(dt: number, sim: SimState, t: number): void {
    const d = sim.distributed

    /* --- the wheel: arc width is cumulative share ---------------------- */
    const total = d.rowsToShard[0] + d.rowsToShard[1]
    let acc = 0
    for (let i = 0; i < WHEEL_SEGMENTS; i++) {
      const frac = i / WHEEL_SEGMENTS
      // Which shard's arc this segment belongs to, from the cumulative shares.
      let shard = 0
      acc = 0
      for (let s = 0; s < N_SHARDS; s++) {
        const share = total > 0 ? d.rowsToShard[s] / total : 1 / N_SHARDS
        if (frac < acc + share) {
          shard = s
          break
        }
        acc += share
        shard = s
      }
      // The shard that just received a block flashes; the other holds steady.
      const hot = shard === d.lastShard ? 0.5 + 0.5 * d.activity : 0.22
      _c.setHex(shard === 0 ? COLOR.distributed : COLOR.node).multiplyScalar(0.3 + hot * 1.5)
      wheelMesh.setColorAt(i, _c)
    }
    wheelMesh.instanceColor!.needsUpdate = true

    hubGlow = damp(hubGlow, d.activity, 5, dt)
    const hm = hubLamp.material as THREE.MeshBasicMaterial
    _c.setHex(COLOR.distributed).multiplyScalar(0.25 + hubGlow * 1.9)
    hm.color.copy(_c)

    /* --- the spool silos ----------------------------------------------- */
    for (let s = 0; s < N_SHARDS; s++) {
      // Log-scaled: the spool is normally near-empty and occasionally enormous,
      // and both facts have to be readable on one silo.
      const bytes = d.pendingBytes[s]
      const want = bytes > 0 ? clamp01((Math.log10(bytes) - 4) / 5) : 0
      siloLevel[s] = damp(siloLevel[s], want, 4, dt)
      const h = Math.max(0.4, siloLevel[s] * (SILO_H - 1))
      siloFill[s].scale.set(13, h, 13)
      siloFill[s].position.y = 3.2 + h / 2
      const mat = siloFill[s].material as THREE.MeshBasicMaterial
      // A spool that is filling faster than it drains is the failure worth
      // seeing, so it warms as it climbs.
      _c.setHex(siloLevel[s] > 0.6 ? COLOR.warn : COLOR.distributed).multiplyScalar(0.6 + siloLevel[s] * 1.3)
      mat.color.copy(_c)
    }

    /* --- the merge floor ------------------------------------------------ */
    const merged = d.rowsMerged
    const arriving = merged > lastMerged ? 1 : 0
    lastMerged = merged
    mergeGlow = damp(mergeGlow, arriving > 0 ? 1 : 0.12, 4, dt)
    const mm = mergeLamp.material as THREE.MeshBasicMaterial
    _c.setHex(COLOR.ok).multiplyScalar(0.2 + mergeGlow * 1.8)
    mm.color.copy(_c)

    /* --- the cluster board -------------------------------------------- */
    for (let n = 0; n < N_NODES; n++) {
      const nd = sim.nodes[n]
      const lm = hostLamps[n].material as THREE.MeshBasicMaterial
      let hex = COLOR.ok
      let gain = 0.9
      if (nd.status === 'down') {
        hex = COLOR.crit
        gain = 0.4 + 0.6 * Math.sin(t * 6 + n)
      } else if (nd.replication.readOnly) {
        hex = COLOR.warn
        gain = 0.7
      } else if (nd.replication.absoluteDelay > 5) {
        // A replica that is lagging is still "up" as far as the router is
        // concerned, which is exactly the trap `max_replica_delay_for_distributed_queries`
        // exists to close.
        hex = COLOR.warn
        gain = 0.6 + 0.4 * Math.sin(t * 2.5 + n)
      } else if (sim.distributed.readShard[shardOf(n)] === n) {
        gain = 1.6
      }
      _c.setHex(hex).multiplyScalar(gain * 1.4)
      lm.color.copy(_c)
    }

    void N_TABLES
    void TABLES
    void _c2
  }

  function setDetail(level: 0 | 1 | 2): void {
    boardPlate.visible = level >= 1
    wheelMesh.visible = level >= 1
  }

  function dispose(): void {
    for (const o of owned) o.dispose()
    owned.length = 0
    wheelMesh.dispose()
  }

  return { id: 'distributed', group, update, setDetail, dispose }
}
