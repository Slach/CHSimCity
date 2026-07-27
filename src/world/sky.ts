import * as THREE from 'three'
import { COLOR } from '../core/theme'
import type { Atmosphere } from '../core/themes'
import type { QualityLevel, ThemeApi } from '../core/types'
import { makeRng } from '../core/util'

/* ============================================================================
 * THE SKY
 *
 * An inverted sphere with a three-stop vertical gradient, plus a field of stars
 * that only exists at night. Both are driven by uniforms, so a theme change is a
 * uniform write and never a rebuild — see applySkyAtmosphere.
 *
 * The dome is `depthWrite: false` and rendered first, so nothing in the cluster
 * ever has to fight it for the depth buffer.
 * ==========================================================================*/

const SKY_VERT = /* glsl */ `
varying vec3 vWorld;
void main() {
  vec4 world = modelMatrix * vec4( position, 1.0 );
  vWorld = world.xyz;
  gl_Position = projectionMatrix * viewMatrix * world;
}`

const SKY_FRAG = /* glsl */ `
uniform vec3 uZenith;
uniform vec3 uHorizon;
uniform vec3 uGlow;
uniform float uGlowHeight;
uniform vec3 uGlowDir;
varying vec3 vWorld;

void main() {
  vec3 dir = normalize( vWorld );
  // Height above the horizon, 0..1. The 0.42 exponent spends most of the
  // gradient near the horizon, which is where a sky actually varies.
  float h = clamp( dir.y * 0.5 + 0.5, 0.0, 1.0 );
  vec3 col = mix( uHorizon, uZenith, pow( h, 0.42 ) );

  // A single warm band low on one side: the sun at noon, and the city's own
  // light pollution at night. Directional, so the scene has an orientation even
  // when nothing else on screen does.
  float side = max( 0.0, dot( normalize( vec3( dir.x, 0.0, dir.z ) ), uGlowDir ) );
  float low = 1.0 - smoothstep( 0.0, uGlowHeight, max( 0.0, dir.y ) );
  col += uGlow * side * side * low;

  gl_FragColor = vec4( col, 1.0 );
  #include <colorspace_fragment>
}`

const STAR_VERT = /* glsl */ `
attribute float aSize;
attribute float aTwinkle;
uniform float uPixelRatio;
uniform float uOpacity;
varying float vAlpha;
void main() {
  vec4 mv = viewMatrix * modelMatrix * vec4( position, 1.0 );
  gl_Position = projectionMatrix * mv;
  gl_PointSize = aSize * uPixelRatio;
  vAlpha = aTwinkle * uOpacity;
}`

const STAR_FRAG = /* glsl */ `
varying float vAlpha;
void main() {
  // A round point with a soft edge, from gl_PointCoord alone — no texture.
  vec2 d = gl_PointCoord - vec2( 0.5 );
  float r = length( d );
  float a = ( 1.0 - smoothstep( 0.32, 0.5, r ) ) * vAlpha;
  if ( a < 0.01 ) discard;
  gl_FragColor = vec4( 1.0, 0.98, 0.94, a );
}`

const STAR_COUNT = 900
/** The dome's radius. Well outside the camera's far plane guard. */
const RADIUS = 2600

interface SkyUniforms {
  uZenith: { value: THREE.Color }
  uHorizon: { value: THREE.Color }
  uGlow: { value: THREE.Color }
  uGlowHeight: { value: number }
  uGlowDir: { value: THREE.Vector3 }
}

/**
 * Build the sky. `theme` is taken so the dome participates in the same cache
 * lifecycle as everything else, even though it owns its own shader.
 */
export function createSky(theme: ThemeApi): THREE.Group {
  void theme
  const group = new THREE.Group()
  group.name = 'sky'
  // Drawn before anything else and never occluding: it is the backdrop.
  group.renderOrder = -1000

  const uniforms: SkyUniforms = {
    uZenith: { value: new THREE.Color(0x030407) },
    uHorizon: { value: new THREE.Color(0x18253c) },
    uGlow: { value: new THREE.Color(0x4a3a16) },
    uGlowHeight: { value: 0.28 },
    // South-east: the sun's azimuth at noon, and the direction the establishing
    // shot looks from, so the warm band sits behind the camera rather than in it.
    uGlowDir: { value: new THREE.Vector3(0.7, 0, 0.72).normalize() },
  }

  const domeGeo = new THREE.SphereGeometry(RADIUS, 32, 20)
  const domeMat = new THREE.ShaderMaterial({
    uniforms: uniforms as unknown as Record<string, THREE.IUniform>,
    vertexShader: SKY_VERT,
    fragmentShader: SKY_FRAG,
    side: THREE.BackSide,
    depthWrite: false,
    fog: false,
  })
  domeMat.name = 'sky.dome'
  const dome = new THREE.Mesh(domeGeo, domeMat)
  dome.name = 'sky.dome'
  dome.frustumCulled = false
  dome.raycast = () => {}
  dome.userData.chNoShadow = true
  group.add(dome)

  /* --- stars ------------------------------------------------------------- */

  const rng = makeRng(0x5741a2)
  const pos = new Float32Array(STAR_COUNT * 3)
  const size = new Float32Array(STAR_COUNT)
  const twinkle = new Float32Array(STAR_COUNT)
  const r = RADIUS * 0.94
  for (let i = 0; i < STAR_COUNT; i++) {
    // Uniform on the upper hemisphere. cos-weighting the polar angle is what
    // stops the classic pole-cluster of naive spherical sampling.
    const u = rng()
    const phi = Math.acos(1 - u * 0.92)
    const theta = rng() * Math.PI * 2
    const sp = Math.sin(phi)
    pos[i * 3] = r * sp * Math.cos(theta)
    pos[i * 3 + 1] = r * Math.cos(phi)
    pos[i * 3 + 2] = r * sp * Math.sin(theta)
    // A few bright ones, most faint: a linear distribution reads as noise.
    const m = rng()
    size[i] = 1.1 + m * m * m * 3.4
    twinkle[i] = 0.28 + rng() * 0.72
  }

  const starGeo = new THREE.BufferGeometry()
  starGeo.setAttribute('position', new THREE.BufferAttribute(pos, 3))
  starGeo.setAttribute('aSize', new THREE.BufferAttribute(size, 1))
  starGeo.setAttribute('aTwinkle', new THREE.BufferAttribute(twinkle, 1))
  const starMat = new THREE.ShaderMaterial({
    uniforms: {
      uPixelRatio: { value: Math.min(2, typeof window === 'undefined' ? 1 : window.devicePixelRatio || 1) },
      uOpacity: { value: 1 },
    },
    vertexShader: STAR_VERT,
    fragmentShader: STAR_FRAG,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    fog: false,
  })
  starMat.name = 'sky.stars'
  const stars = new THREE.Points(starGeo, starMat)
  stars.name = 'sky.stars'
  stars.frustumCulled = false
  stars.raycast = () => {}
  stars.userData.chNoShadow = true
  group.add(stars)

  return group
}

/**
 * Push one atmosphere onto an existing sky. Called by the renderer on every
 * theme change and every quality change — nothing is rebuilt, so it is cheap
 * enough to call from either.
 *
 * `quality` matters because the star field is a thousand additive points and is
 * the first thing worth dropping on a weak GPU.
 */
export function applySkyAtmosphere(sky: THREE.Object3D, air: Atmosphere, quality: QualityLevel): void {
  const dome = sky.getObjectByName('sky.dome') as THREE.Mesh | undefined
  if (dome) {
    const m = dome.material as THREE.ShaderMaterial
    const u = m.uniforms as unknown as SkyUniforms
    u.uZenith.value.setHex(air.skyZenith)
    u.uHorizon.value.setHex(air.skyHorizon)
    u.uGlow.value.setHex(air.skyGlow)
    // The warm band is a wide low wash at noon and a tight one at night, because
    // light pollution hugs the horizon in a way the sun does not.
    u.uGlowHeight.value = air.stars ? 0.2 : 0.34
  }

  const stars = sky.getObjectByName('sky.stars') as THREE.Points | undefined
  if (stars) {
    stars.visible = air.stars && quality !== 'low'
    const m = stars.material as THREE.ShaderMaterial
    m.uniforms.uOpacity.value = air.stars ? 1 : 0
    m.uniforms.uPixelRatio.value = Math.min(
      2,
      typeof window === 'undefined' ? 1 : window.devicePixelRatio || 1,
    )
  }
}

/** Current sky colours, for anything that wants to match the backdrop. */
export function skyColors(): { zenith: number; horizon: number } {
  return { zenith: COLOR.bg, horizon: COLOR.fog }
}
