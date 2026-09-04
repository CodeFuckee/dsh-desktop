#!/usr/bin/env node
/**
 * Process-level acceptance test for the packaged dsh-desktop runtime.
 *
 * Spawns the exact command the Tauri shell spawns —
 *   <runtime>/node <runtime>/app/node_modules/@deepseek-ai/dsh/lib/bin.js web --no-open --port 0
 * — waits for the "dsh web: <url>" readiness line, then GETs the URL and
 * asserts the page body carries the boot manifest (`window.__DSH_BOOT__`),
 * mirroring the harness lesson that an HTTP 200 is not application readiness.
 *
 * Exits non-zero with the captured output on any failure.
 *
 * Usage: node scripts/smoke-test.mjs [--runtime <dir>] [--timeout-ms <ms>]
 */

import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const IS_WINDOWS = process.platform === 'win32'
const URL_LINE_PREFIX = 'dsh web: '

function parseArgs(argv) {
  const args = { runtime: undefined, timeoutMs: 60_000 }
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--runtime') args.runtime = resolve(argv[++i])
    else if (argv[i] === '--timeout-ms') args.timeoutMs = Number(argv[++i])
  }
  if (args.runtime === undefined) args.runtime = join(ROOT, 'src-tauri', 'runtime')
  return args
}

/** Extract the first "dsh web: <url>" line from a chunk stream (mirrors server.rs). */
function parseUrlLine(chunk, state) {
  state.text += chunk
  for (;;) {
    const nl = state.text.indexOf('\n')
    if (nl === -1) return undefined
    const line = state.text.slice(0, nl).trim().replace(/\r$/u, '')
    state.text = state.text.slice(nl + 1)
    if (line.startsWith(URL_LINE_PREFIX)) {
      const url = line.slice(URL_LINE_PREFIX.length).trim().split(/\s+/u)[0]
      if (url.length > 0) return url
    }
  }
}

let childForCleanup

function fail(message, stdout, stderr) {
  console.error(`[smoke] FAILED: ${message}`)
  if (stdout.length > 0) console.error('--- captured stdout ---\n' + stdout.join(''))
  if (stderr.length > 0) console.error('--- captured stderr ---\n' + stderr.join(''))
  // Never leak the spawned dsh server, even on failure paths.
  if (childForCleanup !== undefined) {
    childForCleanup.terminate()
    childForCleanup.kill()
  }
  process.exit(1)
}

async function main() {
  const { runtime, timeoutMs } = parseArgs(process.argv.slice(2))
  const nodeExe = join(runtime, IS_WINDOWS ? 'node.exe' : 'node')
  const binJs = join(runtime, 'app', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
  if (!existsSync(nodeExe)) fail(`node executable not found: ${nodeExe}`)
  if (!existsSync(binJs)) fail(`dsh entry not found: ${binJs}`)
  try {
    const v = JSON.parse(readFileSync(join(runtime, 'version.json'), 'utf8'))
    console.log(`[smoke] runtime ${v.dsh} on node ${v.node} (${v.target}) @ ${runtime}`)
  } catch {
    /* version.json is informational */
  }

  const child = new ChildProcess()
  const pending = { text: '' }
  const stdout = []
  const stderr = []
  let url

  try {
    child.spawn(nodeExe, [binJs, 'web', '--no-open', '--port', '0'])
  } catch (err) {
    fail(`spawn failed: ${err.message}`)
  }
  childForCleanup = child

  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const chunk = child.pollOutput()
    if (chunk !== undefined) {
      const { stream, text } = chunk
      ;(stream === 'stdout' ? stdout : stderr).push(text)
      if (stream === 'stdout') {
        url ??= parseUrlLine(text, pending)
        if (url !== undefined) break
      }
    }
    const status = child.pollExit()
    if (status !== undefined) {
      fail(`dsh exited early with code ${status}`, stdout, stderr)
    }
    await sleep(50)
  }

  if (url === undefined) fail(`no "${URL_LINE_PREFIX}<url>" line within ${timeoutMs}ms`, stdout, stderr)
  console.log(`[smoke] readiness line: ${url}`)

  // The token URL is a launch-token exchange: it mints an authority-bound
  // session cookie (Set-Cookie) and 303-redirects to the clean root. A real
  // browser stores the cookie; Node's fetch has no cookie jar, so mirror the
  // handshake explicitly: follow with redirect:'manual' and replay the cookie.
  const base = new URL(url)
  base.search = ''
  const pageUrl = base.toString()

  let cookie
  let res
  try {
    res = await fetch(url, { redirect: 'manual' })
  } catch (err) {
    fail(`GET ${url} failed: ${err.message}`, stdout, stderr)
  }
  if (res.status === 303) {
    cookie = (res.headers.get('set-cookie') ?? '').split(';')[0]
    if (cookie === '') fail(`token exchange 303 carried no Set-Cookie`, stdout, stderr)
    console.log(`[smoke] token exchange -> 303, session cookie minted`)
    try {
      res = await fetch(pageUrl, { headers: { cookie } })
    } catch (err) {
      fail(`GET ${pageUrl} failed: ${err.message}`, stdout, stderr)
    }
  } else if (res.status !== 200) {
    fail(`GET ${url} -> HTTP ${res.status} (expected 303 token exchange or 200)`, stdout, stderr)
  }

  const body = await res.text()
  if (res.status !== 200) fail(`GET ${pageUrl} -> HTTP ${res.status}`, stdout, stderr)
  if (!body.includes('__DSH_BOOT__')) {
    fail(`GET ${pageUrl} returned HTTP 200 but the page lacks __DSH_BOOT__ (not application-ready)`, stdout, stderr)
  }
  console.log(`[smoke] GET ${pageUrl} -> HTTP 200, page carries __DSH_BOOT__`)

  child.terminate()
  await sleep(200)
  child.kill()
  console.log('[smoke] PASS')
  process.exit(0)
}

function sleep(ms) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms))
}

/** Minimal child-process wrapper independent of platform quirks. */
import { spawn } from 'node:child_process'
class ChildProcess {
  #proc
  #stdoutBuf = ''
  #stderrBuf = ''

  spawn(exe, args) {
    this.#proc = spawn(exe, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    this.#proc.stdout.on('data', (d) => (this.#stdoutBuf += d.toString('utf8')))
    this.#proc.stderr.on('data', (d) => (this.#stderrBuf += d.toString('utf8')))
  }

  pollOutput() {
    if (this.#stdoutBuf.length > 0) {
      const text = this.#stdoutBuf
      this.#stdoutBuf = ''
      return { stream: 'stdout', text }
    }
    if (this.#stderrBuf.length > 0) {
      const text = this.#stderrBuf
      this.#stderrBuf = ''
      return { stream: 'stderr', text }
    }
    return undefined
  }

  pollExit() {
    return this.#proc.exitCode ?? undefined
  }

  terminate() {
    if (this.#proc.exitCode !== null) return
    if (IS_WINDOWS) {
      spawn('taskkill', ['/pid', String(this.#proc.pid), '/T', '/F'], { stdio: 'ignore' })
    } else {
      try {
        process.kill(-this.#proc.pid, 'SIGTERM')
      } catch {
        try {
          this.#proc.kill('SIGTERM')
        } catch {
          /* already dead */
        }
      }
    }
  }

  kill() {
    if (this.#proc.exitCode !== null) return
    try {
      this.#proc.kill('SIGKILL')
    } catch {
      /* already dead */
    }
  }
}

main().catch((err) => {
  console.error('[smoke] FAILED:', err.message)
  process.exit(1)
})