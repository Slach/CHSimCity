import type { ColorKey } from './types'

/* ============================================================================
 * CHSimCity — the two palettes, and the arithmetic between them.
 *
 * The cluster ships two rendering models, not one palette with the lights
 * turned up. They differ in what carries meaning:
 *
 *   NIGHT   Structure is matte and nearly black; meaning is neon and is the
 *           only thing that clears the bloom threshold.
 *
 *   DAY     Structure is light warm stone; meaning is a flat, deep, poster
 *           fill that needs no glow at all. Bloom is off and the sun casts.
 *
 * That inversion is why the semantic colours are RE-PICKED rather than reused.
 * The MEANINGS are fixed — a merge is amber in both modes, an outdated part is
 * grey in both modes — but a value that glows against black turns into a pale
 * wash against a bright sky.
 *
 * Nothing in this file imports three.js, so it is plain arithmetic on hex
 * integers and can be unit-checked.
 * ==========================================================================*/

export type ThemeMode = 'night' | 'day'

export const THEME_MODES: readonly ThemeMode[] = ['night', 'day']

/**
 * Day is the default. Most people meet this cluster for the first time on
 * unknown hardware, and a sunlit model reads as a place immediately, where the
 * night render asks the viewer to work out what they are looking at first.
 */
export const DEFAULT_MODE: ThemeMode = 'day'

export const THEME_STORAGE_KEY = 'chsimcity.theme'

/* ---------------------------------------------------------------------------
 * NIGHT — the authoring baseline. src/world is written in these values.
 * -------------------------------------------------------------------------*/

export const NIGHT_PALETTE: Record<ColorKey, number> = {
  bg: 0x04060b,
  fog: 0x070a13,
  grid: 0x152238,
  gridBright: 0x27405f,
  ground: 0x080c15,

  client: 0x8ecae6,
  distributed: 0x6ea8ff,
  node: 0x4fd1c5,

  /* --- the parts yard: this is the palette that matters most --------------
   * A part's colour IS its `system.parts.state`, and the four states are
   * deliberately as different from each other as the palette allows, because
   * "how many active parts do I have" is the single most common question a
   * ClickHouse operator asks. */
  partActive: 0x3fd98a, // active — the only state a SELECT can see
  partOutdated: 0x5a6b7d, // outdated — merged away, still referenced
  partPreactive: 0x7fd8ff, // preactive — renamed in, being committed
  partTemporary: 0x9a8cff, // temporary — tmp_insert_…, invisible
  partExpired: 0xff6b8a, // every row past its TTL

  primaryIndex: 0xffd166, // primary.cidx — the sparse index, in RAM
  skipIndex: 0x64ffda, // skp_idx_*.idx2
  markCache: 0xffa94d, // .mrk3 offsets, cached
  blockCache: 0x4fe3c1, // uncompressed blocks, cached
  reader: 0x5ad1ff, // a MergeTreeReadPool thread

  merge: 0xffb03a, // a background merge
  mutation: 0xc77dff, // ALTER UPDATE / DELETE
  ttl: 0xff5d8f, // TTL, deleting or moving
  replication: 0xff9f1c, // the Keeper log and the queue
  fetch: 0xff7a45, // a part crossing the wire between replicas
  keeper: 0xb388ff, // ClickHouse Keeper

  hot: 0x57e389, // the hot volume (SSD)
  cold: 0x4a7fa5, // the cold volume (HDD or S3)

  ok: 0x57e389,
  warn: 0xffcc55,
  crit: 0xff5f6d,
  ink: 0xe8f1ff,
  inkDim: 0x8fa5c4,
}

/* ---------------------------------------------------------------------------
 * DAY — the same cluster at noon.
 *
 * Picked against a #cbc4b1 stone ground and a #bcdcf2 sky, which is the worst
 * case: mid-lightness backgrounds eat mid-lightness colours from both ends. The
 * whole set therefore sits in the 28–58% lightness band with saturation pushed
 * up, so every swatch is darker than the sky and most are darker than the
 * pavement.
 *
 * The crowded arc is the warm one — merge, mutation, TTL, fetch and
 * replication all live between 0° and 45° — and it is separated on lightness
 * rather than hue: merge 38%, replication 46%, fetch 44%, TTL 42%, mutation 40%.
 * -------------------------------------------------------------------------*/

export const DAY_PALETTE: Record<ColorKey, number> = {
  /* --- surfaces: warm stone under a blue sky --- */
  bg: 0xbcdcf2,
  fog: 0xc3d8ea,
  grid: 0xa79f8c,
  gridBright: 0x827a68,
  ground: 0xcbc4b1,

  client: 0x5f96c4,
  distributed: 0x2b5fc4,
  node: 0x0b8f83,

  partActive: 0x14884a,
  partOutdated: 0x8b96a2,
  partPreactive: 0x1673ad,
  partTemporary: 0x4b3fbd,
  partExpired: 0xc42a4c,

  primaryIndex: 0xa87c05,
  skipIndex: 0x05a47e,
  markCache: 0xbc6208,
  blockCache: 0x0e8f8c,
  reader: 0x0089b5,

  merge: 0xb8720a,
  mutation: 0x8b2bc0,
  ttl: 0xc4265f,
  replication: 0xe2690d,
  fetch: 0xc9451f,
  keeper: 0x6a3fd0,

  hot: 0x3f9c22,
  cold: 0x2c5f7d,

  ok: 0x3f9c22,
  warn: 0xd18a04,
  crit: 0xb01030,
  ink: 0x18222e,
  inkDim: 0x5d6b7a,
}

export const PALETTES: Record<ThemeMode, Record<ColorKey, number>> = {
  night: NIGHT_PALETTE,
  day: DAY_PALETTE,
}

/* ---------------------------------------------------------------------------
 * Atmosphere: everything the renderer owns that is not a material.
 * -------------------------------------------------------------------------*/

export interface Atmosphere {
  /** Kept as a string so this file stays three-free. */
  toneMapping: 'aces' | 'neutral'
  exposure: number
  fogNearScale: number
  fogFarScale: number
  hemiSky: number
  hemiGround: number
  hemiIntensity: number
  keyColor: number
  keyIntensity: number
  keyPos: readonly [number, number, number]
  keyTarget: readonly [number, number, number]
  shadowBias: number
  shadowNormalBias: number
  /** 0..1 — how dark a cast shadow goes. A drawn shadow is a tone, not a hole. */
  shadowIntensity: number
  shadows: boolean
  fillColor: number
  fillIntensity: number
  fillPos: readonly [number, number, number]
  /** District mood lamps. Zero at noon — they only make sense in the dark. */
  mergeGlow: number
  keeperGlow: number
  /** Extra light paid back when the bloom pass is unavailable ('low' quality). */
  noBloomHemi: number
  noBloomFill: number
  bloomEnabled: boolean
  bloomStrength: number
  bloomRadius: number
  bloomThreshold: number
  skyZenith: number
  skyHorizon: number
  skyGlow: number
  stars: boolean
}

export const ATMOSPHERE: Record<ThemeMode, Atmosphere> = {
  night: {
    toneMapping: 'aces',
    exposure: 1.06,
    fogNearScale: 1,
    fogFarScale: 1,
    hemiSky: 0x2a4a7a,
    hemiGround: 0x05070c,
    hemiIntensity: 0.6,
    keyColor: 0xa8c8ff,
    keyIntensity: 1.1,
    keyPos: [340, 390, -220],
    keyTarget: [0, 0, 0],
    shadowBias: -0.0006,
    shadowNormalBias: 0.6,
    shadowIntensity: 1,
    shadows: false,
    fillColor: 0x4a6fa5,
    fillIntensity: 0.34,
    fillPos: [-340, 180, 300],
    mergeGlow: 34,
    keeperGlow: 26,
    noBloomHemi: 0.85,
    noBloomFill: 0.48,
    bloomEnabled: true,
    bloomStrength: 0.62,
    bloomRadius: 0.55,
    bloomThreshold: 0.85,
    skyZenith: 0x030407,
    skyHorizon: 0x18253c,
    skyGlow: 0x4a3a16,
    stars: true,
  },
  day: {
    // ACES at a noon exposure crushes saturation into pastel — exactly the
    // "night theme with the lights turned up" failure. Khronos PBR Neutral
    // holds hue and saturation and rolls the top end off instead of clipping.
    toneMapping: 'neutral',
    exposure: 1.0,
    // Daylight sees a long way. The haze has to start well outside the cluster
    // or the far shard reads through a white curtain.
    fogNearScale: 2,
    fogFarScale: 2.2,
    hemiSky: 0xd7ecff,
    hemiGround: 0xd6c49b,
    // The budget is a Lambert one: a sunlit top face only returns its own
    // albedo when key + hemi + fill ≈ PI. Under that and every lit surface
    // reads darker than the ground plate beside it.
    hemiIntensity: 1.35,
    keyColor: 0xfff0c8,
    keyIntensity: 1.9,
    keyPos: [320, 440, 230],
    keyTarget: [0, 0, 0],
    shadowBias: -0.0004,
    shadowNormalBias: 0.45,
    // The parts yards are hundreds of small towers on one deck: at full
    // strength their own shadows turn a yard into a dark field and the part
    // state colours lose the surface they are supposed to sit on.
    shadowIntensity: 0.55,
    shadows: true,
    fillColor: 0xbfd8ff,
    fillIntensity: 0.26,
    fillPos: [-320, 160, -240],
    mergeGlow: 0,
    keeperGlow: 0,
    noBloomHemi: 1.5,
    noBloomFill: 0.3,
    // OFF, and it has to be off rather than merely quiet. Several districts
    // over-drive their per-instance colours past 1.0 so the night bloom will
    // halo them. Leave the pass on at any threshold and those halo at noon too.
    bloomEnabled: false,
    bloomStrength: 0.1,
    bloomRadius: 0.35,
    bloomThreshold: 1.2,
    skyZenith: 0x2f78c8,
    skyHorizon: 0xbcdcf2,
    skyGlow: 0xffdeb0,
    stars: false,
  },
}

/* ---------------------------------------------------------------------------
 * Colour arithmetic.
 * -------------------------------------------------------------------------*/

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v)

/** sRGB hex → [hue 0..360, saturation 0..1, lightness 0..1]. */
export function hslOf(hex: number): [number, number, number] {
  const r = ((hex >> 16) & 255) / 255
  const g = ((hex >> 8) & 255) / 255
  const b = (hex & 255) / 255
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  const l = (max + min) / 2
  const d = max - min
  if (d === 0) return [0, 0, l]
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min)
  let h: number
  if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) * 60
  else if (max === g) h = ((b - r) / d + 2) * 60
  else h = ((r - g) / d + 4) * 60
  return [h, s, l]
}

/** [hue, saturation, lightness] → sRGB hex. */
export function hexOfHsl(h: number, s: number, l: number): number {
  const hh = ((h % 360) + 360) % 360
  const sat = clamp01(s)
  const lig = clamp01(l)
  if (sat === 0) {
    const v = Math.round(lig * 255)
    return (v << 16) | (v << 8) | v
  }
  const q = lig < 0.5 ? lig * (1 + sat) : lig + sat - lig * sat
  const p = 2 * lig - q
  const chan = (t: number): number => {
    let x = t
    if (x < 0) x += 1
    if (x > 1) x -= 1
    if (x < 1 / 6) return p + (q - p) * 6 * x
    if (x < 1 / 2) return q
    if (x < 2 / 3) return p + (q - p) * (2 / 3 - x) * 6
    return p
  }
  const hk = hh / 360
  const r = Math.round(chan(hk + 1 / 3) * 255)
  const g = Math.round(chan(hk) * 255)
  const b = Math.round(chan(hk - 1 / 3) * 255)
  return (r << 16) | (g << 8) | b
}

/** Straight channel mix in sRGB space. */
export function mix(a: number, b: number, t: number): number {
  const ar = (a >> 16) & 255
  const ag = (a >> 8) & 255
  const ab = a & 255
  const br = (b >> 16) & 255
  const bg = (b >> 8) & 255
  const bb = b & 255
  return (
    (Math.round(ar + (br - ar) * t) << 16) |
    (Math.round(ag + (bg - ag) * t) << 8) |
    Math.round(ab + (bb - ab) * t)
  )
}

/* ---------------------------------------------------------------------------
 * NIGHT → DAY translation.
 *
 * The world modules paint with several hundred ad-hoc hex literals that no
 * table could enumerate. So the translation is two-layered:
 *
 *   1. An exact table, built from the two palettes plus the handful of colours
 *      the world derives from them deterministically. Anything semantic lands
 *      here and gets its hand-picked value.
 *   2. A generic transform for everything else, which is almost entirely
 *      structural: near-black navies that have to become light warm stone.
 *
 * Every function here is pure, and the renderer always applies it to the
 * AUTHORED night value — never to whatever is on screen — so switching back and
 * forth is exact and idempotent.
 * -------------------------------------------------------------------------*/

/** Colours that must never be touched: multiplier bases and true black. */
export function isNeutralExtreme(hex: number): boolean {
  return hex === 0xffffff || hex === 0x000000
}

const exact = new Map<number, number>()
for (const key of Object.keys(NIGHT_PALETTE) as ColorKey[]) {
  // Later keys must not clobber earlier ones: `ok` and `hot` are distinct
  // meanings that happen to share a value at night.
  if (!exact.has(NIGHT_PALETTE[key])) exact.set(NIGHT_PALETTE[key], DAY_PALETTE[key])
}

/**
 * Derived night colours, pinned because each covers a large share of the
 * screen and each is a pure function of the night palette.
 */
const DERIVED: readonly (readonly [number, number])[] = [
  [ATMOSPHERE.night.skyZenith, ATMOSPHERE.day.skyZenith],
  [ATMOSPHERE.night.skyHorizon, ATMOSPHERE.day.skyHorizon],
  [ATMOSPHERE.night.skyGlow, ATMOSPHERE.day.skyGlow],
]
for (const [night, day] of DERIVED) if (!exact.has(night)) exact.set(night, day)

/** Exact day value for a known night colour, or -1. */
export function exactDay(hex: number): number {
  const hit = exact.get(hex)
  return hit === undefined ? -1 : hit
}

/**
 * Structure — anything painted with `mat()`.
 *
 * Night structure is a near-black navy whose *lightness* carries the modelling:
 * a pylon is darker than a wall is darker than a rim. Daylight has to keep that
 * ordering while moving the whole range into warm stone, so lightness maps
 * monotonically and the original hue survives as a tint.
 */
export function daySurface(hex: number): number {
  if (isNeutralExtreme(hex)) return hex
  const hit = exact.get(hex)
  if (hit !== undefined) return hit
  const [h, s, l] = hslOf(hex)
  if (l < 0.34) {
    // 0.48–0.74, not 0.7–0.95: a sunlit surface still has a light term on top
    // of this, and stone that starts near white has nowhere left to go.
    const lit = 0.48 + Math.min(l, 0.4) * 0.65
    // Warm sandstone, and committed to it. Every structural colour here is a
    // blue-grey navy, so a translation that keeps much of the source hue
    // produces a uniformly cold grey model — technically a day theme, visually
    // a lit night one.
    const stone = hexOfHsl(34, 0.32, lit)
    const tint = hexOfHsl(h, Math.min(s, 0.55) * 0.85, lit)
    return mix(stone, tint, 0.26)
  }
  return hexOfHsl(
    h,
    Math.max(0.25, Math.min(0.8, s * 0.85)),
    Math.max(0.34, Math.min(0.62, 0.26 + l * 0.4)),
  )
}

/**
 * Meaning — anything painted with `neon()`, and every accent the generic walk
 * finds. Bloom is off, so the value on screen IS the value picked here: it has
 * to be dark enough to hold against a bright sky without any halo helping it.
 */
export function dayAccent(hex: number): number {
  if (isNeutralExtreme(hex)) return hex
  const hit = exact.get(hex)
  if (hit !== undefined) return hit
  const [h, s, l] = hslOf(hex)
  return hexOfHsl(
    h,
    Math.max(0.42, Math.min(0.95, s * 0.9 + 0.1)),
    Math.max(0.3, Math.min(0.56, 0.3 + l * 0.34)),
  )
}

/**
 * Ink — every line material.
 *
 * At night the blueprint edges glow, and that glow is what draws the
 * silhouette. At noon glow is invisible, so the same edges become the drawing's
 * ink line: the hue survives as a trace, the value does not. `dayInkOpacity` is
 * the other half of "heavier" — WebGL cannot widen a line, so weight has to
 * come from opacity.
 */
export function dayInk(hex: number): number {
  const [h, s, l] = hslOf(hex)
  return hexOfHsl(h, Math.min(s, 0.6) * 0.85, 0.12 + l * 0.08)
}

export function dayInkOpacity(opacity: number): number {
  return Math.min(1, opacity * 1.8 + 0.28)
}

/**
 * Emissive. A dark emissive at night is a cheap self-illumination trick that
 * keeps unlit structure off the floor of the image; in daylight there is a sun
 * doing that job, and the trick reads as grime. A *bright* emissive is a lit
 * thing and stays lit.
 */
export function dayEmissive(hex: number): number {
  if (hex === 0x000000) return 0x000000
  const [, , l] = hslOf(hex)
  if (l < 0.28) return 0x000000
  return dayAccent(hex)
}

/** Neon intensity is a bloom lever at night; at noon it is nearly flat. */
export function dayNeonIntensity(intensity: number): number {
  return Math.max(0.98, Math.min(1.18, 1.0 + (intensity - 1) * 0.1))
}
