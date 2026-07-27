/** Small math and formatting helpers shared across the whole app. */

export const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v)
export const clamp01 = (v: number) => clamp(v, 0, 1)
export const lerp = (a: number, b: number, t: number) => a + (b - a) * t
export const invLerp = (a: number, b: number, v: number) => (b === a ? 0 : (v - a) / (b - a))
export const remap = (v: number, a: number, b: number, c: number, d: number) =>
  lerp(c, d, clamp01(invLerp(a, b, v)))
export const smoothstep = (t: number) => {
  const x = clamp01(t)
  return x * x * (3 - 2 * x)
}
export const easeOutCubic = (t: number) => 1 - Math.pow(1 - clamp01(t), 3)
export const easeInOutCubic = (t: number) => {
  const x = clamp01(t)
  return x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2
}

/** Frame-rate independent exponential approach. `rate` ≈ how much closes per second. */
export const damp = (current: number, target: number, rate: number, dt: number) =>
  lerp(current, target, 1 - Math.exp(-rate * dt))

/** Deterministic 32-bit PRNG (mulberry32) — the same cluster on every reload. */
export function makeRng(seed = 0x0cc1c4) {
  let a = seed >>> 0
  return function rng(): number {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export const rand = makeRng()
export const randRange = (lo: number, hi: number, r = rand) => lo + (hi - lo) * r()
export const randInt = (lo: number, hi: number, r = rand) => Math.floor(lo + (hi - lo + 1) * r())
export const pick = <T,>(arr: readonly T[], r = rand): T =>
  arr[Math.min(arr.length - 1, Math.floor(r() * arr.length))]

/** Weighted pick: weights need not be normalised. */
export function weightedPick(weights: readonly number[], r = rand): number {
  let total = 0
  for (const w of weights) total += w
  if (total <= 0) return 0
  let x = r() * total
  for (let i = 0; i < weights.length; i++) {
    x -= weights[i]
    if (x <= 0) return i
  }
  return weights.length - 1
}

/** Exponential inter-arrival time for a Poisson process of the given rate. */
export const expDelay = (ratePerSec: number, r = rand) =>
  ratePerSec <= 0 ? Infinity : -Math.log(1 - r()) / ratePerSec

/**
 * The 64-bit hash `sipHash64` stands in for. ClickHouse's own default sharding
 * expression on a `Distributed` table is usually `sipHash64(key) % shards` or
 * `rand()`, and which one you pick decides whether your shards are balanced or
 * whether one of them holds everything. This is a 32-bit avalanche mixer, which
 * is enough to make the distribution argument honestly.
 */
export function shardHash(key: number): number {
  let h = key | 0
  h = Math.imul(h ^ (h >>> 16), 0x7feb352d)
  h = Math.imul(h ^ (h >>> 15), 0x846ca68b)
  return (h ^ (h >>> 16)) >>> 0
}

/**
 * Compass heading of a camera, in radians, measured CLOCKWISE FROM NORTH.
 *
 * `m` is a THREE.Matrix4's element array in column-major order. Elements 8..10
 * are the camera's local +Z axis in world space, and a camera looks down its
 * own -Z, so the forward vector is `(-m[8], -m[9], -m[10])`.
 *
 * The convention matters and is easy to get backwards: north is -Z in this
 * world, so a camera looking north must return 0, and one looking east must
 * return +PI/2. That is `atan2(forwardX, -forwardZ)`, NOT
 * `atan2(forwardX, forwardZ)` — the latter returns 0 for SOUTH and made the
 * minimap's view cone point exactly away from where the camera was looking.
 */
export function headingFromMatrix(m: ArrayLike<number>): number {
  return Math.atan2(-m[8], m[10])
}

/* ------------------------------ accessibility ---------------------------- */

/**
 * Live "the visitor asked for less motion" flag. CSS already honours the
 * preference for transitions, but the camera flights and the particle streams
 * are JavaScript and would otherwise ignore it.
 */
let _reduceMotion = false
if (typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
  const mq = window.matchMedia('(prefers-reduced-motion: reduce)')
  _reduceMotion = mq.matches
  if (typeof mq.addEventListener === 'function') {
    mq.addEventListener('change', (e: MediaQueryListEvent) => {
      _reduceMotion = e.matches
    })
  }
}

export const reduceMotion = (): boolean => _reduceMotion

/* ------------------------------ formatting ------------------------------ */

export function fmtBytes(b: number, digits = 1): string {
  const neg = b < 0
  let v = Math.abs(b)
  // Binary units: the arithmetic is 1024-based, so the names must be too.
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB', 'PiB']
  let i = 0
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i++
  }
  return `${neg ? '-' : ''}${v.toFixed(i === 0 ? 0 : digits)} ${units[i]}`
}

export function fmtNum(n: number, digits = 0): string {
  if (!isFinite(n)) return '∞'
  if (Math.abs(n) >= 1e12) return `${(n / 1e12).toFixed(2)}T`
  if (Math.abs(n) >= 1e9) return `${(n / 1e9).toFixed(2)}B`
  if (Math.abs(n) >= 1e6) return `${(n / 1e6).toFixed(2)}M`
  if (Math.abs(n) >= 1e4) return `${(n / 1e3).toFixed(1)}k`
  return n.toLocaleString(undefined, { maximumFractionDigits: digits })
}

export function fmtPct(x: number, digits = 0): string {
  return `${(x * 100).toFixed(digits)}%`
}

export function fmtDuration(sec: number): string {
  if (sec < 1) return `${(sec * 1000).toFixed(0)} ms`
  if (sec < 60) return `${sec.toFixed(1)} s`
  const m = Math.floor(sec / 60)
  const s = Math.floor(sec % 60)
  if (m < 60) return `${m}m ${s.toString().padStart(2, '0')}s`
  const h = Math.floor(m / 60)
  return `${h}h ${(m % 60).toString().padStart(2, '0')}m`
}

/**
 * A `MergeTree` part name, exactly as `system.parts.name` spells it:
 *
 *     <partition_id>_<min_block>_<max_block>_<level>[_<mutation>]
 *
 * The mutation suffix appears only once a mutation has rewritten the part, which
 * is why `20260727_1_1_0` and `20260727_1_1_0_5` are the same data at two
 * different versions.
 */
export function partName(
  partitionId: string,
  minBlock: number,
  maxBlock: number,
  level: number,
  mutation = 0,
): string {
  const base = `${partitionId}_${minBlock}_${maxBlock}_${level}`
  return mutation > 0 ? `${base}_${mutation}` : base
}

/**
 * Partition id for a `toYYYYMMDD`-style partition key, counted back from a
 * fixed epoch so the ids look like real dates without depending on the clock.
 */
export function partitionId(index: number, base = 20260701): string {
  // Day arithmetic on a YYYYMMDD integer only has to be plausible, not correct
  // across month boundaries; the city never shows more than a month of them.
  const day = (base % 100) + index
  const month = Math.floor((base % 10000) / 100) + Math.floor((day - 1) / 30)
  const year = Math.floor(base / 10000)
  const d = ((day - 1) % 30) + 1
  return `${year}${String(month).padStart(2, '0')}${String(d).padStart(2, '0')}`
}

/** Marks in a part: one per granule, plus the terminating mark. */
export function markCount(rows: number, granularity = 8192): number {
  return Math.ceil(rows / granularity) + 1
}

/** Push a value onto a fixed-length rolling history array. */
export function pushHistory(arr: number[], v: number, max = 120): void {
  arr.push(v)
  if (arr.length > max) arr.splice(0, arr.length - max)
}

/** Rolling exponential average. */
export class Ema {
  value: number
  constructor(
    initial = 0,
    private readonly rate = 3,
  ) {
    this.value = initial
  }
  push(v: number, dt: number): number {
    this.value = damp(this.value, v, this.rate, dt)
    return this.value
  }
}
