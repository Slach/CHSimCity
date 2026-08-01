import * as THREE from 'three'
import { COLOR } from '../core/theme'
import { N_NODES, N_SHARDS } from '../core/types'
import type { SimState, WorldFactory, WorldModule } from '../core/types'
import { clamp01, damp, fmtBytes, fmtNum } from '../core/util'
import { anchorAt, nodeHost, shardOf } from './layout'

/* ============================================================================
 * THE DISTRIBUTED TABLE — ONE ON EVERY SERVER
 *
 * `Distributed` is a table engine, not a machine. `CREATE TABLE … ENGINE =
 * Distributed(cluster, db, local_table, key)` runs on every server in the
 * cluster, so all four have the table, all four read the same
 * `system.clusters`, and all four can answer the question. The server that
 * becomes the INITIATOR of a statement is simply the one the application
 * connected to.
 *
 * So this district is not a district. It is a strip on the NORTH FACE of every
 * island — the side the application tier is on — repeated four times:
 *
 *   THE TABLE           the port the client connects to. Lit while this server
 *                       is initiating something.
 *   THE HASH WHEEL      the sharding expression. A block arrives, the wheel
 *                       turns, and the block leaves in N pieces. The two lit
 *                       arcs are the shards and their WIDTH is the cumulative
 *                       share each has received through THIS server.
 *   THE QUEUE (west)    `system.distribution_queue` — .bin files under
 *                       `data/<database>/<table>/` on THIS server's disk. In
 *                       background mode the INSERT returns as soon as the
 *                       block is here — so if this server dies, these blocks
 *                       die with it, and which server it was is a property of
 *                       the client's connection.
 *   THE MERGE FLOOR     where partial results from the other shards are
 *                       combined. Real CPU work, done by whichever server the
 *                       client happened to reach.
 *   THE CLUSTER BOARD   `system.clusters` as this server sees it: four hosts,
 *                       two shards, a lamp per host.
 *
 * Geometry here is authored in WORLD coordinates through `anchorAt`, which is
 * what every other cross-island module does. Authoring in node-local
 * coordinates and forgetting to convert is the mistake that once put all four
 * islands' labels on the same point.
 * ==========================================================================*/

const WHEEL_SEGMENTS = 48
/**
 * Sized to the strip, not chosen. The island is 210 deep, so its north edge is
 * at z = -105 and the strip sits at -97; the insert dock's arrival apron starts
 * at -86. A radius over 9 either overhangs the plate or reaches into the dock.
 */
const WHEEL_RADIUS = 9
const SILO_H = 15
/** Same arithmetic: -105 .. -89, meeting the plate edge and clearing the dock. */
const PLINTH_DEPTH = 16

const _c = new THREE.Color()
const _p = new THREE.Vector3()
const _q = new THREE.Quaternion()
const _sc = new THREE.Vector3()
const _m = new THREE.Matrix4()
const _e = new THREE.Euler()

/** Everything one server's Distributed strip needs to animate. */
interface Strip {
  tableLamp: THREE.Mesh
  hubLamp: THREE.Mesh
  mergeLamp: THREE.Mesh
  siloFill: THREE.Mesh[]
  hostLamps: THREE.Mesh[]
  siloLevel: Float32Array
  hubGlow: number
  mergeGlow: number
  lastMerged: number
}

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
  const unitCyl = theme.cyl(0.5, 0.5, 1, 12)

  // One wheel mesh for the whole cluster, not one per island: the segments are
  // instances and there is no reason to pay for four draw calls.
  const wheelMesh = new THREE.InstancedMesh(theme.box(1, 1, 1), neonWhite, WHEEL_SEGMENTS * N_NODES)
  wheelMesh.name = 'dist.wheel'
  wheelMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
  wheelMesh.frustumCulled = false
  wheelMesh.userData.chNoShadow = true
  group.add(wheelMesh)

  const strips: Strip[] = []
  const boardPlates: THREE.Mesh[] = []

  for (let n = 0; n < N_NODES; n++) {
    const door = anchorAt(n, 'distTable')
    const wheelAt = anchorAt(n, 'shardWheel')
    const spoolAt = anchorAt(n, 'insertSpool')
    const mergeAt = anchorAt(n, 'resultMerge')
    const boardAt = anchorAt(n, 'clustersBoard')

    /* --- the strip's plinth, along the island's north face ---------------- */

    const plinth = new THREE.Mesh(theme.box(214, 2.4, PLINTH_DEPTH), matTrim)
    plinth.position.set(door[0], 1.2, door[2])
    plinth.receiveShadow = true
    group.add(plinth)

    /* --- the Distributed table itself: the port ------------------------- */

    const hall = new THREE.Mesh(theme.box(34, 9, 15), matStruct)
    hall.position.set(door[0], 2.4 + 4.5, door[2])
    hall.castShadow = true
    hall.receiveShadow = true
    group.add(hall)

    /* The beacon lamps and the silo fills stay raycastable and are ALIASED to
     * their component after the registrations below: the lamp is the part of
     * the building the eye lands on, so it is the part the cursor lands on,
     * and a lamp that swallowed the click used to read as "this is not
     * clickable" for the whole strip. */
    const tableLamp = new THREE.Mesh(own(new THREE.SphereGeometry(1.8, 12, 10)), neonWhite)
    tableLamp.position.set(door[0], 13.6, door[2])
    tableLamp.userData.chNoShadow = true
    group.add(tableLamp)

    /* --- the sharding hash wheel ---------------------------------------- */

    // A ring of segments; each shard owns a contiguous arc, re-lit every frame
    // from the cumulative row counts. Sharding is modular arithmetic on a hash,
    // so a ring is the honest shape for it.
    const wheelY = 8
    for (let i = 0; i < WHEEL_SEGMENTS; i++) {
      const a = (i / WHEEL_SEGMENTS) * Math.PI * 2
      _p.set(wheelAt[0] + Math.cos(a) * WHEEL_RADIUS, wheelY, wheelAt[2] + Math.sin(a) * WHEEL_RADIUS)
      _e.set(0, -a, 0)
      _q.setFromEuler(_e)
      _sc.set(1.2, 1.7, 2.6)
      _m.compose(_p, _q, _sc)
      wheelMesh.setMatrixAt(n * WHEEL_SEGMENTS + i, _m)
      _c.setRGB(0, 0, 0)
      wheelMesh.setColorAt(n * WHEEL_SEGMENTS + i, _c)
    }

    const hub = new THREE.Mesh(unitCyl, matStruct)
    hub.position.set(wheelAt[0], wheelY - 1, wheelAt[2])
    hub.scale.set(6.5, 4, 6.5)
    hub.castShadow = true
    group.add(hub)

    const hubLamp = new THREE.Mesh(own(new THREE.SphereGeometry(1.7, 12, 10)), neonWhite)
    hubLamp.position.set(wheelAt[0], wheelY + 2.6, wheelAt[2])
    hubLamp.userData.chNoShadow = true
    group.add(hubLamp)

    /* --- the background INSERT queue — system.distribution_queue -------- */

    // One silo per shard. Its fill is the bytes THIS server is holding and has
    // not forwarded — the data that is at risk in background mode.
    const siloFill: THREE.Mesh[] = []
    const siloShells: THREE.Mesh[] = []
    for (let s = 0; s < N_SHARDS; s++) {
      const x = spoolAt[0] + (s - (N_SHARDS - 1) / 2) * 15
      const shell = new THREE.Mesh(unitCyl, matGlass)
      shell.position.set(x, 2.4 + SILO_H / 2, spoolAt[2])
      shell.scale.set(10, SILO_H, 10)
      group.add(shell)
      siloShells.push(shell)

      const ring = theme.edges(theme.cyl(0.5, 0.5, 1, 12), COLOR.distributed, 0.3)
      ring.position.copy(shell.position)
      ring.scale.copy(shell.scale)
      group.add(ring)

      const fill = new THREE.Mesh(unitCyl, theme.neon(COLOR.distributed, 1.2))
      fill.position.set(x, 2.6, spoolAt[2])
      fill.scale.set(8.6, 0.4, 8.6)
      fill.userData.chNoShadow = true
      group.add(fill)
      siloFill.push(fill)
    }

    /* --- the result merge floor ----------------------------------------- */

    const mergeFloor = new THREE.Mesh(theme.box(28, 7, 15), matStruct)
    mergeFloor.position.set(mergeAt[0], 2.4 + 3.5, mergeAt[2])
    mergeFloor.castShadow = true
    mergeFloor.receiveShadow = true
    group.add(mergeFloor)

    const mergeLamp = new THREE.Mesh(own(new THREE.SphereGeometry(1.6, 12, 10)), neonWhite)
    mergeLamp.position.set(mergeAt[0], 11.5, mergeAt[2])
    mergeLamp.userData.chNoShadow = true
    group.add(mergeLamp)

    /* --- system.clusters, as a board ------------------------------------ */

    const board = new THREE.Mesh(theme.box(34, 9, 1.8), matTrim)
    board.position.set(boardAt[0], 6.5, boardAt[2])
    board.castShadow = true
    group.add(board)

    const hostLamps: THREE.Mesh[] = []
    for (let h = 0; h < N_NODES; h++) {
      const x = boardAt[0] - 12 + h * 8
      const lamp = new THREE.Mesh(own(new THREE.SphereGeometry(1.15, 10, 8)), neonWhite)
      // On the NORTH face of the board: the clients arrive from the north, and
      // a status board that faces away from the reader shows them its back.
      lamp.position.set(x, 9, boardAt[2] - 1.3)
      lamp.userData.chNoShadow = true
      group.add(lamp)
      hostLamps.push(lamp)
    }

    const sign = theme.textTexture(`${nodeHost(n)} · Distributed`, { size: 40, color: '#dbe7ff' })
    const plate = new THREE.Mesh(
      own(new THREE.PlaneGeometry(52, 5.2)),
      own(new THREE.MeshBasicMaterial({ map: sign, transparent: true, depthWrite: false, toneMapped: false })),
    )
    plate.position.set(door[0], 18, door[2] - 8)
    plate.raycast = () => {}
    group.add(plate)
    boardPlates.push(plate)

    strips.push({
      tableLamp,
      hubLamp,
      mergeLamp,
      siloFill,
      hostLamps,
      siloLevel: new Float32Array(N_SHARDS),
      hubGlow: 0,
      mergeGlow: 0,
      lastMerged: 0,
    })

    /* --- registration ---------------------------------------------------- */

    const host = nodeHost(n)

    ctx.register({
      id: `node.${n}.dist`,
      name: `${host} · Distributed`,
      role: 'the table the clients connect to — it stores nothing and routes everything',
      kind: 'network',
      district: 'nodes',
      object: hall,
      tier: 1,
      focus: { target: [door[0], 10, door[2]], distance: 150, dir: [0.2, 0.5, -0.9] },
      labelAt: [door[0], 26, door[2]],
      color: COLOR.distributed,
      readout: (s: SimState) => {
        const d = s.nodes[n].distributed
        let pending = 0
        for (const p of d.pendingBlocks) pending += p
        const share = shareOfStatements(s, n)
        if (pending > 0) return `${pending} blocks spooled here · ${share} of statements`
        return d.fanOut > 0
          ? `initiating now · fan-out ${d.fanOut} · ${share} of statements`
          : `idle as initiator · ${share} of statements`
      },
    })

    ctx.register({
      id: `node.${n}.wheel`,
      name: 'sharding key',
      role: 'sipHash64(key) % shards — evaluated here, identically on every server',
      kind: 'concept',
      district: 'nodes',
      object: hub,
      tier: 2,
      focus: { target: [wheelAt[0], wheelY, wheelAt[2]], distance: 58, dir: [0.2, 0.85, -0.4] },
      labelAt: [wheelAt[0], wheelY + 11, wheelAt[2]],
      color: COLOR.distributed,
      readout: (s: SimState) => {
        const r = s.nodes[n].distributed.rowsToShard
        const total = r[0] + r[1]
        if (total <= 0) return 'no rows routed through this server'
        // The skew, as a percentage, because that is the number that tells you
        // whether the sharding key was a good choice.
        const skew = Math.abs(r[0] - r[1]) / total
        return `${fmtNum(r[0])} / ${fmtNum(r[1])} rows · ${(skew * 100).toFixed(1)}% skew`
      },
    })

    ctx.register({
      id: `node.${n}.spool`,
      name: 'system.distribution_queue',
      role: 'blocks queued on THIS server’s disk, not yet in any shard',
      kind: 'storage',
      district: 'nodes',
      object: siloFill[0],
      tier: 2,
      focus: { target: [spoolAt[0], 10, spoolAt[2]], distance: 56, dir: [-0.6, 0.5, -0.6] },
      labelAt: [spoolAt[0], 22, spoolAt[2]],
      color: COLOR.distributed,
      readout: (s: SimState) => {
        const d = s.nodes[n].distributed
        let blocks = 0
        let bytes = 0
        for (let i = 0; i < N_SHARDS; i++) {
          blocks += d.pendingBlocks[i]
          bytes += d.pendingBytes[i]
        }
        if (s.knobs.distributedInsert === 'foreground') return 'foreground insert — the queue stays empty'
        return blocks > 0 ? `${blocks} blocks · ${fmtBytes(bytes)} at risk on this disk` : 'empty'
      },
    })

    ctx.register({
      id: `node.${n}.resultmerge`,
      name: 'result merge',
      role: 'partial results from the other shards, combined here',
      kind: 'process',
      district: 'nodes',
      object: mergeFloor,
      tier: 2,
      focus: { target: [mergeAt[0], 8, mergeAt[2]], distance: 54, dir: [0.7, 0.5, -0.5] },
      labelAt: [mergeAt[0], 18, mergeAt[2]],
      color: COLOR.ok,
      readout: (s: SimState) => {
        const d = s.nodes[n].distributed
        return `${fmtNum(d.rowsMerged)} rows · ${fmtBytes(d.bytesFromRemote)} from remote shards`
      },
    })

    ctx.register({
      id: `node.${n}.clusters`,
      name: 'system.clusters',
      role: `${N_SHARDS} shards × ${N_NODES / N_SHARDS} replicas, as this server sees them`,
      kind: 'concept',
      district: 'nodes',
      object: board,
      tier: 2,
      focus: { target: [boardAt[0], 8, boardAt[2]], distance: 52, dir: [0.1, 0.5, -0.85] },
      labelAt: [boardAt[0], 18, boardAt[2]],
      color: COLOR.node,
      readout: (s: SimState) => {
        let up = 0
        for (const nd of s.nodes) if (nd.status === 'up') up++
        return `${up} of ${N_NODES} hosts reachable`
      },
    })

    /* --- aliases: every visible part of a component selects it ------------ */

    ctx.alias(tableLamp, `node.${n}.dist`)
    ctx.alias(hubLamp, `node.${n}.wheel`)
    ctx.alias(mergeLamp, `node.${n}.resultmerge`)
    for (const shell of siloShells) ctx.alias(shell, `node.${n}.spool`)
    for (const fill of siloFill) ctx.alias(fill, `node.${n}.spool`)
    for (const lamp of hostLamps) ctx.alias(lamp, `node.${n}.clusters`)
  }

  wheelMesh.instanceColor!.setUsage(THREE.DynamicDrawUsage)
  wheelMesh.instanceMatrix.needsUpdate = true

  /**
   * What share of the application's statements this server has initiated.
   *
   * The number the whole change exists to make visible: with a driver that
   * knows the cluster it sits near 1/N, and with one hostname in a connection
   * string it is 100% on one server and 0% on the rest — while the DATA is
   * distributed exactly the same either way.
   */
  function shareOfStatements(s: SimState, node: number): string {
    let total = 0
    for (const v of s.clients.sentToNode) total += v
    if (total <= 0) return 'nothing yet'
    return `${((s.clients.sentToNode[node] / total) * 100).toFixed(0)}%`
  }

  /* --- update ------------------------------------------------------------ */

  function update(dt: number, sim: SimState, t: number): void {
    for (let n = 0; n < N_NODES; n++) {
      const st = strips[n]
      const d = sim.nodes[n].distributed

      /* --- the wheel: arc width is cumulative share ---------------------- */
      const total = d.rowsToShard[0] + d.rowsToShard[1]
      for (let i = 0; i < WHEEL_SEGMENTS; i++) {
        const frac = i / WHEEL_SEGMENTS
        // Which shard's arc this segment belongs to, from the cumulative shares.
        let shard = 0
        let acc = 0
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
        //
        // The floor is high on purpose. The whole point of the wheel is that the
        // two arcs can be TOLD APART — that is how the share, and therefore the
        // skew, is readable — and at the 0.3 floor this used to have, the day
        // palette's dark blue and dark teal both came out as the same navy on a
        // ring this size. An arc nobody can distinguish measures nothing.
        const hot = shard === d.lastShard ? 0.5 + 0.5 * d.activity : 0.22
        _c.setHex(shard === 0 ? COLOR.distributed : COLOR.node).multiplyScalar(0.95 + hot * 1.15)
        wheelMesh.setColorAt(n * WHEEL_SEGMENTS + i, _c)
      }

      st.hubGlow = damp(st.hubGlow, d.activity, 5, dt)
      _c.setHex(COLOR.distributed).multiplyScalar(0.25 + st.hubGlow * 1.9)
      ;(st.hubLamp.material as THREE.MeshBasicMaterial).color.copy(_c)

      /* --- the port: lit while this server is the one being asked -------- */
      // Two distinct facts on one lamp: dim means "has the table, nobody is
      // using it", bright means "this is the initiator right now".
      const initiating = clamp01(d.activity + (d.fanOut > 0 ? 0.5 : 0))
      _c.setHex(sim.nodes[n].status === 'down' ? COLOR.crit : COLOR.client).multiplyScalar(
        0.22 + initiating * 1.8,
      )
      ;(st.tableLamp.material as THREE.MeshBasicMaterial).color.copy(_c)

      /* --- the spool silos ----------------------------------------------- */
      for (let s = 0; s < N_SHARDS; s++) {
        // Log-scaled: the spool is normally near-empty and occasionally
        // enormous, and both facts have to be readable on one silo.
        const bytes = d.pendingBytes[s]
        const want = bytes > 0 ? clamp01((Math.log10(bytes) - 4) / 5) : 0
        st.siloLevel[s] = damp(st.siloLevel[s], want, 4, dt)
        const h = Math.max(0.4, st.siloLevel[s] * (SILO_H - 1))
        st.siloFill[s].scale.set(8.6, h, 8.6)
        st.siloFill[s].position.y = 2.6 + h / 2
        // A spool filling faster than it drains is the failure worth seeing, so
        // it warms as it climbs.
        _c.setHex(st.siloLevel[s] > 0.6 ? COLOR.warn : COLOR.distributed).multiplyScalar(
          0.6 + st.siloLevel[s] * 1.3,
        )
        ;(st.siloFill[s].material as THREE.MeshBasicMaterial).color.copy(_c)
      }

      /* --- the merge floor ------------------------------------------------ */
      const arriving = d.rowsMerged > st.lastMerged
      st.lastMerged = d.rowsMerged
      st.mergeGlow = damp(st.mergeGlow, arriving ? 1 : 0.12, 4, dt)
      _c.setHex(COLOR.ok).multiplyScalar(0.2 + st.mergeGlow * 1.8)
      ;(st.mergeLamp.material as THREE.MeshBasicMaterial).color.copy(_c)

      /* --- this server's view of the cluster ----------------------------- */
      for (let h = 0; h < N_NODES; h++) {
        const nd = sim.nodes[h]
        let hex = COLOR.ok
        let gain = 0.9
        if (nd.status === 'down') {
          hex = COLOR.crit
          gain = 0.4 + 0.6 * Math.sin(t * 6 + h)
        } else if (nd.replication.readOnly) {
          hex = COLOR.warn
          gain = 0.7
        } else if (nd.replication.absoluteDelay > 5) {
          // A lagging replica is still "up" as far as the router is concerned,
          // which is exactly the trap `max_replica_delay_for_distributed_queries`
          // exists to close.
          hex = COLOR.warn
          gain = 0.6 + 0.4 * Math.sin(t * 2.5 + h)
        } else if (d.readShard[shardOf(h)] === h) {
          // This server picked that host for the shard it is reading now.
          gain = 1.6
        }
        _c.setHex(hex).multiplyScalar(gain * 1.4)
        ;(st.hostLamps[h].material as THREE.MeshBasicMaterial).color.copy(_c)
      }
    }
    wheelMesh.instanceColor!.needsUpdate = true
  }

  function setDetail(level: 0 | 1 | 2): void {
    for (const p of boardPlates) p.visible = level >= 1
    wheelMesh.visible = level >= 1
  }

  function dispose(): void {
    for (const o of owned) o.dispose()
    owned.length = 0
    wheelMesh.dispose()
  }

  return { id: 'distributed', group, update, setDetail, dispose }
}
