import * as THREE from 'three'
import { COLOR } from '../core/theme'
import { N_NODES } from '../core/types'
import type { SimState, WorldFactory, WorldModule } from '../core/types'
import { CITY, DISTRICT_BOUNDS, nodeOrigin } from './layout'

/* ============================================================================
 * THE GROUND
 *
 * One plate, a survey grid on it, and a rectangular hole under each of the four
 * data islands so the storage volumes below are visible from the surface.
 *
 * The holes are the reason this is a ShapeGeometry rather than a PlaneGeometry:
 * a `MergeTree` part lives on a disk, and drawing the disks under the ground
 * rather than beside it is what makes "on disk" mean something. Nothing that
 * lives at y ≈ 0 may be placed inside a hole.
 *
 * The grid is a shader on the plate, not geometry: two line families at 10 m and
 * 50 m, drawn with a screen-space derivative so the line stays about a pixel
 * wide at every distance instead of aliasing into moiré.
 * ==========================================================================*/

const GROUND_VERT = /* glsl */ `
varying vec3 vWorld;
void main() {
  vec4 world = modelMatrix * vec4( position, 1.0 );
  vWorld = world.xyz;
  gl_Position = projectionMatrix * viewMatrix * world;
}`

const GROUND_FRAG = /* glsl */ `
uniform vec3 uGround;
uniform vec3 uGrid;
uniform vec3 uGridBright;
uniform float uFogNear;
uniform float uFogFar;
uniform vec3 uFogColor;
varying vec3 vWorld;

/* One line family at the given spacing, one pixel wide at any distance. fwidth() of the
 * grid coordinate IS the screen-space density, so dividing by it keeps the line
 * constant-weight and kills the moiré a fixed-width line produces at grazing
 * angles. */
float gridLine( vec2 p, float spacing, float weight ) {
  vec2 g = p / spacing;
  vec2 d = abs( fract( g - 0.5 ) - 0.5 ) / max( fwidth( g ), vec2( 1e-6 ) );
  return 1.0 - min( min( d.x, d.y ) / weight, 1.0 );
}

void main() {
  vec2 p = vWorld.xz;
  float fine = gridLine( p, 10.0, 1.0 );
  float block = gridLine( p, 50.0, 1.4 );

  vec3 col = uGround;
  col = mix( col, uGrid, fine * 0.55 );
  col = mix( col, uGridBright, block * 0.7 );

  // The plate runs to 2.2 km, well past the fog far plane, so it has to fade
  // itself out or the horizon is a hard edge against the sky.
  float dist = length( vWorld - cameraPosition );
  float fog = clamp( ( dist - uFogNear ) / max( 1.0, uFogFar - uFogNear ), 0.0, 1.0 );
  col = mix( col, uFogColor, fog * fog );

  gl_FragColor = vec4( col, 1.0 );
  #include <colorspace_fragment>
}`

interface GroundUniforms {
  uGround: { value: THREE.Color }
  uGrid: { value: THREE.Color }
  uGridBright: { value: THREE.Color }
  uFogNear: { value: number }
  uFogFar: { value: number }
  uFogColor: { value: THREE.Color }
}

export const createGround: WorldFactory = (ctx): WorldModule => {
  const { theme } = ctx
  const group = new THREE.Group()
  group.name = 'district:ground'

  const owned: { dispose(): void }[] = []
  function own<T extends { dispose(): void }>(x: T): T {
    owned.push(x)
    return x
  }

  /* --- the plate, with a hole under each island -------------------------- */

  const half = CITY.ground / 2
  const plate = new THREE.Shape()
  plate.moveTo(-half, -half)
  plate.lineTo(half, -half)
  plate.lineTo(half, half)
  plate.lineTo(-half, half)
  plate.closePath()

  const pitHalfW = CITY.pit.w / 2
  const pitHalfD = CITY.pit.d / 2
  for (let n = 0; n < N_NODES; n++) {
    const o = nodeOrigin(n)
    const hole = new THREE.Path()
    // Shape space is (x, y) and the plate is laid in the XZ plane, so the
    // shape's y IS world z. Winding is reversed for a hole.
    hole.moveTo(o[0] - pitHalfW, o[2] - pitHalfD)
    hole.lineTo(o[0] - pitHalfW, o[2] + pitHalfD)
    hole.lineTo(o[0] + pitHalfW, o[2] + pitHalfD)
    hole.lineTo(o[0] + pitHalfW, o[2] - pitHalfD)
    hole.closePath()
    plate.holes.push(hole)
  }

  const plateGeo = own(new THREE.ShapeGeometry(plate))
  // ShapeGeometry builds in the XY plane; lay it flat.
  plateGeo.rotateX(-Math.PI / 2)

  const uniforms: GroundUniforms = {
    uGround: { value: new THREE.Color(COLOR.ground) },
    uGrid: { value: new THREE.Color(COLOR.grid) },
    uGridBright: { value: new THREE.Color(COLOR.gridBright) },
    uFogNear: { value: CITY.fog.near },
    uFogFar: { value: CITY.fog.far },
    uFogColor: { value: new THREE.Color(COLOR.fog) },
  }
  const plateMat = own(
    new THREE.ShaderMaterial({
      uniforms: uniforms as unknown as Record<string, THREE.IUniform>,
      vertexShader: GROUND_VERT,
      fragmentShader: GROUND_FRAG,
      side: THREE.FrontSide,
    }),
  )
  plateMat.name = 'ground.plate'
  const plateMesh = new THREE.Mesh(plateGeo, plateMat)
  plateMesh.name = 'ground.plate'
  plateMesh.receiveShadow = false
  plateMesh.userData.chNoShadow = true
  // The plate is 2.2 km across and always under the camera; culling it costs
  // more than drawing it.
  plateMesh.frustumCulled = false
  group.add(plateMesh)

  /**
   * A shadow-only plane just above the plate. The grid shader cannot receive a
   * shadow (it is not a lit material), so the drawn shadows land here instead —
   * which is why they exist at all in day mode.
   */
  const shadowGeo = own(new THREE.PlaneGeometry(CITY.ground, CITY.ground))
  shadowGeo.rotateX(-Math.PI / 2)
  const shadowMat = own(new THREE.ShadowMaterial({ opacity: 0.3 }))
  shadowMat.name = 'ground.shadow'
  const shadowPlane = new THREE.Mesh(shadowGeo, shadowMat)
  shadowPlane.name = 'ground.shadow'
  shadowPlane.position.y = 0.02
  shadowPlane.receiveShadow = true
  shadowPlane.userData.chShadowReceiver = true
  shadowPlane.frustumCulled = false
  shadowPlane.raycast = () => {}
  group.add(shadowPlane)

  /* --- the pit walls ----------------------------------------------------- */

  // Four inward-facing walls per hole, so the excavation reads as a cut rather
  // than a void. Matte, and darker than the plate: this is earth, not a surface.
  const wallMat = theme.mat('ground.pitwall', {
    color: 0x121a28,
    roughness: 0.94,
    metalness: 0.04,
    emissive: 0x05080e,
    side: THREE.DoubleSide,
  })
  const depth = CITY.pit.wallDepth
  const wallGeoX = own(new THREE.PlaneGeometry(CITY.pit.w, depth))
  const wallGeoZ = own(new THREE.PlaneGeometry(CITY.pit.d, depth))
  const rimVerts: number[] = []

  for (let n = 0; n < N_NODES; n++) {
    const o = nodeOrigin(n)
    const y = -depth / 2

    const north = new THREE.Mesh(wallGeoX, wallMat)
    north.position.set(o[0], y, o[2] - pitHalfD)
    group.add(north)

    const south = new THREE.Mesh(wallGeoX, wallMat)
    south.position.set(o[0], y, o[2] + pitHalfD)
    south.rotation.y = Math.PI
    group.add(south)

    const west = new THREE.Mesh(wallGeoZ, wallMat)
    west.position.set(o[0] - pitHalfW, y, o[2])
    west.rotation.y = Math.PI / 2
    group.add(west)

    const east = new THREE.Mesh(wallGeoZ, wallMat)
    east.position.set(o[0] + pitHalfW, y, o[2])
    east.rotation.y = -Math.PI / 2
    group.add(east)

    // The rim line: a lit kerb around the cut, which is what makes the hole
    // read as deliberate rather than as a missing polygon.
    const x0 = o[0] - pitHalfW
    const x1 = o[0] + pitHalfW
    const z0 = o[2] - pitHalfD
    const z1 = o[2] + pitHalfD
    const ry = 0.14
    rimVerts.push(x0, ry, z0, x1, ry, z0)
    rimVerts.push(x1, ry, z0, x1, ry, z1)
    rimVerts.push(x1, ry, z1, x0, ry, z1)
    rimVerts.push(x0, ry, z1, x0, ry, z0)
  }

  const rimGeo = own(new THREE.BufferGeometry())
  rimGeo.setAttribute('position', new THREE.Float32BufferAttribute(rimVerts, 3))
  const rim = new THREE.LineSegments(rimGeo, theme.line(COLOR.node, 0.4))
  rim.name = 'ground.rim'
  rim.renderOrder = 2
  rim.raycast = () => {}
  group.add(rim)

  /* --- district boundary lines ------------------------------------------ */

  // A faint painted footprint per district, so the geography reads from the air.
  // These are the same numbers the plan exports, so they cannot drift from it.
  const boundVerts: number[] = []
  for (const key of Object.keys(DISTRICT_BOUNDS)) {
    if (key === 'world') continue
    const b = DISTRICT_BOUNDS[key]
    const y = 0.06
    boundVerts.push(b.x[0], y, b.z[0], b.x[1], y, b.z[0])
    boundVerts.push(b.x[1], y, b.z[0], b.x[1], y, b.z[1])
    boundVerts.push(b.x[1], y, b.z[1], b.x[0], y, b.z[1])
    boundVerts.push(b.x[0], y, b.z[1], b.x[0], y, b.z[0])
  }
  const boundGeo = own(new THREE.BufferGeometry())
  boundGeo.setAttribute('position', new THREE.Float32BufferAttribute(boundVerts, 3))
  const bounds = new THREE.LineSegments(boundGeo, theme.line(COLOR.inkDim, 0.12))
  bounds.name = 'ground.bounds'
  bounds.renderOrder = 1
  bounds.raycast = () => {}
  group.add(bounds)

  /* --- registration ------------------------------------------------------ */

  ctx.register({
    id: 'cluster',
    name: 'CHSimCity',
    role: 'a two-shard, two-replica ClickHouse cluster',
    kind: 'concept',
    district: 'world',
    object: plateMesh,
    tier: 0,
    focus: { target: [0, 0, -20], distance: 760, dir: [0.55, 0.5, 0.9] },
    labelAt: [0, 40, -20],
    color: COLOR.node,
    readout: (s: SimState) =>
      `${s.stats.activeParts} parts · ${s.stats.runningMerges} merges · ${(s.stats.compressionRatio).toFixed(1)}× compression`,
  })

  /* --- update ------------------------------------------------------------ */

  function update(): void {
    // The plate's colours follow the palette, and the palette is mutated in
    // place on a theme change — so they are read here rather than snapshotted.
    uniforms.uGround.value.setHex(COLOR.ground)
    uniforms.uGrid.value.setHex(COLOR.grid)
    uniforms.uGridBright.value.setHex(COLOR.gridBright)
    uniforms.uFogColor.value.setHex(COLOR.fog)
  }

  function setDetail(level: 0 | 1 | 2): void {
    bounds.visible = level <= 1
    rim.visible = level >= 1
  }

  function dispose(): void {
    for (const o of owned) o.dispose()
    owned.length = 0
  }

  return { id: 'ground', group, update, setDetail, dispose }
}
