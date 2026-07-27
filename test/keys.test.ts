import { describe, expect, it } from 'vitest'

import { physicalKey } from '../src/ui/uikit'

/* ============================================================================
 * KEYBOARD SHORTCUTS ARE PHYSICAL, NOT ALPHABETIC.
 *
 * These exist because every shortcut in the app was once written as
 * `e.key === 'f'`, which is the CHARACTER the layout produces. On a Cyrillic
 * layout that character is `а`, so fly mode, the tour, the command palette,
 * pause, reset and the theme toggle were all simply absent — with no error and
 * nothing in the console. WASD kept working the whole time, because the camera
 * rig was already switching on `e.code`, which is what made the failure look
 * like "the UI is broken" rather than "the keyboard is not being read".
 * ==========================================================================*/

/**
 * A keydown as the browser reports it: `code` is the physical key and never
 * changes; `key` is whatever the active layout prints on it.
 */
function ev(code: string, key: string, init: KeyboardEventInit = {}): KeyboardEvent {
  return { code, key, ...init } as KeyboardEvent
}

describe('physicalKey', () => {
  it('reads letters from the physical key on a US layout', () => {
    expect(physicalKey(ev('KeyF', 'f'))).toBe('F')
    expect(physicalKey(ev('KeyT', 't'))).toBe('T')
    expect(physicalKey(ev('KeyN', 'N', { shiftKey: true }))).toBe('N')
  })

  it('reads the same letters on a Cyrillic layout', () => {
    // The exact characters macOS and Windows report for the Russian layout.
    expect(physicalKey(ev('KeyF', 'а'))).toBe('F')
    expect(physicalKey(ev('KeyT', 'е'))).toBe('T')
    expect(physicalKey(ev('KeyH', 'р'))).toBe('H')
    expect(physicalKey(ev('KeyR', 'к'))).toBe('R')
    expect(physicalKey(ev('KeyK', 'л'))).toBe('K')
    expect(physicalKey(ev('KeyP', 'з'))).toBe('P')
    expect(physicalKey(ev('KeyN', 'т'))).toBe('N')
  })

  it('reads punctuation from the physical key, which is where the shortcuts live', () => {
    // `/` opens the palette and Shift-`/` opens help. On the Russian layout the
    // same physical key prints `.` and `,`.
    expect(physicalKey(ev('Slash', '/'))).toBe('/')
    expect(physicalKey(ev('Slash', '.'))).toBe('/')
    // Speed down and up.
    expect(physicalKey(ev('Comma', ','))).toBe(',')
    expect(physicalKey(ev('Comma', 'б'))).toBe(',')
    expect(physicalKey(ev('Period', '.'))).toBe('.')
    expect(physicalKey(ev('Period', 'ю'))).toBe('.')
  })

  it('reads the district jump digits, from the row and from the numpad', () => {
    // The digit row is not remapped by the Cyrillic layout, but the code path
    // has to reach it all the same.
    for (let d = 1; d <= 7; d++) {
      expect(physicalKey(ev(`Digit${d}`, String(d)))).toBe(String(d))
      expect(physicalKey(ev(`Numpad${d}`, String(d)))).toBe(String(d))
    }
  })

  it('passes through keys that carry no character', () => {
    expect(physicalKey(ev('Escape', 'Escape'))).toBe('Escape')
    expect(physicalKey(ev('ArrowLeft', 'ArrowLeft'))).toBe('ArrowLeft')
    expect(physicalKey(ev('ArrowRight', 'ArrowRight'))).toBe('ArrowRight')
    expect(physicalKey(ev('Enter', 'Enter'))).toBe('Enter')
  })

  it('falls back to the character when there is no code at all', () => {
    // Synthetic events, some IMEs and some virtual keyboards report an empty
    // `code`. A shortcut that stops working there is worse than one that
    // guesses from the character.
    expect(physicalKey(ev('', 'f'))).toBe('F')
    expect(physicalKey(ev('', 'Escape'))).toBe('Escape')
    expect(physicalKey(ev('', '/'))).toBe('/')
  })

  it('never returns a lowercase letter, so a switch cannot miss a case', () => {
    // The bug this file exists for was a `switch` that listed both `'f'` and
    // `'F'`. One canonical form per key means that cannot come back.
    for (const c of 'ABCDEFGHIJKLMNOPQRSTUVWXYZ') {
      expect(physicalKey(ev(`Key${c}`, c.toLowerCase()))).toBe(c)
      expect(physicalKey(ev(`Key${c}`, c))).toBe(c)
    }
  })
})

describe('the shortcuts the app actually binds', () => {
  /**
   * Every keystroke the HUD, the palette and the help overlay respond to,
   * as a Cyrillic-layout event. None of these may come back as its character.
   */
  const BINDINGS: [code: string, cyrillic: string, expected: string, what: string][] = [
    ['KeyF', 'а', 'F', 'fly mode'],
    ['KeyT', 'е', 'T', 'the guided tour'],
    ['KeyH', 'р', 'H', 'the establishing shot'],
    ['KeyR', 'к', 'R', 'reset'],
    ['KeyK', 'л', 'K', 'pause'],
    ['KeyP', 'з', 'P', 'pause'],
    ['KeyN', 'т', 'N', 'day / night'],
    ['Slash', '.', '/', 'the command palette'],
    ['Comma', 'б', ',', 'slower'],
    ['Period', 'ю', '.', 'faster'],
  ]

  it.each(BINDINGS)('%s survives the Russian layout (%s → %s: %s)', (code, cyrillic, expected) => {
    expect(physicalKey(ev(code, cyrillic))).toBe(expected)
  })
})
