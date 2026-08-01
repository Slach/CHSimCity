import { describe, expect, it } from 'vitest'

import { groundPivotDistance, wheelPixels, wheelPixelsX } from '../src/engine/camera'

/* ============================================================================
 * TRACKPAD DELTAS.
 *
 * A trackpad is not a small mouse. It sends fractional deltas, it sends a
 * horizontal axis constantly, and it reports a pinch as a wheel event with
 * `ctrlKey` set — which is a platform convention and not a modifier anybody
 * pressed. Getting any of those wrong makes a gesture look unsupported rather
 * than broken: nothing moves and nothing errors.
 *
 * The horizontal axis is the one that was missing entirely. A two-finger
 * sideways swipe produced `deltaX` and the camera read only `deltaY`, so the
 * most natural way to move across a map on a laptop did nothing at all.
 * ==========================================================================*/

const ev = (init: Partial<WheelEvent>): WheelEvent =>
  ({ deltaX: 0, deltaY: 0, deltaZ: 0, deltaMode: 0, ...init }) as WheelEvent

describe('wheel delta normalisation', () => {
  it('passes pixel deltas through, fractions included', () => {
    // A trackpad's are small and fractional; a mouse notch is 100 or 120.
    expect(wheelPixels(ev({ deltaY: 0.5 }))).toBe(0.5)
    expect(wheelPixels(ev({ deltaY: -3.25 }))).toBe(-3.25)
    expect(wheelPixels(ev({ deltaY: 120 }))).toBe(120)
  })

  it('converts line and page deltas to pixels', () => {
    // Firefox on some platforms reports lines; a few report pages. Treating
    // either as pixels makes the wheel imperceptible there.
    expect(wheelPixels(ev({ deltaY: 3, deltaMode: 1 }))).toBe(48)
    expect(wheelPixels(ev({ deltaY: 1, deltaMode: 2 }))).toBe(100)
  })

  it('reads the horizontal axis at all', () => {
    expect(wheelPixelsX(ev({ deltaX: 12 }))).toBe(12)
    expect(wheelPixelsX(ev({ deltaX: -12 }))).toBe(-12)
    expect(wheelPixelsX(ev({ deltaX: 3, deltaMode: 1 }))).toBe(48)
    expect(wheelPixelsX(ev({ deltaX: 1, deltaMode: 2 }))).toBe(100)
  })

  it('keeps the two axes independent', () => {
    // A diagonal two-finger swipe must not have its pan read as zoom or the
    // other way round.
    const diagonal = ev({ deltaX: 9, deltaY: -4 })
    expect(wheelPixelsX(diagonal)).toBe(9)
    expect(wheelPixels(diagonal)).toBe(-4)
    expect(wheelPixelsX(ev({ deltaY: 40 }))).toBe(0)
    expect(wheelPixels(ev({ deltaX: 40 }))).toBe(0)
  })
})

/* ============================================================================
 * LEAVING FLY MODE.
 *
 * The eye survived the mode flip and the pivot did not: orbit kept the radius
 * it had BEFORE the flight, so after flying down between two islands the pivot
 * sat hundreds of units past everything you had flown to. The flip itself
 * looked right, and then the first drag swung the camera back towards the view
 * you had left — which reads as the camera undoing your flight.
 * ==========================================================================*/

describe('the orbit pivot adopted when fly mode ends', () => {
  it('lands on the ground you are looking at, not at the old radius', () => {
    // 100 up, looking down at 45°: the ground is √2 × 100 ahead, and the stale
    // 900-unit radius must not survive.
    const d = groundPivotDistance(100, -Math.SQRT1_2, 900)
    expect(d).toBeCloseTo(100 * Math.SQRT2, 4)
  })

  it('keeps the pivot in front of you as you descend', () => {
    const high = groundPivotDistance(400, -0.5, 900)
    const low = groundPivotDistance(40, -0.5, 900)
    expect(low).toBeLessThan(high)
    expect(low).toBeGreaterThan(0)
  })

  it('falls back when the view ray never reaches the ground', () => {
    // Looking at the sky, looking dead level, and standing in the storage pit.
    expect(groundPivotDistance(200, 0.4, 640)).toBe(640)
    expect(groundPivotDistance(200, 0, 640)).toBe(640)
    expect(groundPivotDistance(-30, -0.9, 640)).toBe(640)
  })

  it('never returns a distance the orbit rig would refuse', () => {
    // Nose to the deck, and a fallback from far outside the dolly range.
    expect(groundPivotDistance(1.5, -0.999, 900)).toBeGreaterThanOrEqual(8)
    expect(groundPivotDistance(0.5, -0.999, 99999)).toBeLessThanOrEqual(2100)
    expect(groundPivotDistance(0.5, -0.999, 0)).toBeGreaterThanOrEqual(8)
  })
})
