#!/usr/bin/env node
/**
 * Headless screenshot driver for visual verification.
 *
 *   node tools/shoot.mjs <url> <out.png> [settleMs] [w] [h] [evalBeforeShot]
 *
 * Software WebGL runs at roughly 1–3 fps, so allow 30–70 seconds for the scene to
 * settle before the shot. The driver prints every console message and every
 * uncaught exception, and exits non-zero if any were thrown: creating an image
 * file is not verification, and a run that threw has to say so.
 *
 * It drives whatever Chrome the machine already has over CDP — no bundled
 * browser, no download step, no extra dependency.
 */

import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const [
  url = 'http://localhost:5174/',
  out = '/tmp/chsimcity.png',
  settleMs = '40000',
  width = '1600',
  height = '980',
  evalJs = '',
] = process.argv.slice(2)

const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
].filter(Boolean)

const chrome = CHROME_CANDIDATES.find((p) => existsSync(p))
if (!chrome) {
  console.error('No Chrome, Chromium or Edge found. Set CHROME_PATH to one.')
  process.exit(2)
}

const port = Number(process.env.CDP_PORT ?? 9522)
const profile = mkdtempSync(join(tmpdir(), 'chsimcity-cdp-'))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const child = spawn(
  chrome,
  [
    '--headless=new',
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    `--window-size=${width},${height}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--hide-scrollbars',
    // SwiftShader: no GPU is available headless, and this driver exists to work
    // without one.
    '--enable-unsafe-swiftshader',
    '--use-gl=angle',
    '--use-angle=swiftshader',
    'about:blank',
  ],
  { stdio: ['ignore', 'ignore', 'pipe'] },
)

child.stderr.on('data', (b) => {
  const s = String(b)
  if (/ERROR|FATAL/.test(s)) process.stderr.write(`[chrome] ${s}`)
})

function cleanup() {
  child.kill('SIGTERM')
  rmSync(profile, { recursive: true, force: true })
}

async function openTarget() {
  for (let i = 0; i < 120; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' })
      if (res.ok) return await res.json()
    } catch {
      /* the port is not up yet */
    }
    await sleep(250)
  }
  throw new Error('Chrome did not open a debugging port')
}

let ws
let msgId = 0
const pending = new Map()

function send(method, params = {}) {
  const id = ++msgId
  ws.send(JSON.stringify({ id, method, params }))
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }))
}

async function main() {
  const target = await openTarget()
  ws = new WebSocket(target.webSocketDebuggerUrl)

  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true })
    ws.addEventListener('error', reject, { once: true })
  })

  let exceptions = 0
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data)
    if (m.id && pending.has(m.id)) {
      const { resolve, reject } = pending.get(m.id)
      pending.delete(m.id)
      if (m.error) reject(new Error(m.error.message))
      else resolve(m.result)
      return
    }
    if (m.method === 'Runtime.consoleAPICalled') {
      const text = (m.params.args ?? []).map((a) => a.value ?? a.description ?? a.type).join(' ')
      console.log(`[console.${m.params.type}] ${text}`)
    }
    if (m.method === 'Runtime.exceptionThrown') {
      exceptions++
      const d = m.params.exceptionDetails
      console.error(`[exception] ${d.text} ${d.exception?.description ?? ''}`)
    }
  })

  await send('Runtime.enable')
  await send('Page.enable')
  await send('Emulation.setDeviceMetricsOverride', {
    width: Number(width),
    height: Number(height),
    deviceScaleFactor: 1,
    mobile: false,
  })
  await send('Page.navigate', { url })
  await sleep(Number(settleMs))

  if (evalJs) {
    const r = await send('Runtime.evaluate', { expression: evalJs, awaitPromise: true, returnByValue: true })
    // Print it: the expression is often a probe rather than a stage-setting
    // command, and an unreported result is a wasted 40-second run.
    if (r.result?.value !== undefined) console.log(`[eval] ${JSON.stringify(r.result.value)}`)
    if (r.exceptionDetails) console.error(`[eval-exception] ${r.exceptionDetails.text}`)
    // Let the change take effect and the software renderer draw it.
    await sleep(15000)
  }

  const probe = await send('Runtime.evaluate', {
    expression: `JSON.stringify({
      booted: !!window.CHSIMCITY,
      components: window.CHSIMCITY ? window.CHSIMCITY.registry.all().length : 0,
      parts: window.CHSIMCITY ? window.CHSIMCITY.sim.state.stats.activeParts : 0,
      merges: window.CHSIMCITY ? window.CHSIMCITY.sim.state.stats.runningMerges : 0,
      fps: window.CHSIMCITY ? Math.round(window.CHSIMCITY.gfx.fps) : 0,
      bootDone: !!document.querySelector('#boot.done'),
    })`,
    returnByValue: true,
  })
  console.log(`[probe] ${probe.result.value}`)

  const shot = await send('Page.captureScreenshot', { format: 'png' })
  writeFileSync(out, Buffer.from(shot.data, 'base64'))
  console.log(`wrote ${out} (${exceptions} uncaught exception${exceptions === 1 ? '' : 's'})`)

  ws.close()
  cleanup()
  process.exit(exceptions > 0 ? 1 : 0)
}

main().catch((err) => {
  console.error(err)
  cleanup()
  process.exit(1)
})
