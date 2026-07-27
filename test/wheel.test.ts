import { describe, expect, it } from 'vitest'

import { wheelPixels, wheelPixelsX } from '../src/engine/camera'

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
