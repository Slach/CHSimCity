import * as THREE from 'three'
import { COLOR } from '../core/theme'
import {
  INDEX_GRANULARITY,
  N_LEVEL_LANES,
  N_MERGE_SLOTS,
  N_NODES,
  N_PART_SLOTS,
  N_QUEUE_SLOTS,
  N_READ_THREADS,
} from '../core/types'
import type { PartSim, PartState, SimState, WorldFactory, WorldModule } from '../core/types'
import { clamp, clamp01, damp, fmtBytes, fmtNum, makeRng, partitionId } from '../core/util'
import {
  CITY,
  LOCAL,
  N_TABLES,
  TABLES,
  bandZLocal,
  mergeSlotLocal,
  nodeHost,
  nodeLocal,
  nodeOrigin,
  partCellPitch,
  partLaneZ,
  partLevelLane,
  partPlaceLocal,
  partitionGroupX,
  queueSlotLocal,
  readerBayLocal,
  replicaOf,
  shardOf,
  streamCount,
  yardCellWidth,
  yardHalfWidth,
  yardTableHalfWidth,
} from './layout'

/* ============================================================================
 * THE DATA NODES — four islands, and everything a `MergeTree` does.
 *
 * Each island is one ClickHouse server. Read west to east and the write path,
 * the read path and the background work are laid out in the order they happen:
 *
 *   INSERT DOCK (north)      a block arrives, is sorted by the ORDER BY key,
 *                            split by the partition expression, and each column
 *                            is compressed into its own `.bin`
 *   PRIMARY INDEX (west)     `primary.cidx`: one sorting-key row per granule.
 *                            Its height IS its mark count, and its ticks ARE
 *                            the granules — 8192 rows each.
 *   SKIP INDEX SHEDS (west)  `skp_idx_*.idx2`, one shed per index. The plate on
 *                            each says what it can prune and what it cannot.
 *   CACHE DECK (north, up)   the mark cache and the uncompressed cache, as two
 *                            tanks whose fill is what is resident.
 *   PARTS YARD (centre)      `system.parts`. One tower per part, HEIGHT = rows,
 *                            COLOUR = state, standing over the excavation the
 *                            data actually lives in. One band per TABLE, one
 *                            group per PARTITION, one lane per merge LEVEL.
 *   READ POOL (east)         `MergeTreeReadPool` and its reader threads.
 *   MERGE GANTRY (south)     `system.merges`. A beam down onto every input part.
 *   TTL WORKS (south-east)   where expired rows are removed, or moved.
 *   REPLICATION QUEUE (west) `system.replication_queue` and the Keeper session.
 *   STORAGE VOLUMES (below)  hot and cold, in the excavation.
 *
 * VISUAL CONTRACT — a part's colour is its `system.parts.state`, and nothing
 * else in the cluster is allowed those five colours. A green tower is a part a
 * SELECT can see; a grey one has been merged away and is only still there
 * because a running query might be reading it.
 *
 * On top of that, and only on top of it, a part PULSES: red while it is being
 * written, green while it is being read. That is the same red/green axis the
 * moving packets use, and it is a temporal channel rather than a second palette
 * — at rest a tower's colour is still exactly its state. The pulse is what makes
 * a background merge legible: its input parts blink green in lane `x-1` because
 * they are being read, and one part blinks red in lane `x` because it is being
 * written.
 * ==========================================================================*/

const Y = CITY.yard
const HALF_YARD_X = yardHalfWidth()
/** Widest partition count across the tables — how many cell pads a band needs. */
const MAX_PARTITIONS = TABLES.reduce((m, t) => Math.max(m, t.partitions), 1)
/** One pad per (table, partition, level lane). */
const N_CELL_PADS = N_TABLES * MAX_PARTITIONS * N_LEVEL_LANES

/* --- module-scope scratch: update() must never allocate -------------------- */
const _p = new THREE.Vector3()
const _sc = new THREE.Vector3()
const _q = new THREE.Quaternion()
const _e = new THREE.Euler()
const _m = new THREE.Matrix4()
const _c = new THREE.Color()
const _c2 = new THREE.Color()

type BoxSpec = [number, number, number, number, number, number]

function setBox(mesh: THREE.InstancedMesh, idx: number, x: number, y: number, z: number, w: number, h: number, d: number): void {
  _p.set(x, y, z)
  _sc.set(Math.max(1e-4, w), Math.max(1e-4, h), Math.max(1e-4, d))
  _q.identity()
  _m.compose(_p, _q, _sc)
  mesh.setMatrixAt(idx, _m)
}

/** Park an instance far below the world so it cannot be seen or picked. */
function parkBox(mesh: THREE.InstancedMesh, idx: number): void {
  _p.set(0, -4000, 0)
  _sc.set(1e-4, 1e-4, 1e-4)
  _q.identity()
  _m.compose(_p, _q, _sc)
  mesh.setMatrixAt(idx, _m)
}

function pushBoxEdges(out: number[], s: BoxSpec): void {
  const [cx, cy, cz, w, h, d] = s
  const x0 = cx - w / 2
  const x1 = cx + w / 2
  const y0 = cy - h / 2
  const y1 = cy + h / 2
  const z0 = cz - d / 2
  const z1 = cz + d / 2
  const v: [number, number, number][] = [
    [x0, y0, z0],
    [x1, y0, z0],
    [x1, y0, z1],
    [x0, y0, z1],
    [x0, y1, z0],
    [x1, y1, z0],
    [x1, y1, z1],
    [x0, y1, z1],
  ]
  const e = [0, 1, 1, 2, 2, 3, 3, 0, 4, 5, 5, 6, 6, 7, 7, 4, 0, 4, 1, 5, 2, 6, 3, 7]
  for (let i = 0; i < e.length; i++) {
    const p = v[e[i]]
    out.push(p[0], p[1], p[2])
  }
}

/**
 * Height of a part tower, in world units, from its row count.
 *
 * Logarithmic, and it has to be: a level-5 part holds ten million rows and a
 * level-0 part holds a hundred thousand. Linear height would make every small
 * part invisible next to the big one, and the small parts are the whole point —
 * they are what a merge is for and what "too many parts" counts.
 */
function partHeight(rows: number): number {
  if (rows <= 0) return 0.2
  // Calibrated across the range the model actually produces: a thousand rows
  // from a tiny INSERT is barely a kerbstone, a hundred million from a level-5
  // merge is the full height. A linear scale would make every level-0 part
  // invisible next to them, and the level-0 parts are the whole point.
  const k = Math.log10(Math.max(10, rows))
  return clamp((k - 2.9) * 2.85, 0.5, Y.maxRise)
}

/** The one place a part's state becomes a colour. See the visual contract. */
function partColor(state: PartState): number {
  switch (state) {
    case 'active':
      return COLOR.partActive
    case 'outdated':
      return COLOR.partOutdated
    case 'preactive':
      return COLOR.partPreactive
    case 'temporary':
      return COLOR.partTemporary
    default:
      return COLOR.partOutdated
  }
}

/** Emissive weight per state. Only `active` is fully lit: only it answers a query. */
function partGain(state: PartState): number {
  switch (state) {
    case 'active':
      return 1.35
    case 'preactive':
      return 1.1
    case 'temporary':
      return 0.75
    case 'outdated':
      return 0.3
    default:
      return 0.14
  }
}

/* ============================================================================
 * One island.
 * ==========================================================================*/

interface Island {
  node: number
  group: THREE.Group
  /* the yard */
  partMesh: THREE.InstancedMesh
  partCapMesh: THREE.InstancedMesh
  /** The (partition, level) grid the towers stand on. */
  partCellMesh: THREE.InstancedMesh
  /* the primary index */
  indexTower: THREE.Mesh
  indexTicks: THREE.LineSegments
  indexBeam: THREE.Mesh
  /* skip indexes */
  skipMesh: THREE.InstancedMesh
  /* caches */
  markFill: THREE.Mesh
  blockFill: THREE.Mesh
  markLamp: THREE.Mesh
  blockLamp: THREE.Mesh
  /* the read pool */
  readerMesh: THREE.InstancedMesh
  readerBarMesh: THREE.InstancedMesh
  dispatcherLamp: THREE.Mesh
  /* merges */
  mergeMesh: THREE.InstancedMesh
  mergeBarMesh: THREE.InstancedMesh
  mergeBeamMesh: THREE.InstancedMesh
  /* ttl */
  ttlFurnace: THREE.Mesh
  ttlFlare: THREE.Mesh
  /* volumes */
  volFill: THREE.Mesh[]
  /* replication */
  queueMesh: THREE.InstancedMesh
  keeperLamp: THREE.Mesh
  /* status */
  statusLamp: THREE.Mesh
  cpuBar: THREE.Mesh
  /* pick proxies, kept so the registry can point at them */
  proxies: Record<string, THREE.Mesh>
  /* smoothed per-slot visual state */
  partRise: Float32Array
  partRgb: Float32Array
  /**
   * Where each tower currently STANDS, damped toward where it belongs.
   *
   * A part's place is derived from its partition, its level and its rank among
   * its neighbours, so it moves when a neighbour is merged away or when the cell
   * squeezes to fit one more. Damping turns that into the yard visibly
   * compacting instead of towers teleporting sideways.
   */
  partX: Float32Array
  partZ: Float32Array
  partW: Float32Array
  readerLevel: Float32Array
  mergeLevel: Float32Array
  queueLevel: Float32Array
  ttlGlow: number
  indexGlow: number
  skipGlow: Float32Array
}

export const createNodes: WorldFactory = (ctx): WorldModule => {
  const { theme } = ctx
  const group = new THREE.Group()
  group.name = 'district:nodes'

  const owned: { dispose(): void }[] = []
  function own<T extends { dispose(): void }>(x: T): T {
    owned.push(x)
    return x
  }

  const rng = makeRng(0x4d3a71)

  /* --- shared materials -------------------------------------------------- */

  const matStruct = theme.mat('node.struct', {
    color: 0x263449,
    roughness: 0.78,
    metalness: 0.22,
    emissive: 0x0a121e,
  })
  const matDeck = theme.mat('node.deck', {
    color: 0x1c2839,
    roughness: 0.86,
    metalness: 0.12,
    emissive: 0x070c15,
  })
  const matTrim = theme.mat('node.trim', {
    color: 0x161f2e,
    roughness: 0.9,
    metalness: 0.08,
    emissive: 0x060a12,
  })
  const matGlass = theme.mat('node.glass', {
    color: 0x39597f,
    roughness: 0.3,
    metalness: 0.06,
    transparent: true,
    opacity: 0.15,
    side: THREE.DoubleSide,
  })
  // Part towers take their albedo entirely from instanceColor, so the base
  // colour is white and the material must never be tinted.
  const matPart = theme.mat('node.part', {
    color: 0xffffff,
    roughness: 0.55,
    metalness: 0.18,
    emissive: 0x0a1018,
  })
  const neonWhite = theme.neon(0xffffff, 1)
  const neonSoft = theme.neon(0xffffff, 1, { transparent: true, opacity: 0.42 })
  const lineInk = theme.line(COLOR.inkDim, 0.2)
  const lineNode = theme.line(COLOR.node, 0.3)

  const unitBox = theme.box(1, 1, 1)
  const unitCyl = theme.cyl(0.5, 0.5, 1, 12)

  const pickMat = own(
    new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false, colorWrite: false }),
  )

  /* --- build every island ------------------------------------------------ */

  const islands: Island[] = []
  for (let n = 0; n < N_NODES; n++) islands.push(buildIsland(n))
  for (const isl of islands) group.add(isl.group)

  function proxy(isl: Island, id: string, x: number, y: number, z: number, w: number, h: number, d: number): THREE.Mesh {
    const geo = own(new THREE.BoxGeometry(w, h, d))
    const mesh = new THREE.Mesh(geo, pickMat)
    mesh.position.set(x, y, z)
    mesh.renderOrder = -1
    isl.group.add(mesh)
    isl.proxies[id] = mesh
    return mesh
  }

  function buildIsland(node: number): Island {
    const o = nodeOrigin(node)
    const g = new THREE.Group()
    g.name = `node.${node}`
    g.position.set(o[0], o[1], o[2])

    const edgeVerts: number[] = []
    const isl: Partial<Island> & { proxies: Record<string, THREE.Mesh> } = { node, group: g, proxies: {} }

    /* ---- the yard deck, floating over the excavation ------------------- */

    const deck = new THREE.Mesh(theme.box(Y.deckW, CITY.node.deckThickness, Y.deckD), matDeck)
    deck.name = 'yard.deck'
    deck.position.set(0, CITY.node.deckTop - CITY.node.deckThickness / 2, 0)
    deck.receiveShadow = true
    g.add(deck)
    pushBoxEdges(edgeVerts, [0, deck.position.y, 0, Y.deckW, CITY.node.deckThickness, Y.deckD])

    // Four causeways from the deck to the surrounding ground, so the deck reads
    // as a structure spanning the cut rather than as a slab floating in mid-air.
    const causeways: BoxSpec[] = [
      [0, 1.2, -(Y.deckD / 2 + 14), 22, 1.4, 28],
      [0, 1.2, Y.deckD / 2 + 14, 22, 1.4, 28],
      [-(Y.deckW / 2 + 12), 1.2, 0, 24, 1.4, 18],
      [Y.deckW / 2 + 12, 1.2, 0, 24, 1.4, 18],
    ]
    for (const c of causeways) {
      const m = new THREE.Mesh(theme.box(c[3], c[4], c[5]), matStruct)
      m.position.set(c[0], c[1], c[2])
      m.castShadow = true
      m.receiveShadow = true
      g.add(m)
      pushBoxEdges(edgeVerts, c)
    }

    /* ---- the parts yard ------------------------------------------------- */

    const totalSlots = N_TABLES * N_PART_SLOTS

    /* The grid the towers stand on: one flat pad per (partition, merge level).
     *
     * This replaces the old one-pad-per-slot capacity grid, and it is a better
     * trade. The pads no longer say "the yard holds 96 towers" — a number that
     * was never a fact about ClickHouse — they say which parts could legally be
     * merged with which, which is. An empty pad in lane 3 of one partition means
     * that partition has nothing at level 3, and that is a real answer. */
    const partCellMesh = new THREE.InstancedMesh(unitBox, matTrim, N_CELL_PADS)
    partCellMesh.name = 'yard.cells'
    partCellMesh.frustumCulled = false
    partCellMesh.raycast = () => {}
    partCellMesh.userData.chNoShadow = true
    for (let t = 0; t < N_TABLES; t++) {
      for (let p = 0; p < MAX_PARTITIONS; p++) {
        for (let lane = 0; lane < N_LEVEL_LANES; lane++) {
          const i = (t * MAX_PARTITIONS + p) * N_LEVEL_LANES + lane
          // A table with fewer partitions than the widest one has no pad there:
          // the partition does not exist, so nothing may suggest it does.
          if (p >= TABLES[t].partitions) {
            parkBox(partCellMesh, i)
            continue
          }
          setBox(
            partCellMesh,
            i,
            partitionGroupX(t, p),
            Y.baseY + 0.06,
            partLaneZ(t, lane),
            yardCellWidth() - 0.5,
            0.12,
            Y.pitchZ * 0.72,
          )
        }
      }
    }
    partCellMesh.instanceMatrix.needsUpdate = true
    g.add(partCellMesh)

    const partMesh = new THREE.InstancedMesh(unitBox, matPart, totalSlots)
    partMesh.name = 'yard.parts'
    partMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
    partMesh.frustumCulled = false
    partMesh.userData.chNoShadow = true
    _c.setRGB(0, 0, 0)
    for (let i = 0; i < totalSlots; i++) {
      parkBox(partMesh, i)
      partMesh.setColorAt(i, _c)
    }
    partMesh.instanceColor!.setUsage(THREE.DynamicDrawUsage)
    g.add(partMesh)

    // The cap: a thin neon plate on top of a tower that has been rewritten by a
    // MUTATION. It used to carry the merge level, which the lanes now say far
    // better; a mutation version has nowhere else to appear.
    const partCapMesh = new THREE.InstancedMesh(unitBox, neonWhite, totalSlots)
    partCapMesh.name = 'yard.caps'
    partCapMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
    partCapMesh.frustumCulled = false
    partCapMesh.raycast = () => {}
    partCapMesh.userData.chNoShadow = true
    for (let i = 0; i < totalSlots; i++) {
      parkBox(partCapMesh, i)
      partCapMesh.setColorAt(i, _c)
    }
    partCapMesh.instanceColor!.setUsage(THREE.DynamicDrawUsage)
    g.add(partCapMesh)

    /* The yard's three axes are only readable if they are named, so all three
     * are: the table on the west kerb, the partition id along the north edge of
     * its group, and the merge level at the head of each lane on the east. */
    const decal = (text: string, size: number, w: number, h: number, x: number, z: number): void => {
      const tex = theme.textTexture(text, { size, color: '#dbe7ff' })
      const plateGeo = own(new THREE.PlaneGeometry(w, h))
      const plateMat = own(
        new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false, toneMapped: false }),
      )
      const plate = new THREE.Mesh(plateGeo, plateMat)
      plate.rotation.x = -Math.PI / 2
      plate.position.set(x, Y.baseY + 0.2, z)
      plate.raycast = () => {}
      g.add(plate)
    }

    for (let t = 0; t < N_TABLES; t++) {
      decal(TABLES[t].name, 44, 13, 3.1, -HALF_YARD_X - 9, bandZLocal(t))
      const northZ = partLaneZ(t, 0) - Y.pitchZ * 0.95
      for (let p = 0; p < TABLES[t].partitions; p++) {
        // The real `partition_id`, so the plate matches the leading field of
        // every part name standing on it.
        decal(partitionId(p), 30, yardCellWidth() * 0.8, 2.1, partitionGroupX(t, p), northZ)
      }
      const laneX = yardTableHalfWidth(t) + 4.4
      for (let lane = 0; lane < N_LEVEL_LANES; lane++) {
        // The deepest lane is a bucket, not a level, and says so.
        decal(lane === N_LEVEL_LANES - 1 ? `${lane}+` : `${lane}`, 26, 2.4, 2.4, laneX, partLaneZ(t, lane))
      }
    }

    /* ---- the primary index --------------------------------------------- */

    // A tall thin tower with a tick per granule. It is the ONLY structure on the
    // island drawn as a pure vertical stack of equal steps, because that is what
    // a sparse index is: one entry per fixed number of rows.
    const idxH = 30
    const indexTower = new THREE.Mesh(theme.box(5.4, idxH, 5.4), matStruct)
    indexTower.name = 'primaryindex.tower'
    indexTower.position.set(LOCAL.primaryIndex[0], idxH / 2, LOCAL.primaryIndex[2])
    indexTower.castShadow = true
    g.add(indexTower)
    pushBoxEdges(edgeVerts, [LOCAL.primaryIndex[0], idxH / 2, LOCAL.primaryIndex[2], 5.4, idxH, 5.4])

    const tickVerts: number[] = []
    const TICKS = 22
    for (let i = 0; i < TICKS; i++) {
      const y = 1.4 + (i / TICKS) * (idxH - 2)
      const x = LOCAL.primaryIndex[0]
      const z = LOCAL.primaryIndex[2]
      tickVerts.push(x - 3.4, y, z - 2.8, x + 3.4, y, z - 2.8)
      tickVerts.push(x - 3.4, y, z + 2.8, x + 3.4, y, z + 2.8)
    }
    const tickGeo = own(new THREE.BufferGeometry())
    tickGeo.setAttribute('position', new THREE.Float32BufferAttribute(tickVerts, 3))
    const indexTicks = new THREE.LineSegments(tickGeo, theme.line(COLOR.primaryIndex, 0.42))
    indexTicks.name = 'primaryindex.granules'
    indexTicks.raycast = () => {}
    g.add(indexTicks)

    // The binary-search beam: it lights the moment a query probes the index, and
    // its height is where in the key space the search landed.
    const beamGeo = own(new THREE.BoxGeometry(1.6, idxH * 0.9, 1.6))
    const indexBeam = new THREE.Mesh(beamGeo, neonWhite)
    indexBeam.name = 'primaryindex.beam'
    indexBeam.position.set(LOCAL.primaryIndex[0], idxH * 0.5, LOCAL.primaryIndex[2])
    indexBeam.raycast = () => {}
    indexBeam.userData.chNoShadow = true
    g.add(indexBeam)

    /* ---- skip index sheds ---------------------------------------------- */

    // Three bays, and a shed only stands in one if the table has that index.
    const MAX_SKIP = 3
    const skipMesh = new THREE.InstancedMesh(unitBox, neonWhite, MAX_SKIP * N_TABLES)
    skipMesh.name = 'skipindex.sheds'
    skipMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
    skipMesh.frustumCulled = false
    skipMesh.userData.chNoShadow = true
    let skipSlot = 0
    for (let t = 0; t < N_TABLES; t++) {
      for (let k = 0; k < MAX_SKIP; k++) {
        const i = skipSlot++
        if (k >= TABLES[t].skipIndexes.length) {
          parkBox(skipMesh, i)
          _c.setRGB(0, 0, 0)
          skipMesh.setColorAt(i, _c)
          continue
        }
        const idx = TABLES[t].skipIndexes[k]
        const x = LOCAL.skipIndexes[0] + (k - 1) * 8
        const z = LOCAL.skipIndexes[2] + (t - (N_TABLES - 1) / 2) * 11
        // Height is the index's selectivity: a shed that prunes 90% of blocks
        // stands tall, and a `set` that has overflowed is barely a kerbstone.
        const h = 1 + idx.selectivity * 8
        setBox(skipMesh, i, x, h / 2, z, 5.2, h, 5.2)
        _c.setHex(COLOR.skipIndex).multiplyScalar(0.35)
        skipMesh.setColorAt(i, _c)
        const shell = new THREE.Mesh(theme.box(6, 9.4, 6), matTrim)
        shell.position.set(x, 4.7, z)
        shell.castShadow = true
        g.add(shell)
        pushBoxEdges(edgeVerts, [x, 4.7, z, 6, 9.4, 6])
      }
    }
    skipMesh.instanceColor!.setUsage(THREE.DynamicDrawUsage)
    skipMesh.instanceMatrix.needsUpdate = true
    g.add(skipMesh)

    /* ---- the cache deck ------------------------------------------------ */

    const deckY = LOCAL.cacheDeck[1]
    const cacheDeck = new THREE.Mesh(theme.box(CITY.cacheDeck.w, 1.6, CITY.cacheDeck.d), matStruct)
    cacheDeck.position.set(0, deckY - 0.8, LOCAL.cacheDeck[2])
    cacheDeck.castShadow = true
    cacheDeck.receiveShadow = true
    g.add(cacheDeck)
    pushBoxEdges(edgeVerts, [0, deckY - 0.8, LOCAL.cacheDeck[2], CITY.cacheDeck.w, 1.6, CITY.cacheDeck.d])

    // Two piers holding the deck up over the yard's north causeway.
    for (const px of [-CITY.cacheDeck.w / 2 + 6, CITY.cacheDeck.w / 2 - 6]) {
      const pier = new THREE.Mesh(theme.box(2.4, deckY, 2.4), matTrim)
      pier.position.set(px, deckY / 2, LOCAL.cacheDeck[2])
      pier.castShadow = true
      g.add(pier)
    }

    const TANK_W = 30
    const TANK_H = 11
    const TANK_D = 12

    function tank(x: number, hex: number, label: string): { fill: THREE.Mesh; lamp: THREE.Mesh } {
      const shell = new THREE.Mesh(theme.box(TANK_W, TANK_H, TANK_D), matGlass)
      shell.position.set(x, deckY + TANK_H / 2, LOCAL.cacheDeck[2])
      g.add(shell)
      pushBoxEdges(edgeVerts, [x, deckY + TANK_H / 2, LOCAL.cacheDeck[2], TANK_W, TANK_H, TANK_D])

      const fillGeo = own(new THREE.BoxGeometry(TANK_W - 1.6, 1, TANK_D - 1.6))
      const fill = new THREE.Mesh(fillGeo, theme.neon(hex, 1.2))
      fill.position.set(x, deckY + 0.5, LOCAL.cacheDeck[2])
      fill.raycast = () => {}
      fill.userData.chNoShadow = true
      g.add(fill)

      // The hit-ratio lamp on the tank's crown: this is the number that decides
      // whether the cache is doing anything, and it is not the fill level.
      const lampGeo = own(new THREE.SphereGeometry(1.5, 10, 8))
      const lamp = new THREE.Mesh(lampGeo, neonWhite)
      lamp.position.set(x, deckY + TANK_H + 2.2, LOCAL.cacheDeck[2])
      lamp.raycast = () => {}
      lamp.userData.chNoShadow = true
      g.add(lamp)

      const tex = theme.textTexture(label, { size: 40, color: '#dbe7ff' })
      const plate = new THREE.Mesh(
        own(new THREE.PlaneGeometry(20, 4.4)),
        own(new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false, toneMapped: false })),
      )
      plate.position.set(x, deckY + TANK_H / 2, LOCAL.cacheDeck[2] + TANK_D / 2 + 0.2)
      plate.raycast = () => {}
      g.add(plate)

      return { fill, lamp }
    }

    const markTank = tank(LOCAL.markCache[0], COLOR.markCache, 'mark_cache')
    const blockTank = tank(LOCAL.uncompressedCache[0], COLOR.blockCache, 'uncompressed')

    /* ---- the insert dock ----------------------------------------------- */

    const dockSpecs: BoxSpec[] = [
      // the arrival apron
      [LOCAL.insertDock[0], 1.4, LOCAL.insertDock[2], 30, 2.8, 16],
      // the sort table: a wide low bench, because sorting is a pass over memory
      [LOCAL.sortTable[0], 3.4, LOCAL.sortTable[2], 18, 6.8, 12],
      // the column writers: one stack per stream, which is why it is tall
      [LOCAL.columnWriters[0], 5.5, LOCAL.columnWriters[2], 16, 11, 12],
    ]
    for (const s of dockSpecs) {
      const m = new THREE.Mesh(theme.box(s[3], s[4], s[5]), matStruct)
      m.position.set(s[0], s[1], s[2])
      m.castShadow = true
      m.receiveShadow = true
      g.add(m)
      pushBoxEdges(edgeVerts, s)
    }

    // One thin stack per stream on the writer block: a wide table really does
    // open this many files per part, and that is why `min_bytes_for_wide_part`
    // exists.
    const streamCount0 = Math.min(24, streamCount(0))
    for (let i = 0; i < streamCount0; i++) {
      const stack = new THREE.Mesh(unitCyl, matTrim)
      stack.position.set(
        LOCAL.columnWriters[0] - 7 + (i % 12) * 1.28,
        11 + 1.6,
        LOCAL.columnWriters[2] - 3 + Math.floor(i / 12) * 5,
      )
      stack.scale.set(0.7, 3.2, 0.7)
      stack.castShadow = true
      g.add(stack)
    }

    /* ---- the read pool ------------------------------------------------- */

    const disp = new THREE.Mesh(theme.box(14, 9, 14), matStruct)
    disp.position.set(LOCAL.readPoolDispatcher[0], 4.5, LOCAL.readPoolDispatcher[2])
    disp.castShadow = true
    g.add(disp)
    pushBoxEdges(edgeVerts, [LOCAL.readPoolDispatcher[0], 4.5, LOCAL.readPoolDispatcher[2], 14, 9, 14])

    const dispatcherLamp = new THREE.Mesh(own(new THREE.SphereGeometry(1.8, 10, 8)), neonWhite)
    dispatcherLamp.position.set(LOCAL.readPoolDispatcher[0], 11.4, LOCAL.readPoolDispatcher[2])
    dispatcherLamp.raycast = () => {}
    dispatcherLamp.userData.chNoShadow = true
    g.add(dispatcherLamp)

    const readerMesh = new THREE.InstancedMesh(unitBox, neonWhite, N_READ_THREADS)
    readerMesh.name = 'readpool.threads'
    readerMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
    readerMesh.frustumCulled = false
    readerMesh.userData.chNoShadow = true
    const readerBarMesh = new THREE.InstancedMesh(unitBox, neonWhite, N_READ_THREADS)
    readerBarMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
    readerBarMesh.frustumCulled = false
    readerBarMesh.raycast = () => {}
    readerBarMesh.userData.chNoShadow = true
    for (let i = 0; i < N_READ_THREADS; i++) {
      const b = readerBayLocal(i)
      const bay = new THREE.Mesh(theme.box(9, 5.2, 6.4), matTrim)
      bay.position.set(b[0], 2.6, b[2])
      bay.castShadow = true
      g.add(bay)
      setBox(readerMesh, i, b[0], 5.6, b[2], 6.4, 1.2, 4.4)
      setBox(readerBarMesh, i, b[0] - 3.6, 5.6, b[2], 0.6, 1.4, 4.4)
      _c.setRGB(0, 0, 0)
      readerMesh.setColorAt(i, _c)
      readerBarMesh.setColorAt(i, _c)
    }
    readerMesh.instanceColor!.setUsage(THREE.DynamicDrawUsage)
    readerBarMesh.instanceColor!.setUsage(THREE.DynamicDrawUsage)
    readerMesh.instanceMatrix.needsUpdate = true
    g.add(readerMesh, readerBarMesh)

    /* ---- the merge gantry ---------------------------------------------- */

    // A real gantry: two legs and a beam spanning the yard's south side, with a
    // bay per background-pool slot hanging off it.
    const gantryY = 15
    for (const lx of [-HALF_YARD_X - 6, HALF_YARD_X + 6]) {
      const leg = new THREE.Mesh(theme.box(3.2, gantryY + 2, 3.2), matStruct)
      leg.position.set(lx, (gantryY + 2) / 2, LOCAL.mergeGantry[2])
      leg.castShadow = true
      g.add(leg)
    }
    const beam = new THREE.Mesh(theme.box(HALF_YARD_X * 2 + 16, 2.6, 5), matStruct)
    beam.position.set(0, gantryY + 1.3, LOCAL.mergeGantry[2])
    beam.castShadow = true
    g.add(beam)
    pushBoxEdges(edgeVerts, [0, gantryY + 1.3, LOCAL.mergeGantry[2], HALF_YARD_X * 2 + 16, 2.6, 5])

    const mergeMesh = new THREE.InstancedMesh(unitBox, neonWhite, N_MERGE_SLOTS)
    mergeMesh.name = 'merges.bays'
    mergeMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
    mergeMesh.frustumCulled = false
    mergeMesh.userData.chNoShadow = true
    const mergeBarMesh = new THREE.InstancedMesh(unitBox, neonWhite, N_MERGE_SLOTS)
    mergeBarMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
    mergeBarMesh.frustumCulled = false
    mergeBarMesh.raycast = () => {}
    mergeBarMesh.userData.chNoShadow = true
    // One beam per merge, reaching from the bay down onto the yard. It is the
    // only thing in the cluster that visibly connects a background job to the
    // exact parts it has reserved.
    const mergeBeamMesh = new THREE.InstancedMesh(unitBox, neonSoft, N_MERGE_SLOTS)
    mergeBeamMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
    mergeBeamMesh.frustumCulled = false
    mergeBeamMesh.raycast = () => {}
    mergeBeamMesh.userData.chNoShadow = true

    for (let i = 0; i < N_MERGE_SLOTS; i++) {
      const s = mergeSlotLocal(i)
      const housing = new THREE.Mesh(theme.box(18, 6, 8), matTrim)
      housing.position.set(s[0], gantryY - 3, s[2])
      housing.castShadow = true
      g.add(housing)
      setBox(mergeMesh, i, s[0], gantryY - 3, s[2], 15, 2.2, 5.4)
      setBox(mergeBarMesh, i, s[0] - 7, gantryY - 6.4, s[2], 0.5, 1.1, 5)
      parkBox(mergeBeamMesh, i)
      _c.setRGB(0, 0, 0)
      mergeMesh.setColorAt(i, _c)
      mergeBarMesh.setColorAt(i, _c)
      mergeBeamMesh.setColorAt(i, _c)
    }
    mergeMesh.instanceColor!.setUsage(THREE.DynamicDrawUsage)
    mergeBarMesh.instanceColor!.setUsage(THREE.DynamicDrawUsage)
    mergeBeamMesh.instanceColor!.setUsage(THREE.DynamicDrawUsage)
    mergeMesh.instanceMatrix.needsUpdate = true
    g.add(mergeMesh, mergeBarMesh, mergeBeamMesh)

    /* ---- the TTL works ------------------------------------------------- */

    const furnaceShell = new THREE.Mesh(theme.box(18, 13, 16), matStruct)
    furnaceShell.position.set(LOCAL.ttlWorks[0], 6.5, LOCAL.ttlWorks[2])
    furnaceShell.castShadow = true
    g.add(furnaceShell)
    pushBoxEdges(edgeVerts, [LOCAL.ttlWorks[0], 6.5, LOCAL.ttlWorks[2], 18, 13, 16])

    const ttlFurnace = new THREE.Mesh(own(new THREE.BoxGeometry(12, 8, 10)), neonWhite)
    ttlFurnace.name = 'ttl.core'
    ttlFurnace.position.set(LOCAL.ttlWorks[0], 5, LOCAL.ttlWorks[2])
    ttlFurnace.raycast = () => {}
    ttlFurnace.userData.chNoShadow = true
    g.add(ttlFurnace)

    // The flue. It flares when a TTL merge actually drops rows, which is the one
    // moment the TTL costs anything.
    const ttlFlare = new THREE.Mesh(own(new THREE.ConeGeometry(3.2, 12, 10, 1, true)), neonSoft)
    ttlFlare.position.set(LOCAL.ttlWorks[0], 19, LOCAL.ttlWorks[2])
    ttlFlare.raycast = () => {}
    ttlFlare.userData.chNoShadow = true
    g.add(ttlFlare)
    const flue = new THREE.Mesh(unitCyl, matTrim)
    flue.position.set(LOCAL.ttlWorks[0], 15.5, LOCAL.ttlWorks[2])
    flue.scale.set(3.4, 5, 3.4)
    flue.castShadow = true
    g.add(flue)

    /* ---- the storage volumes ------------------------------------------- */

    const volFill: THREE.Mesh[] = []
    const volSpecs = [
      { y: CITY.storage.hotY, hex: COLOR.hot, label: 'hot · local SSD' },
      { y: CITY.storage.coldY, hex: COLOR.cold, label: 'cold · S3' },
    ]
    for (const v of volSpecs) {
      const slab = new THREE.Mesh(theme.box(CITY.storage.w, 5, CITY.storage.d), matStruct)
      slab.position.set(LOCAL.hotVolume[0], v.y, LOCAL.hotVolume[2])
      slab.receiveShadow = true
      g.add(slab)
      pushBoxEdges(edgeVerts, [LOCAL.hotVolume[0], v.y, LOCAL.hotVolume[2], CITY.storage.w, 5, CITY.storage.d])

      // The fill bar runs along the slab's north edge: used bytes out of total.
      const fillGeo = own(new THREE.BoxGeometry(1, 2.4, 4))
      const fill = new THREE.Mesh(fillGeo, theme.neon(v.hex, 1.15))
      fill.position.set(LOCAL.hotVolume[0], v.y + 3.6, LOCAL.hotVolume[2] - CITY.storage.d / 2 + 4)
      fill.raycast = () => {}
      fill.userData.chNoShadow = true
      g.add(fill)
      volFill.push(fill)

      const tex = theme.textTexture(v.label, { size: 40, color: '#dbe7ff' })
      const plate = new THREE.Mesh(
        own(new THREE.PlaneGeometry(34, 5)),
        own(new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false, toneMapped: false })),
      )
      plate.rotation.x = -Math.PI / 2
      plate.position.set(LOCAL.hotVolume[0], v.y + 2.7, LOCAL.hotVolume[2] + 16)
      plate.raycast = () => {}
      g.add(plate)
    }

    /* ---- the replication queue ----------------------------------------- */

    const rack = new THREE.Mesh(theme.box(34, 12, 9), matStruct)
    rack.position.set(LOCAL.replicationQueue[0], 6, LOCAL.replicationQueue[2])
    rack.castShadow = true
    g.add(rack)
    pushBoxEdges(edgeVerts, [LOCAL.replicationQueue[0], 6, LOCAL.replicationQueue[2], 34, 12, 9])

    const queueMesh = new THREE.InstancedMesh(unitBox, neonWhite, N_QUEUE_SLOTS)
    queueMesh.name = 'replication.queue'
    queueMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
    queueMesh.frustumCulled = false
    queueMesh.userData.chNoShadow = true
    for (let i = 0; i < N_QUEUE_SLOTS; i++) {
      const s = queueSlotLocal(i)
      setBox(queueMesh, i, s[0], s[1], LOCAL.replicationQueue[2] + 4.8, 3.6, 3.2, 0.8)
      _c.setRGB(0, 0, 0)
      queueMesh.setColorAt(i, _c)
    }
    queueMesh.instanceColor!.setUsage(THREE.DynamicDrawUsage)
    queueMesh.instanceMatrix.needsUpdate = true
    g.add(queueMesh)

    // The Keeper session lamp. When this is dark the table is read-only, and
    // that is the whole failure mode in one light.
    const keeperLamp = new THREE.Mesh(own(new THREE.SphereGeometry(1.9, 10, 8)), neonWhite)
    keeperLamp.position.set(LOCAL.replicationQueue[0] + 20, 8, LOCAL.replicationQueue[2])
    keeperLamp.raycast = () => {}
    keeperLamp.userData.chNoShadow = true
    g.add(keeperLamp)

    /* ---- the status mast ----------------------------------------------- */

    const mastX = -Y.deckW / 2 - 26
    const mastZ = -CITY.node.d / 2 + 26
    const mast = new THREE.Mesh(unitCyl, matStruct)
    mast.position.set(mastX, 15, mastZ)
    mast.scale.set(1.6, 30, 1.6)
    mast.castShadow = true
    g.add(mast)

    const statusLamp = new THREE.Mesh(own(new THREE.SphereGeometry(2.6, 12, 10)), neonWhite)
    statusLamp.position.set(mastX, 32, mastZ)
    statusLamp.userData.chNoShadow = true
    g.add(statusLamp)

    const cpuGeo = own(new THREE.BoxGeometry(1.6, 1, 1.6))
    const cpuBar = new THREE.Mesh(cpuGeo, theme.neon(COLOR.reader, 1.2))
    cpuBar.position.set(mastX + 3.4, 1, mastZ)
    cpuBar.raycast = () => {}
    cpuBar.userData.chNoShadow = true
    g.add(cpuBar)

    const hostTex = theme.textTexture(nodeHost(node), { size: 56, color: '#e8f1ff' })
    const hostPlate = new THREE.Mesh(
      own(new THREE.PlaneGeometry(30, 7)),
      own(new THREE.MeshBasicMaterial({ map: hostTex, transparent: true, depthWrite: false, toneMapped: false })),
    )
    hostPlate.rotation.x = -Math.PI / 2
    // Painted on the deck, so it has one right way up and it must be the way the
    // visitor arrives from — which is the application tier, in the north. Laying
    // the plane flat alone leaves it legible from the SOUTH, and the establishing
    // shot used to be down there; it is not any more.
    hostPlate.rotation.z = Math.PI
    hostPlate.position.set(mastX + 20, 0.3, mastZ)
    hostPlate.raycast = () => {}
    g.add(hostPlate)

    /* ---- one blueprint line pass for the whole island ------------------ */

    const edgeGeo = own(new THREE.BufferGeometry())
    edgeGeo.setAttribute('position', new THREE.Float32BufferAttribute(edgeVerts, 3))
    const edgeLines = new THREE.LineSegments(edgeGeo, lineInk)
    edgeLines.raycast = () => {}
    edgeLines.renderOrder = 2
    g.add(edgeLines)

    // The island's own kerb, so four islands read as four machines.
    const kerbVerts: number[] = []
    const kw = CITY.node.w / 2
    const kd = CITY.node.d / 2
    kerbVerts.push(-kw, 0.1, -kd, kw, 0.1, -kd)
    kerbVerts.push(kw, 0.1, -kd, kw, 0.1, kd)
    kerbVerts.push(kw, 0.1, kd, -kw, 0.1, kd)
    kerbVerts.push(-kw, 0.1, kd, -kw, 0.1, -kd)
    const kerbGeo = own(new THREE.BufferGeometry())
    kerbGeo.setAttribute('position', new THREE.Float32BufferAttribute(kerbVerts, 3))
    const kerb = new THREE.LineSegments(kerbGeo, lineNode)
    kerb.raycast = () => {}
    g.add(kerb)

    const built: Island = {
      node,
      group: g,
      partMesh,
      partCapMesh,
      partCellMesh,
      indexTower,
      indexTicks,
      indexBeam,
      skipMesh,
      markFill: markTank.fill,
      blockFill: blockTank.fill,
      markLamp: markTank.lamp,
      blockLamp: blockTank.lamp,
      readerMesh,
      readerBarMesh,
      dispatcherLamp,
      mergeMesh,
      mergeBarMesh,
      mergeBeamMesh,
      ttlFurnace,
      ttlFlare,
      volFill,
      queueMesh,
      keeperLamp,
      statusLamp,
      cpuBar,
      proxies: isl.proxies,
      partRise: new Float32Array(totalSlots),
      partRgb: new Float32Array(totalSlots * 3),
      // NaN would be a valid "no position yet" marker but poisons the damp; 0 is
      // the deck's centre and the first frame snaps out of it, so instead the
      // rise being zero is what says "this tower has never stood anywhere".
      partX: new Float32Array(totalSlots),
      partZ: new Float32Array(totalSlots),
      partW: new Float32Array(totalSlots),
      readerLevel: new Float32Array(N_READ_THREADS),
      mergeLevel: new Float32Array(N_MERGE_SLOTS),
      queueLevel: new Float32Array(N_QUEUE_SLOTS),
      ttlGlow: 0,
      indexGlow: 0,
      skipGlow: new Float32Array(MAX_SKIP * N_TABLES),
    }

    /* ---- pick proxies and registration --------------------------------- */

    /* A low slab, NOT a box over the whole island: this proxy means "the
     * click landed on the island itself". At 40 units tall it was hit before
     * every building on the plate — the raycaster returns the nearest surface,
     * and the box's top face was nearer than any roof — so clicking the yard,
     * the strip or a shed from above selected the server instead. The slab
     * keeps the empty plate selecting the island while everything standing on
     * it wins its own click. */
    proxy(built, 'island', 0, 1, 0, CITY.node.w, 10, CITY.node.d)
    proxy(built, 'yard', 0, Y.baseY + Y.maxRise / 2, 0, Y.deckW, Y.maxRise + 4, Y.deckD)
    proxy(built, 'insertdock', 0, 6, LOCAL.insertDock[2], 96, 14, 22)
    proxy(built, 'primaryindex', LOCAL.primaryIndex[0], idxH / 2, LOCAL.primaryIndex[2], 9, idxH, 9)
    proxy(built, 'skipindexes', LOCAL.skipIndexes[0], 6, LOCAL.skipIndexes[2], 26, 12, 38)
    proxy(built, 'markcache', LOCAL.markCache[0], deckY + TANK_H / 2, LOCAL.markCache[2], TANK_W, TANK_H + 6, TANK_D)
    proxy(
      built,
      'uncompressedcache',
      LOCAL.uncompressedCache[0],
      deckY + TANK_H / 2,
      LOCAL.uncompressedCache[2],
      TANK_W,
      TANK_H + 6,
      TANK_D,
    )
    proxy(built, 'readpool', LOCAL.readPool[0], 7, LOCAL.readPool[2] + 18, 20, 16, 92)
    proxy(built, 'merges', 0, gantryY - 2, LOCAL.mergeGantry[2], HALF_YARD_X * 2 + 18, 14, 12)
    proxy(built, 'ttl', LOCAL.ttlWorks[0], 9, LOCAL.ttlWorks[2], 22, 22, 20)
    proxy(built, 'volumes', LOCAL.hotVolume[0], (CITY.storage.hotY + CITY.storage.coldY) / 2, LOCAL.hotVolume[2], CITY.storage.w, 34, CITY.storage.d)
    proxy(built, 'queue', LOCAL.replicationQueue[0], 6, LOCAL.replicationQueue[2], 42, 14, 12)
    proxy(built, 'mutations', LOCAL.mutationShed[0], 6, LOCAL.mutationShed[2], 20, 14, 16)

    const mutShed = new THREE.Mesh(theme.box(16, 10, 12), matStruct)
    mutShed.position.set(LOCAL.mutationShed[0], 5, LOCAL.mutationShed[2])
    mutShed.castShadow = true
    g.add(mutShed)

    registerIsland(built, idxH, deckY, TANK_H, gantryY)

    return built
  }

  /* ======================================================================
   * Registration.
   * ====================================================================*/

  function registerIsland(isl: Island, idxH: number, deckY: number, tankH: number, gantryY: number): void {
    const n = isl.node
    const host = nodeHost(n)
    const shard = shardOf(n)
    const replica = replicaOf(n)
    const P = isl.proxies

    /* ComponentDef.focus.target and labelAt are WORLD coordinates; everything
     * inside an island is authored in LOCAL ones. `w()` is the bridge, and it is
     * not optional: without it all four islands registered their focus and their
     * label anchor at the same point between the shards, so every "fly to" landed
     * in the gap and all four nodes' labels stacked on top of each other. */
    const w = (lx: number, ly: number, lz: number): [number, number, number] => nodeLocal(n, lx, ly, lz)

    ctx.register({
      id: `node.${n}`,
      name: host,
      role: `shard ${shard + 1}, replica ${replica + 1} — one ClickHouse server`,
      kind: 'process',
      district: 'nodes',
      object: P.island,
      tier: 0,
      focus: { target: w(0, 20, 0), distance: 300, dir: [0.4, 0.55, 0.9] },
      labelAt: w(0, 54, -70),
      color: COLOR.node,
      readout: (s) => {
        const nd = s.nodes[n]
        if (nd.status === 'down') return `${host} · DOWN`
        let parts = 0
        for (const t of nd.tables) parts += t.activeParts
        return `${parts} parts · ${fmtNum(nd.insertRowsPerSec)} rows/s in · ${(nd.cpu * 100).toFixed(0)}% cpu`
      },
    })

    ctx.register({
      id: `node.${n}.yard`,
      name: 'system.parts',
      role: 'one tower per part — partition across, merge level back, rows up',
      kind: 'storage',
      district: 'nodes',
      object: P.yard,
      tier: 1,
      focus: { target: w(0, 8, 0), distance: 130, dir: [0.15, 0.75, 0.6] },
      labelAt: w(0, Y.maxRise + 10, 0),
      color: COLOR.partActive,
      readout: (s) => {
        const nd = s.nodes[n]
        let active = 0
        let outdated = 0
        for (const t of nd.tables) {
          active += t.activeParts
          outdated += t.outdatedParts
        }
        return `${active} active · ${outdated} outdated · ${fmtBytes(
          nd.tables.reduce((a, t) => a + t.bytesOnDisk, 0),
        )}`
      },
    })

    ctx.register({
      id: `node.${n}.insertdock`,
      name: 'MergeTreeDataWriter',
      role: 'sort by ORDER BY, split by PARTITION BY, compress each column',
      kind: 'process',
      district: 'nodes',
      object: P.insertdock,
      tier: 1,
      focus: { target: w(0, 8, LOCAL.insertDock[2]), distance: 90, dir: [0.2, 0.5, -0.9] },
      labelAt: w(0, 20, LOCAL.insertDock[2]),
      color: COLOR.partPreactive,
      readout: (s) => {
        const nd = s.nodes[n]
        const delay = nd.insertDelay > 0.02 ? ` · delayed ${(nd.insertDelay * 100).toFixed(0)}%` : ''
        return `${fmtNum(nd.blocksWritten)} blocks · ${fmtNum(nd.insertRowsPerSec)} rows/s${delay}`
      },
    })

    ctx.register({
      id: `node.${n}.primaryindex`,
      name: 'primary.cidx',
      role: `the sparse primary index — one key row per ${fmtNum(INDEX_GRANULARITY)}-row granule`,
      kind: 'memory',
      district: 'nodes',
      object: P.primaryindex,
      tier: 1,
      focus: { target: w(LOCAL.primaryIndex[0], idxH / 2, LOCAL.primaryIndex[2]), distance: 70, dir: [-0.8, 0.4, 0.5] },
      labelAt: w(LOCAL.primaryIndex[0], idxH + 6, LOCAL.primaryIndex[2]),
      color: COLOR.primaryIndex,
      readout: (s) => {
        const nd = s.nodes[n]
        let marks = 0
        for (const t of nd.tables) for (const p of t.parts) if (p.state === 'active') marks += p.marks
        return `${fmtNum(marks)} marks resident`
      },
    })

    ctx.register({
      id: `node.${n}.skipindexes`,
      name: 'data skipping indexes',
      role: 'skp_idx_*.idx2 — they only ever remove work',
      kind: 'storage',
      district: 'nodes',
      object: P.skipindexes,
      tier: 2,
      focus: { target: w(LOCAL.skipIndexes[0], 6, LOCAL.skipIndexes[2]), distance: 70, dir: [-0.8, 0.5, 0.3] },
      labelAt: w(LOCAL.skipIndexes[0], 18, LOCAL.skipIndexes[2]),
      color: COLOR.skipIndex,
      readout: () => {
        let n2 = 0
        for (const t of TABLES) n2 += t.skipIndexes.length
        return `${n2} indexes across ${N_TABLES} tables`
      },
    })

    ctx.register({
      id: `node.${n}.markcache`,
      name: 'mark cache',
      role: '.mrk3 offsets — a reader cannot seek without them',
      kind: 'memory',
      district: 'nodes',
      object: P.markcache,
      tier: 2,
      focus: { target: w(LOCAL.markCache[0], deckY + tankH / 2, LOCAL.markCache[2]), distance: 60, dir: [0.2, 0.5, -0.8] },
      labelAt: w(LOCAL.markCache[0], deckY + tankH + 8, LOCAL.markCache[2]),
      color: COLOR.markCache,
      readout: (s) => {
        const c = s.nodes[n].markCache
        return `${(c.hitRatio * 100).toFixed(1)}% hit · ${fmtBytes(c.capacityBytes)}`
      },
    })

    ctx.register({
      id: `node.${n}.uncompressedcache`,
      name: 'uncompressed cache',
      role: 'decompressed blocks — off by default, and usually correctly',
      kind: 'memory',
      district: 'nodes',
      object: P.uncompressedcache,
      tier: 2,
      focus: {
        target: w(LOCAL.uncompressedCache[0], deckY + tankH / 2, LOCAL.uncompressedCache[2]),
        distance: 60,
        dir: [0.2, 0.5, -0.8],
      },
      labelAt: w(LOCAL.uncompressedCache[0], deckY + tankH + 8, LOCAL.uncompressedCache[2]),
      color: COLOR.blockCache,
      readout: (s) => {
        const c = s.nodes[n].uncompressedCache
        if (c.capacityBytes <= 0) return 'disabled'
        return `${(c.hitRatio * 100).toFixed(1)}% hit · ${fmtBytes(c.capacityBytes)}`
      },
    })

    ctx.register({
      id: `node.${n}.readpool`,
      name: 'MergeTreeReadPool',
      role: 'hands mark ranges to max_threads reader threads',
      kind: 'process',
      district: 'nodes',
      object: P.readpool,
      tier: 1,
      focus: { target: w(LOCAL.readPool[0], 8, LOCAL.readPool[2] + 18), distance: 110, dir: [0.85, 0.45, 0.2] },
      labelAt: w(LOCAL.readPool[0], 22, LOCAL.readPool[2] + 18),
      color: COLOR.reader,
      readout: (s) => {
        const nd = s.nodes[n]
        let busy = 0
        for (const r of nd.readers) if (r.state !== 'idle') busy++
        const q = nd.queries[0]
        if (!q) return `${busy}/${N_READ_THREADS} threads · idle`
        return `${busy}/${N_READ_THREADS} threads · ${fmtNum(q.granulesAfterSkip)} of ${fmtNum(q.granulesTotal)} granules`
      },
    })

    ctx.register({
      id: `node.${n}.merges`,
      name: 'system.merges',
      role: 'the background pool that keeps the part count finite',
      kind: 'process',
      district: 'nodes',
      object: P.merges,
      tier: 1,
      focus: { target: w(0, gantryY - 2, LOCAL.mergeGantry[2]), distance: 120, dir: [0.1, 0.5, 0.9] },
      labelAt: w(0, gantryY + 12, LOCAL.mergeGantry[2]),
      color: COLOR.merge,
      readout: (s) => {
        const nd = s.nodes[n]
        let running = 0
        let mem = 0
        for (const m of nd.merges)
          if (m.active) {
            running++
            mem += m.memoryBytes
          }
        if (running === 0) return 'idle'
        return `${running} merging · ${fmtBytes(mem)} held`
      },
    })

    ctx.register({
      id: `node.${n}.ttl`,
      name: 'TTL works',
      role: 'a TTL merge rewrites the part without the expired rows',
      kind: 'process',
      district: 'nodes',
      object: P.ttl,
      tier: 2,
      focus: { target: w(LOCAL.ttlWorks[0], 9, LOCAL.ttlWorks[2]), distance: 70, dir: [0.7, 0.5, 0.6] },
      labelAt: w(LOCAL.ttlWorks[0], 28, LOCAL.ttlWorks[2]),
      color: COLOR.ttl,
      readout: (s) => {
        const nd = s.nodes[n]
        let expired = 0
        for (const t of nd.tables) expired += t.expiredParts
        return expired > 0 ? `${expired} parts wholly expired` : 'nothing expired'
      },
    })

    ctx.register({
      id: `node.${n}.volumes`,
      name: 'storage_policy',
      role: 'hot local SSD over cold object storage',
      kind: 'storage',
      district: 'nodes',
      object: P.volumes,
      tier: 2,
      focus: {
        target: w(LOCAL.hotVolume[0], (CITY.storage.hotY + CITY.storage.coldY) / 2, LOCAL.hotVolume[2]),
        distance: 130,
        dir: [0.5, 0.25, 0.9],
      },
      labelAt: w(LOCAL.hotVolume[0], CITY.storage.hotY + 12, LOCAL.hotVolume[2]),
      color: COLOR.hot,
      readout: (s) => {
        const v = s.nodes[n].volumes
        return `hot ${fmtBytes(v[0].usedBytes)} · cold ${fmtBytes(v[1].usedBytes)}`
      },
    })

    ctx.register({
      id: `node.${n}.queue`,
      name: 'system.replication_queue',
      role: 'what this replica has been told to do and has not done yet',
      kind: 'network',
      district: 'nodes',
      object: P.queue,
      tier: 1,
      focus: { target: w(LOCAL.replicationQueue[0], 6, LOCAL.replicationQueue[2]), distance: 80, dir: [-0.7, 0.5, 0.6] },
      labelAt: w(LOCAL.replicationQueue[0], 22, LOCAL.replicationQueue[2]),
      color: COLOR.replication,
      readout: (s) => {
        const rep = s.nodes[n].replication
        if (rep.readOnly) return 'READ-ONLY — no Keeper session'
        if (rep.queueSize === 0) return 'queue empty · in sync'
        return `${rep.queueSize} queued · delay ${rep.absoluteDelay.toFixed(1)} s`
      },
    })

    ctx.register({
      id: `node.${n}.mutations`,
      name: 'system.mutations',
      role: 'ALTER UPDATE / DELETE — it rewrites whole parts',
      kind: 'process',
      district: 'nodes',
      object: P.mutations,
      tier: 2,
      focus: { target: w(LOCAL.mutationShed[0], 6, LOCAL.mutationShed[2]), distance: 60, dir: [0.4, 0.5, 0.8] },
      labelAt: w(LOCAL.mutationShed[0], 18, LOCAL.mutationShed[2]),
      color: COLOR.mutation,
      readout: (s) => {
        const muts = s.nodes[n].mutations
        const running = muts.find((m) => m.state === 'running')
        if (!running) return 'no mutation in flight'
        return `${running.id} · ${running.partsDone}/${running.partsToDo} parts`
      },
    })
  }

  /* ======================================================================
   * Update.
   * ====================================================================*/

  let prevT = -1
  /** Which slots a merge is holding this frame, so the beams can find them. */
  const beamTargetX = new Float32Array(N_MERGE_SLOTS)
  const beamTargetZ = new Float32Array(N_MERGE_SLOTS)

  function update(dt: number, sim: SimState, t: number): void {
    if (prevT < 0) prevT = t
    const dts = clamp(t - prevT, 0, 0.25) // simulated seconds: freezes on pause
    prevT = t

    for (const isl of islands) {
      const n = isl.node
      const nd = sim.nodes[n]
      const down = nd.status === 'down'

      /* ---- the parts yard --------------------------------------------- */
      updateYard(isl, sim, dt)

      /* ---- the primary index ------------------------------------------ */
      // The beam lights while any query on this node is in its planning phase,
      // which in the model is its first fifth.
      let probing = 0
      for (const q of nd.queries) {
        const p = q.duration > 0 ? q.elapsed / q.duration : 1
        if (p < 0.2) probing = Math.max(probing, 1 - p / 0.2)
      }
      isl.indexGlow = damp(isl.indexGlow, probing, 8, dt)
      const ib = isl.indexBeam.material as THREE.MeshBasicMaterial
      _c.setHex(COLOR.primaryIndex).multiplyScalar(isl.indexGlow * 2.2)
      ib.color.copy(_c)
      // The beam's height is where the binary search landed in the key space.
      const landed = nd.queries.length > 0 ? clamp01(nd.queries[0].granulesAfterKey / Math.max(1, nd.queries[0].granulesTotal)) : 0.5
      isl.indexBeam.scale.y = 0.12 + landed * 0.9
      isl.indexBeam.position.y = (30 * 0.9 * isl.indexBeam.scale.y) / 2 + 1

      /* ---- skip index sheds ------------------------------------------- */
      let skipSlot = 0
      for (let tb = 0; tb < N_TABLES; tb++) {
        const used = nd.queries.some((q) => q.table === tb && q.granulesAfterSkip < q.granulesAfterKey)
        for (let k = 0; k < 3; k++) {
          const i = skipSlot++
          if (k >= TABLES[tb].skipIndexes.length) continue
          const want = used ? 1 : 0.18
          isl.skipGlow[i] = damp(isl.skipGlow[i], want, 5, dt)
          _c.setHex(COLOR.skipIndex).multiplyScalar(0.25 + isl.skipGlow[i] * 1.5)
          isl.skipMesh.setColorAt(i, _c)
        }
      }
      isl.skipMesh.instanceColor!.needsUpdate = true

      /* ---- caches ----------------------------------------------------- */
      updateTank(isl.markFill, isl.markLamp, nd.markCache, COLOR.markCache, dt)
      updateTank(isl.blockFill, isl.blockLamp, nd.uncompressedCache, COLOR.blockCache, dt)

      /* ---- the read pool ---------------------------------------------- */
      let busy = 0
      for (let i = 0; i < N_READ_THREADS; i++) {
        const r = nd.readers[i]
        const active = r.state !== 'idle'
        if (active) busy++
        isl.readerLevel[i] = damp(isl.readerLevel[i], active ? 1 : 0, 9, dt)
        // The colour IS the phase: seeking is the mark cache's colour, reading is
        // the reader's own, decompressing is the block cache's. So the bay tells
        // you which cache is deciding this thread's fate.
        let hex = COLOR.reader
        let gain = 0.2
        switch (r.state) {
          case 'seeking':
            hex = COLOR.markCache
            gain = 1.5
            break
          case 'reading':
            hex = COLOR.reader
            gain = 1.6
            break
          case 'decompressing':
            hex = COLOR.blockCache
            gain = 1.5
            break
          case 'filtering':
            hex = COLOR.skipIndex
            gain = 1.2
            break
          case 'aggregating':
            hex = COLOR.ok
            gain = 1.3
            break
          default:
            hex = COLOR.reader
            gain = 0.16
        }
        _c.setHex(hex).multiplyScalar(gain * (0.25 + 0.75 * isl.readerLevel[i]))
        isl.readerMesh.setColorAt(i, _c)

        // The bar is the mark range's progress, so a thread with a big range
        // visibly takes longer than one with a small range.
        const b = readerBayLocal(i)
        const h = 0.4 + r.progress * 5.6
        setBox(isl.readerBarMesh, i, b[0] - 3.6, 5.6 + h / 2 - 0.7, b[2], 0.7, h, 4.4)
        _c.setHex(COLOR.ok).multiplyScalar(active ? 1.3 : 0)
        isl.readerBarMesh.setColorAt(i, _c)
      }
      isl.readerMesh.instanceColor!.needsUpdate = true
      isl.readerBarMesh.instanceMatrix.needsUpdate = true
      isl.readerBarMesh.instanceColor!.needsUpdate = true
      const dl = isl.dispatcherLamp.material as THREE.MeshBasicMaterial
      _c.setHex(COLOR.reader).multiplyScalar(0.2 + clamp01(busy / N_READ_THREADS) * 1.9)
      dl.color.copy(_c)

      /* ---- merges ----------------------------------------------------- */
      for (let i = 0; i < N_MERGE_SLOTS; i++) {
        const m = nd.merges[i]
        isl.mergeLevel[i] = damp(isl.mergeLevel[i], m.active ? 1 : 0, 6, dt)
        const lvl = isl.mergeLevel[i]

        // A TTL merge is not amber. It is the TTL colour, because it is doing a
        // different job: removing data, not consolidating it.
        let hex = COLOR.merge
        if (m.reason === 'ttl_delete') hex = COLOR.ttl
        else if (m.reason === 'ttl_recompress') hex = COLOR.cold
        else if (m.reason === 'mutation') hex = COLOR.mutation
        else if (m.reason === 'final') hex = COLOR.ok
        _c.setHex(hex).multiplyScalar(0.14 + lvl * 1.7)
        isl.mergeMesh.setColorAt(i, _c)

        const s = mergeSlotLocal(i)
        const barH = 0.4 + m.progress * 5.2
        setBox(isl.mergeBarMesh, i, s[0] - 7, 15 - 6.4 + barH / 2, s[2], 0.6, barH, 5)
        // The vertical algorithm gets a second, cooler bar segment: the two
        // phases are genuinely different work, and the bar says which one.
        _c.setHex(m.algorithm === 'vertical' ? COLOR.blockCache : COLOR.merge).multiplyScalar(m.active ? 1.5 : 0)
        isl.mergeBarMesh.setColorAt(i, _c)

        /* the beam onto the parts this merge has reserved */
        // Only the inputs that have a slot can be pointed at; a merge whose
        // inputs are all beyond the window still runs, it just has no beam.
        const drawn = m.active ? m.sourceSlots.filter((sl) => sl >= 0) : []
        if (drawn.length > 0) {
          /* Read the positions updateYard just DAMPED rather than recomputing
           * them: the inputs are in the lane and the partition group they are
           * drawn in, and a beam that recomputed the place would drift off them
           * every time the cell squeezed. Same reason engine/flows.ts picks out
           * of the instance matrix. */
          let cx = 0
          let cz = 0
          for (const slot of drawn) {
            const k = m.table * N_PART_SLOTS + slot
            cx += isl.partX[k]
            cz += isl.partZ[k]
          }
          cx /= drawn.length
          cz /= drawn.length
          beamTargetX[i] = cx
          beamTargetZ[i] = cz
          const top = 15 - 4
          const bottom = Y.baseY + 1
          const h = Math.max(1, top - bottom)
          // The beam widens with the number of input parts, so a five-part merge
          // reads as a bigger commitment than a two-part one.
          const w = 1.2 + Math.min(6, drawn.length) * 0.7
          setBox(isl.mergeBeamMesh, i, cx, (top + bottom) / 2, cz, w, h, w)
          _c.setHex(hex).multiplyScalar(0.5 + 0.5 * Math.sin(t * 6 + i))
          isl.mergeBeamMesh.setColorAt(i, _c)
        } else {
          parkBox(isl.mergeBeamMesh, i)
          _c.setRGB(0, 0, 0)
          isl.mergeBeamMesh.setColorAt(i, _c)
        }
      }
      isl.mergeMesh.instanceColor!.needsUpdate = true
      isl.mergeBarMesh.instanceMatrix.needsUpdate = true
      isl.mergeBarMesh.instanceColor!.needsUpdate = true
      isl.mergeBeamMesh.instanceMatrix.needsUpdate = true
      isl.mergeBeamMesh.instanceColor!.needsUpdate = true

      /* ---- TTL -------------------------------------------------------- */
      let ttlRunning = 0
      for (const m of nd.merges) {
        if (m.active && (m.reason === 'ttl_delete' || m.reason === 'ttl_recompress')) ttlRunning = 1
      }
      let expired = 0
      for (const tb of nd.tables) expired += tb.expiredParts
      const ttlWant = ttlRunning > 0 ? 1 : clamp01(expired / 6) * 0.4
      isl.ttlGlow = damp(isl.ttlGlow, ttlWant, 4, dt)
      const fm = isl.ttlFurnace.material as THREE.MeshBasicMaterial
      _c.setHex(COLOR.ttl).multiplyScalar(0.12 + isl.ttlGlow * 1.9)
      fm.color.copy(_c)
      const flm = isl.ttlFlare.material as THREE.MeshBasicMaterial
      _c.setHex(COLOR.ttl).multiplyScalar(isl.ttlGlow * 1.4 * (0.7 + 0.3 * Math.sin(t * 9)))
      flm.color.copy(_c)
      isl.ttlFlare.scale.set(1, 0.3 + isl.ttlGlow * 1.4, 1)

      /* ---- volumes ---------------------------------------------------- */
      for (let v = 0; v < isl.volFill.length; v++) {
        const vol = nd.volumes[v]
        const frac = clamp01(vol.usedBytes / Math.max(1, vol.totalBytes))
        // A fill bar rather than a level, because a cold volume in object storage
        // has no meaningful "full": what matters is how much is out there.
        const w = 2 + Math.pow(frac, 0.35) * (CITY.storage.w - 12)
        isl.volFill[v].scale.set(w, 1, 1)
        isl.volFill[v].position.x = LOCAL.hotVolume[0] - (CITY.storage.w - 12) / 2 + w / 2
        const mat = isl.volFill[v].material as THREE.MeshBasicMaterial
        _c.setHex(v === 0 ? COLOR.hot : COLOR.cold).multiplyScalar(1 + vol.load * 0.8)
        mat.color.copy(_c)
      }

      /* ---- the replication queue -------------------------------------- */
      for (let i = 0; i < N_QUEUE_SLOTS; i++) {
        const e = nd.replication.queue[i]
        const filled = e.partName !== ''
        isl.queueLevel[i] = damp(isl.queueLevel[i], filled ? 1 : 0, 8, dt)
        // GET_PART means a part has to cross the wire; MERGE_PARTS means this
        // replica has to do the merge itself. Two different colours because they
        // are two entirely different costs.
        let hex = COLOR.replication
        if (e.type === 'GET_PART') hex = COLOR.fetch
        else if (e.type === 'MERGE_PARTS') hex = COLOR.merge
        else if (e.type === 'MUTATE_PART') hex = COLOR.mutation
        const pulse = e.executing ? 0.6 + 0.4 * Math.sin(t * 10 + i) : 1
        const stuck = e.tries > 4 ? 0.4 + 0.6 * Math.sin(t * 3) : 1
        _c.setHex(e.tries > 4 ? COLOR.crit : hex).multiplyScalar(isl.queueLevel[i] * 1.7 * pulse * stuck)
        isl.queueMesh.setColorAt(i, _c)
      }
      isl.queueMesh.instanceColor!.needsUpdate = true

      const km = isl.keeperLamp.material as THREE.MeshBasicMaterial
      const connected = nd.replication.connected
      _c.setHex(connected ? COLOR.keeper : COLOR.crit).multiplyScalar(
        connected ? 0.6 + 0.4 * Math.sin(t * 2.2 + n) : 0.5 + 0.5 * Math.sin(t * 7),
      )
      km.color.copy(_c)

      /* ---- status and cpu --------------------------------------------- */
      const sm = isl.statusLamp.material as THREE.MeshBasicMaterial
      let statusHex = COLOR.ok
      let statusGain = 1.1
      if (down) {
        statusHex = COLOR.crit
        statusGain = 0.4 + 0.6 * Math.sin(t * 6)
      } else if (nd.replication.readOnly) {
        statusHex = COLOR.warn
        statusGain = 0.7 + 0.3 * Math.sin(t * 3)
      } else if (nd.status === 'starting') {
        statusHex = COLOR.partPreactive
        statusGain = 0.5 + 0.5 * Math.sin(t * 8)
      }
      _c.setHex(statusHex).multiplyScalar(statusGain * 1.6)
      sm.color.copy(_c)

      const cpuH = 0.6 + nd.cpu * 24
      isl.cpuBar.scale.set(1, cpuH, 1)
      isl.cpuBar.position.y = cpuH / 2
      const cm = isl.cpuBar.material as THREE.MeshBasicMaterial
      _c.setHex(nd.cpu > 0.85 ? COLOR.crit : nd.cpu > 0.6 ? COLOR.warn : COLOR.reader).multiplyScalar(1.3)
      cm.color.copy(_c)

      /* ---- a dead node goes dark -------------------------------------- */
      if (down) isl.group.traverse(dimDown)

      void dts
    }
  }

  /** A down node keeps its geometry but loses every light. */
  function dimDown(obj: THREE.Object3D): void {
    const mesh = obj as THREE.InstancedMesh
    if (mesh.isInstancedMesh !== true || !mesh.instanceColor) return
    if (mesh.name === 'yard.cells') return
    const arr = mesh.instanceColor.array as Float32Array
    for (let i = 0; i < arr.length; i++) arr[i] *= 0.12
    mesh.instanceColor.needsUpdate = true
  }

  /**
   * How many parts share each (partition, level) cell of the table being drawn,
   * and how many of them have been placed so far. Module scratch, refilled per
   * table: update() must not allocate.
   */
  const cellCount = new Int32Array(MAX_PARTITIONS * N_LEVEL_LANES)
  const cellSeen = new Int32Array(MAX_PARTITIONS * N_LEVEL_LANES)

  /** Which cell a part belongs in — its partition, and its merge level's lane. */
  function cellKey(p: PartSim): number {
    return p.partition * N_LEVEL_LANES + partLevelLane(p.level)
  }

  function updateYard(isl: Island, sim: SimState, dt: number): void {
    const nd = sim.nodes[isl.node]
    const mesh = isl.partMesh
    const caps = isl.partCapMesh
    // Nothing is drawn for a slot that holds no part, so start by marking every
    // slot empty and then fill in the ones that are occupied. A part that has
    // been removed must not leave its tower standing.
    occupied.fill(0)

    for (let tb = 0; tb < N_TABLES; tb++) {
      const nt = nd.tables[tb]
      /* Two passes over one table's parts, because a part's spacing depends on
       * how crowded its cell is and that is not known until all of them are
       * counted. The rank handed to drawPart is the part's index in
       * `nt.parts`, which is creation order — and within one partition at one
       * level that is block order, so a cell reads left to right in the order
       * its rows arrived. */
      cellCount.fill(0)
      cellSeen.fill(0)
      for (const p of nt.parts) {
        // slot -1 means the part is beyond the yard's window: fully simulated,
        // counted in every total, and simply not drawn. See PartSim.slot.
        if (p.slot < 0) continue
        cellCount[cellKey(p)]++
      }
      for (const p of nt.parts) {
        if (p.slot < 0) continue
        const k = cellKey(p)
        const i = tb * N_PART_SLOTS + p.slot
        occupied[i] = 1
        drawPart(isl, i, tb, p, cellSeen[k]++, cellCount[k], dt)
      }
    }

    for (let i = 0; i < occupied.length; i++) {
      if (occupied[i]) continue
      if (isl.partRise[i] <= 0.001) continue
      // Sink rather than vanish: a part directory being removed is a real event
      // and deserves the fraction of a second it takes to read. It sinks where
      // it stood, so the gap it leaves is the gap its neighbours close.
      isl.partRise[i] = damp(isl.partRise[i], 0, 9, dt)
      const h = Math.max(0.02, isl.partRise[i])
      const w = Math.max(0.05, isl.partW[i])
      setBox(mesh, i, isl.partX[i], Y.baseY + h / 2, isl.partZ[i], w, h, w)
      const o = i * 3
      isl.partRgb[o] = damp(isl.partRgb[o], 0, 6, dt)
      isl.partRgb[o + 1] = damp(isl.partRgb[o + 1], 0, 6, dt)
      isl.partRgb[o + 2] = damp(isl.partRgb[o + 2], 0, 6, dt)
      _c.setRGB(isl.partRgb[o], isl.partRgb[o + 1], isl.partRgb[o + 2])
      mesh.setColorAt(i, _c)
      parkBox(caps, i)
      if (isl.partRise[i] < 0.02) {
        isl.partRise[i] = 0
        parkBox(mesh, i)
      }
    }

    mesh.instanceMatrix.needsUpdate = true
    mesh.instanceColor!.needsUpdate = true
    caps.instanceMatrix.needsUpdate = true
    caps.instanceColor!.needsUpdate = true
  }

  const occupied = new Uint8Array(N_TABLES * N_PART_SLOTS)

  function drawPart(
    isl: Island,
    i: number,
    table: number,
    p: PartSim,
    index: number,
    count: number,
    dt: number,
  ): void {
    const lane = partLevelLane(p.level)
    const place = partPlaceLocal(table, p.partition, lane, index, count)
    const target = partHeight(p.rows)
    const fresh = isl.partRise[i] <= 0.001
    // Rise into place rather than appear: a part becoming visible is the moment
    // a commit takes effect, and it is worth seeing happen.
    isl.partRise[i] = damp(isl.partRise[i], target, p.state === 'temporary' ? 5 : 9, dt)
    const h = Math.max(0.05, isl.partRise[i])

    /* FOOTPRINT IS THE MERGE LEVEL, and it is the second half of the lane's
     * lesson: a level-4 part is one wide block where a level-0 part is a
     * kerbstone, so a merge is visibly several small things becoming one big
     * one rather than merely a tower changing lane. Height is still rows — the
     * two agree, because a deeper part really does hold more rows, and seeing
     * them agree is what makes the level believable.
     *
     * Capped by the cell's own spacing so a crowded cell squeezes its towers
     * thinner instead of letting them overlap: overlapping towers would make a
     * part count unreadable exactly when it matters most. */
    const pitch = partCellPitch(count)
    let wTarget = Math.min(pitch * 0.86, Y.pitchX * (0.34 + 0.15 * lane))
    // A part on the cold volume is drawn narrower: it is the same data, in a
    // place with less bandwidth.
    if (p.volume === 1) wTarget *= 0.72
    const d = Math.min(Y.pitchZ * 0.7, Y.pitchZ * (0.34 + 0.1 * lane)) * (p.volume === 1 ? 0.8 : 1)

    // A tower that has just been created snaps to its place; one that is already
    // standing slides, because it moving means its neighbours changed.
    if (fresh) {
      isl.partX[i] = place[0]
      isl.partZ[i] = place[2]
      isl.partW[i] = wTarget
    } else {
      isl.partX[i] = damp(isl.partX[i], place[0], 7, dt)
      isl.partZ[i] = damp(isl.partZ[i], place[2], 7, dt)
      isl.partW[i] = damp(isl.partW[i], wTarget, 7, dt)
    }
    const x = isl.partX[i]
    const z = isl.partZ[i]
    const w = Math.max(0.05, isl.partW[i])
    setBox(isl.partMesh, i, x, Y.baseY + h / 2, z, w, h, d)

    // Colour is state, and only state. Activity is a PULSE applied below.
    let hex = partColor(p.state)
    const gain = partGain(p.state)
    if (p.state === 'active' && p.ttlMax < Infinity) {
      // A part whose rows have started expiring shifts toward the TTL colour in
      // proportion to how much of it is dead. This is the only place in the
      // cluster where a part's colour is not purely its state, and it is worth
      // it: "which parts is the TTL about to rewrite" is otherwise invisible.
      const span = Math.max(1e-6, p.ttlMax - p.ttlMin)
      const dead = clamp01((isl.node >= 0 ? currentT : 0) - p.ttlMin) / span
      if (dead > 0.01) {
        _c.setHex(hex)
        _c2.setHex(COLOR.partExpired)
        _c.lerp(_c2, clamp01(dead))
        hex = _c.getHex()
      }
    }
    _c.setHex(hex).multiplyScalar(gain)
    if (p.fetched) {
      // A part that arrived by fetch rather than by INSERT gets a trace of the
      // fetch colour, so "where did this part come from" is answerable.
      _c2.setHex(COLOR.fetch)
      _c.lerp(_c2, 0.22)
    }
    const o = i * 3
    isl.partRgb[o] = damp(isl.partRgb[o], _c.r, 7, dt)
    isl.partRgb[o + 1] = damp(isl.partRgb[o + 1], _c.g, 7, dt)
    isl.partRgb[o + 2] = damp(isl.partRgb[o + 2], _c.b, 7, dt)
    _c.setRGB(isl.partRgb[o], isl.partRgb[o + 1], isl.partRgb[o + 2])

    /* THE PULSE — red while written, green while read.
     *
     * Applied AFTER the damp, deliberately: damping a blink is how you get a
     * dull constant glow instead of a blink, and the whole point is that it is
     * legible as an event. The state colour underneath is what is damped, so a
     * part still transitions smoothly from `active` to `outdated` while blinking.
     *
     * Write wins ties. A part is written exactly once, at the start of its life,
     * and if a query happens to select it in that same second the interesting
     * fact is still that it has just been created. */
    const wr = p.writeHeat
    const rd = p.heat
    if (wr > 0.02 || rd > 0.02) {
      const writing = wr >= rd
      // Pushed past the bloom threshold, like every other lit thing: a pulse
      // that only reaches the matte range would be invisible at night.
      _c2.setHex(writing ? COLOR.flowWrite : COLOR.flowRead).multiplyScalar(2.1)
      // Phase-offset by the instance so a whole cell does not blink in unison —
      // in unison it reads as one object flashing, not as several parts.
      const beat = 0.5 + 0.5 * Math.sin(currentT * 9 + i * 0.7)
      _c.lerp(_c2, clamp01((writing ? wr : rd) * (0.2 + 0.8 * beat)) * 0.9)
    }
    isl.partMesh.setColorAt(i, _c)

    // The cap carries the mutation version — the one thing about a part that
    // neither its height, its footprint nor its lane can say. The merge level
    // used to be here and no longer needs to be: it IS the lane now.
    if (p.mutation > 0) {
      setBox(isl.partCapMesh, i, x, Y.baseY + h + 0.18, z, w * 0.9, 0.3, d * 0.9)
      _c.setHex(COLOR.mutation).multiplyScalar(1.5)
      isl.partCapMesh.setColorAt(i, _c)
    } else {
      parkBox(isl.partCapMesh, i)
    }
  }

  /** Simulated time, so drawPart can pulse and interpolate without a parameter. */
  let currentT = 0

  function updateTank(
    fill: THREE.Mesh,
    lamp: THREE.Mesh,
    cache: { capacityBytes: number; usedBytes: number; hitRatio: number },
    hex: number,
    dt: number,
  ): void {
    const TANK_H = 11
    const frac = cache.capacityBytes > 0 ? clamp01(cache.usedBytes / cache.capacityBytes) : 0
    const h = Math.max(0.05, frac * (TANK_H - 1))
    fill.scale.set(1, h, 1)
    fill.position.y = LOCAL.cacheDeck[1] + h / 2 + 0.4
    const fm = fill.material as THREE.MeshBasicMaterial
    _c.setHex(hex).multiplyScalar(cache.capacityBytes > 0 ? 0.7 + frac * 0.9 : 0.05)
    fm.color.lerp(_c, 1 - Math.exp(-6 * dt))

    // The lamp is the hit ratio, and it goes red rather than dim when the cache
    // is missing: a cache that is full and missing is the failure being taught.
    const lm = lamp.material as THREE.MeshBasicMaterial
    if (cache.capacityBytes <= 0) {
      _c.setHex(COLOR.inkDim).multiplyScalar(0.1)
    } else if (cache.hitRatio < 0.5) {
      _c.setHex(COLOR.crit).multiplyScalar(0.8 + (0.5 - cache.hitRatio) * 2)
    } else {
      _c.setHex(hex).multiplyScalar(0.4 + cache.hitRatio * 1.6)
    }
    lm.color.lerp(_c, 1 - Math.exp(-6 * dt))
  }

  /* --- LOD -------------------------------------------------------------- */

  function setDetail(level: 0 | 1 | 2): void {
    for (const isl of islands) {
      isl.partCellMesh.visible = level >= 1
      isl.partCapMesh.visible = level >= 1
      isl.indexTicks.visible = level >= 1
      isl.readerBarMesh.visible = level >= 1
      isl.mergeBarMesh.visible = level >= 1
    }
  }

  function dispose(): void {
    for (const o of owned) o.dispose()
    owned.length = 0
    for (const isl of islands) {
      isl.partMesh.dispose()
      isl.partCapMesh.dispose()
      isl.partCellMesh.dispose()
      isl.skipMesh.dispose()
      isl.readerMesh.dispose()
      isl.readerBarMesh.dispose()
      isl.mergeMesh.dispose()
      isl.mergeBarMesh.dispose()
      isl.mergeBeamMesh.dispose()
      isl.queueMesh.dispose()
    }
  }

  return {
    id: 'nodes',
    group,
    update(dt, sim, t) {
      currentT = t
      update(dt, sim, t)
    },
    setDetail,
    dispose,
  }
}
