import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

/**
 * Read from disk, not through Vite. `import '…css?raw'` returns an EMPTY string
 * under Vitest — it stubs CSS modules — and a stylesheet test handed an empty
 * string does not fail, it silently asserts nothing.
 */
function sheet(name: string): string {
  const css = readFileSync(fileURLToPath(new URL(`../src/styles/${name}`, import.meta.url)), 'utf8')
  if (css.length < 100) throw new Error(`${name} came back empty — the test is not reading the stylesheet`)
  return css
}

const tokensCss = sheet('tokens.css')
const uiCss = sheet('ui.css')
const hudCss = sheet('hud.css')

/* ============================================================================
 * A CLOSED OVERLAY MUST NOT EAT CLICKS.
 *
 * The command palette and the help sheet are `position: fixed; inset: 0;
 * pointer-events: auto`, and both declared `display: grid`. An author `display`
 * beats the UA's `[hidden] { display: none }`, so setting `.hidden` did nothing
 * but leave them at `opacity: 0` — invisible, on top of everything at z-index
 * 20 and 24, and still hit-testable.
 *
 * The result was that from the first paint a transparent sheet covered the
 * entire application. Every click in the UI went to it: the scenario picker,
 * Fly, Tour, Search, the console tab, the vitals tiles, and the 3D scene.
 * Nothing threw, nothing logged, and each individual control looked like its
 * own separate bug. Automated checks did not catch it either, because they
 * drove the app through the event bus and by assigning to `.value` — never
 * with a real click, which is the only thing that would have hit the sheet.
 * ==========================================================================*/

const SHEETS: [name: string, css: string][] = [
  ['tokens.css', tokensCss],
  ['ui.css', uiCss],
  ['hud.css', hudCss],
]

/** Every `selector { … }` rule in a stylesheet, flattened, media queries included. */
function rules(css: string): { selector: string; body: string }[] {
  const out: { selector: string; body: string }[] = []
  // Comments first, and not per-selector: the explanation above the reset in
  // tokens.css quotes the UA rule verbatim, braces and all, and a parser that
  // strips comments only from the selector it has already split reads that
  // quotation as a rule and then mis-splits everything after it.
  const re = /([^{}]+)\{([^{}]*)\}/g
  const src = css.replace(/\/\*[\s\S]*?\*\//g, '')
  let m: RegExpExecArray | null
  while ((m = re.exec(src)) !== null) {
    const selector = m[1].trim()
    if (!selector || selector.startsWith('@')) continue
    out.push({ selector, body: m[2] })
  }
  return out
}

const declares = (body: string, prop: string, value?: string): boolean =>
  new RegExp(`(^|;|\\s)${prop}\\s*:\\s*${value ?? '[^;]+'}`, 'i').test(body)

describe('the [hidden] reset', () => {
  it('exists, and is important enough to be unbeatable', () => {
    const reset = rules(tokensCss).find((r) => r.selector === '[hidden]')
    expect(reset, '[hidden] reset is missing from tokens.css').toBeDefined()
    expect(declares(reset!.body, 'display', 'none\\s*!important')).toBe(true)
  })

  it('is not re-declared anywhere else', () => {
    for (const [name, css] of SHEETS) {
      for (const r of rules(css)) {
        if (r.selector === '[hidden]' && css !== tokensCss) {
          throw new Error(`${name} re-declares [hidden]; there is one reset and it lives in tokens.css`)
        }
      }
    }
  })
})

describe('full-screen interactive overlays', () => {
  /**
   * Anything that covers the viewport and accepts pointer events. Each of these
   * is only safe while closed because of the reset above — which is the whole
   * reason the reset carries `!important` and this test exists to notice if a
   * future overlay is added on the assumption that `hidden` works by itself.
   */
  const covering = SHEETS.flatMap(([name, css]) =>
    rules(css)
      .filter(
        (r) =>
          declares(r.body, 'position', 'fixed') &&
          declares(r.body, 'inset', '0') &&
          declares(r.body, 'pointer-events', 'auto'),
      )
      .map((r) => ({ name, ...r })),
  )

  it('are the ones we know about', () => {
    // If this list grows, the new overlay has to be hidden with `.hidden` — not
    // with opacity alone — and this test is where you find out.
    expect(covering.map((r) => r.selector).sort()).toEqual(['.help', '.pal-overlay'])
  })

  it('each declare a display that would defeat [hidden] on its own', () => {
    // Not a style preference: it is the precise condition that made them
    // invisible AND clickable. The reset is what neutralises it.
    for (const r of covering) {
      expect(declares(r.body, 'display'), `${r.name} ${r.selector}`).toBe(true)
    }
  })
})
