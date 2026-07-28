import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import { DISTRICT_BOUNDS } from '../src/world/layout'

/**
 * Read from disk, not through Vite. `import '…css?raw'` returns an EMPTY string
 * under Vitest — it stubs CSS modules — and this file spent one commit doing
 * exactly that: `cssPx` threw while the suite was being collected, Vitest
 * reported the file as zero tests and zero failures, and the run stayed green.
 * A test that asserts nothing is worse than no test, so the length check is
 * part of the fixture.
 */
function sheet(name: string): string {
  const css = readFileSync(fileURLToPath(new URL(`../src/styles/${name}`, import.meta.url)), 'utf8')
  if (css.length < 100) throw new Error(`${name} came back empty — the test is not reading the stylesheet`)
  return css
}

const hudCss = sheet('hud.css')
const tokensCss = sheet('tokens.css')

/* ============================================================================
 * THE MINIMAP'S BOX HAS TO MATCH THE WORLD IT DRAWS.
 *
 * The projection inside the canvas is uniform — a square island must look
 * square — so the canvas cannot stretch to whatever box CSS gives it. It
 * surrounds the plan with empty ground instead. The first version of this map
 * was 178 by 168 for a world 740 across and 910 deep, and the entire cluster
 * ended up in a narrow strip down the middle with a third of the canvas blank
 * on either side. Nothing failed; it just looked broken, which is worse.
 * ==========================================================================*/

/** The world extent `ui/minimap.ts` fits to, recomputed here independently. */
function worldExtent(): { w: number; d: number } {
  let x0 = Infinity
  let x1 = -Infinity
  let z0 = Infinity
  let z1 = -Infinity
  for (const key of Object.keys(DISTRICT_BOUNDS)) {
    if (key === 'world') continue
    const b = DISTRICT_BOUNDS[key]
    x0 = Math.min(x0, b.x[0])
    x1 = Math.max(x1, b.x[1])
    z0 = Math.min(z0, b.z[0])
    z1 = Math.max(z1, b.z[1])
  }
  const margin = 30
  return { w: x1 - x0 + margin * 2, d: z1 - z0 + margin * 2 }
}

function cssPx(rule: string, prop: string): number {
  const block = hudCss.slice(hudCss.indexOf(rule))
  const m = block.slice(0, block.indexOf('}')).match(new RegExp(`${prop}:\\s*(\\d+(?:\\.\\d+)?)px`))
  if (!m) throw new Error(`no ${prop} in ${rule}`)
  return Number(m[1])
}

describe('the minimap canvas', () => {
  const panelW = cssPx('.map {', 'width')
  const canvasH = cssPx('.map__c {', 'height')
  // `.map` pads 6px on each side, and the canvas is width: 100% of that.
  const canvasW = panelW - 12

  it('is the shape of the world it draws, so the plan fills it', () => {
    const world = worldExtent()
    const wanted = canvasW * (world.d / world.w)
    // Within a pixel and a half: the CSS holds a whole number and the world
    // extent is not going to divide evenly into one.
    expect(Math.abs(canvasH - wanted)).toBeLessThan(1.5)
  })

  it('is wider than it is tall, because the four servers stand in a row', () => {
    // Not a restatement of the test above: it is the specific fact the
    // stylesheet's comment has now got backwards twice. It read "deeper than
    // wide" while the servers were a 2x2 square, which was true then; the row
    // made the world 1460 across against 910 deep and inverted it.
    const world = worldExtent()
    expect(world.w).toBeGreaterThan(world.d)
    expect(canvasW).toBeGreaterThan(canvasH)
  })

  it('leaves room for itself above the transport dock', () => {
    // The map hides below this viewport height rather than ride up over the
    // dock. Whatever the threshold is, it has to exceed the map's own height
    // by enough for the vitals bar and the dock.
    const hideBelow = Number(tokensCss.match(/@media \(max-height: (\d+)px\)/)?.[1])
    expect(hideBelow).toBeGreaterThan(canvasH * 3)
  })
})
