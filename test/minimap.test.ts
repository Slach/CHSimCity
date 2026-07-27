import { describe, expect, it } from 'vitest'

// `?raw` rather than node:fs on purpose: nothing in this project, tests
// included, is allowed to reach for a Node API, and Vite types this for us.
import hudCss from '../src/styles/hud.css?raw'
import tokensCss from '../src/styles/tokens.css?raw'
import { DISTRICT_BOUNDS } from '../src/world/layout'

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

  it('is taller than it is wide, because the clients sit far north of the shards', () => {
    // Not a restatement of the test above: it is the specific fact the old
    // comment in the stylesheet got backwards.
    const world = worldExtent()
    expect(world.d).toBeGreaterThan(world.w)
    expect(canvasH).toBeGreaterThan(canvasW)
  })

  it('leaves room for itself above the transport dock', () => {
    // The map hides below this viewport height rather than ride up over the
    // dock. Whatever the threshold is, it has to exceed the map's own height
    // by enough for the vitals bar and the dock.
    const hideBelow = Number(tokensCss.match(/@media \(max-height: (\d+)px\)/)?.[1])
    expect(hideBelow).toBeGreaterThan(canvasH * 3)
  })
})
