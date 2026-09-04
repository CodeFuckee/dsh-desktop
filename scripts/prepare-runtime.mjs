#!/usr/bin/env node
/**
 * Prepare the packaged runtime for dsh-desktop:
 *   1. Download the matching Node.js v22.23.1 distribution for --target.
 *   2. `npm install` the pinned `@deepseek-ai/dsh` release into the runtime app prefix.
 *   3. Write dist-assets/runtime/version.json.
 *
 * The output directory `src-tauri/runtime` is declared as a Tauri bundle
 * resource (`bundle.resources` in src-tauri/tauri.conf.json), so everything
 * here ends up inside the installers. The app is fully offline at runtime:
 * npm is only needed when preparing this tree.
 *
 * Usage: node scripts/prepare-runtime.mjs [--target <triple>] [--force]
 */

import {
  chmodSync,
  copyFileSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { pipeline } from 'node:stream/promises'
import { spawnSync } from 'node:child_process'
import { platform as osPlatform, arch as osArch } from 'node:os'

const NODE_VERSION = 'v22.23.1'
const DSH_VERSION = '0.1.2-rc.1'
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const RUNTIME_DIR = join(ROOT, 'src-tauri', 'runtime')
const IS_WINDOWS = process.platform === 'win32'

/** Map a Rust-style target triple to the Node.js dist file name. */
const NODE_DIST = {
  'aarch64-apple-darwin': { file: `node-${NODE_VERSION}-darwin-arm64.tar.gz`, exe: 'node' },
  'x86_64-apple-darwin': { file: `node-${NODE_VERSION}-darwin-x64.tar.gz`, exe: 'node' },
  'x86_64-pc-windows-msvc': { file: `node-${NODE_VERSION}-win-x64.zip`, exe: 'node.exe' },
  'x86_64-unknown-linux-gnu': { file: `node-${NODE_VERSION}-linux-x64.tar.xz`, exe: 'node' },
  'aarch64-unknown-linux-gnu': { file: `node-${NODE_VERSION}-linux-arm64.tar.xz`, exe: 'node' },
}

/** Guess the target triple from the current platform when --target is absent. */
function detectTarget() {
  const p = osPlatform()
  const a = osArch()
  if (p === 'darwin') return a === 'arm64' ? 'aarch64-apple-darwin' : 'x86_64-apple-darwin'
  if (p === 'win32') return 'x86_64-pc-windows-msvc'
  if (p === 'linux') return a === 'arm64' ? 'aarch64-unknown-linux-gnu' : 'x86_64-unknown-linux-gnu'
  throw new Error(`unsupported host platform: ${p}/${a}`)
}

function parseArgs(argv) {
  const args = { target: undefined, force: false }
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--target') args.target = argv[++i]
    else if (argv[i] === '--force') args.force = true
  }
  return args
}

function log(...parts) {
  console.log('[prepare-runtime]', ...parts)
}

async function download(url, dest) {
  log(`download ${url}`)
  const res = await fetch(url, { redirect: 'follow' })
  if (!res.ok) throw new Error(`download failed: ${res.status} ${res.statusText} (${url})`)
  await pipeline(res.body, createWriteStream(dest))
}

/** Download an archive, trying the official Node mirror then the China-friendly one. */
async function downloadNodeArchive(file, dest) {
  const urls = [
    `https://nodejs.org/dist/${NODE_VERSION}/${file}`,
    `https://npmmirror.com/mirrors/node/${NODE_VERSION}/${file}`,
  ]
  let lastError
  for (const url of urls) {
    try {
      await download(url, dest)
      return
    } catch (err) {
      lastError = err
      log(`mirror failed (${url}): ${err.message}`)
    }
  }
  throw lastError
}

function walkForExecutable(root, wantExe) {
  const stack = [root]
  while (stack.length > 0) {
    const dir = stack.pop()
    let entries = []
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) stack.push(full)
      else if (entry.name === wantExe) return full
    }
  }
  throw new Error(`executable "${wantExe}" not found under ${root}`)
}

function extractNodeArchive(archive, target, exe) {
  const staging = mkdtempSync(join(tmpdir(), 'dsh-node-'))
  try {
    let nodePath
    if (archive.endsWith('.zip')) {
      // Windows runners ship bsdtar (which reads zip); keep unzip elsewhere.
      const unzip = spawnSync(IS_WINDOWS ? 'tar' : 'unzip', IS_WINDOWS
        ? ['-xf', archive, '-C', staging]
        : ['-q', '-o', archive, '-d', staging], { stdio: 'inherit' })
      if (unzip.status !== 0) throw new Error(`unzip failed (${archive})`)
      nodePath = walkForExecutable(staging, exe)
    } else {
      const tar = spawnSync('tar', ['-xaf', archive, '-C', staging], { stdio: 'inherit' })
      if (tar.status !== 0) throw new Error(`tar extraction failed (${archive})`)
      nodePath = walkForExecutable(staging, exe)
    }
    const exeName = IS_WINDOWS ? 'node.exe' : 'node'
    const dest = join(RUNTIME_DIR, exeName)
    rmSync(dest, { force: true })
    mkdirSync(RUNTIME_DIR, { recursive: true })
    copyFileSync(nodePath, dest)
    try {
      chmodSync(dest, 0o755)
    } catch {
      /* windows: chmod is a no-op */
    }
    log(`node ${NODE_VERSION} (${target}) -> ${dest}`)
  } finally {
    rmSync(staging, { recursive: true, force: true })
  }
}

/** Scripted deps in the dsh tree whose binaries are load-bearing (koffi FFI,
 *  node-pty terminal, spawn helper chmod). npm 12 blocks dependency install
 *  scripts by default; a project-scoped `.npmrc` is the sanctioned channel
 *  to allow exactly these by name. */
const ALLOWED_SCRIPTS = [
  'koffi',
  'node-pty',
  '@deepseek-ai/dsh-subprocess-local',
  'protobufjs',
  '@google/genai',
]

function installDsh() {
  const appDir = join(RUNTIME_DIR, 'app')
  mkdirSync(appDir, { recursive: true })
  writeFileSync(
    join(appDir, 'package.json'),
    JSON.stringify(
      {
        name: 'dsh-desktop-runtime',
        private: true,
        version: DSH_VERSION,
        dependencies: { '@deepseek-ai/dsh': DSH_VERSION },
      },
      null,
      2,
    ) + '\n',
  )
  writeFileSync(join(appDir, '.npmrc'), `allow-scripts=${ALLOWED_SCRIPTS.join(',')}\n`)
  log(`npm install @deepseek-ai/dsh@${DSH_VERSION} (prefix ${appDir})`)
  const run = spawnSync(IS_WINDOWS ? 'npm.cmd' : 'npm', ['install', '--prefix', appDir, '--no-audit', '--no-fund'], {
    stdio: 'inherit',
    env: { ...process.env, npm_config_update_notifier: 'false' },
  })
  if (run.status !== 0) throw new Error('npm install of @deepseek-ai/dsh failed')
  verifyNativeModules(appDir)
}

/**
 * Load the native addons with the bundled Node to confirm install scripts /
 * shipped prebuilds produced loadable binaries. A failure here means the
 * packaged app would crash at runtime wherever koffi/node-pty are used.
 */
function verifyNativeModules(appDir) {
  const nodeExe = join(RUNTIME_DIR, IS_WINDOWS ? 'node.exe' : 'node')
  const script = [
    `try { require(${JSON.stringify(join(appDir, 'node_modules', 'koffi'))}); }`,
    `catch (e) { console.error('NATIVE-CHECK-FAIL koffi: ' + (e.message || e).split('\\n')[0]); process.exit(1); }`,
    `try { require(${JSON.stringify(join(appDir, 'node_modules', 'node-pty'))}); }`,
    `catch (e) { console.error('NATIVE-CHECK-FAIL node-pty: ' + (e.message || e).split('\\n')[0]); process.exit(1); }`,
    `console.log('native modules OK (koffi, node-pty) on node ' + process.version);`,
  ].join('\n')
  const run = spawnSync(nodeExe, ['-e', script], { stdio: 'inherit' })
  if (run.status !== 0) throw new Error('native module verification failed')
}

function verify() {
  const bin = join(RUNTIME_DIR, 'app', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
  if (!existsSync(bin)) throw new Error(`dsh entry missing after install: ${bin}`)
  const exe = join(RUNTIME_DIR, IS_WINDOWS ? 'node.exe' : 'node')
  if (!existsSync(exe)) throw new Error(`node executable missing: ${exe}`)
  return { node: NODE_VERSION, dsh: DSH_VERSION }
}

function alreadyPrepared(target) {
  const versionFile = join(RUNTIME_DIR, 'version.json')
  if (!existsSync(versionFile)) return false
  try {
    const v = JSON.parse(readFileSync(versionFile, 'utf8'))
    return v.node === NODE_VERSION && v.dsh === DSH_VERSION && v.target === target
  } catch {
    return false
  }
}

async function main() {
  const { target: rawTarget, force } = parseArgs(process.argv.slice(2))
  const target = rawTarget ?? detectTarget()
  log(`target=${target} node=${NODE_VERSION} dsh=${DSH_VERSION} force=${force}`)

  const dist = NODE_DIST[target]
  if (dist === undefined) throw new Error(`no Node dist for target triple: ${target}`)

  if (!force && alreadyPrepared(target)) {
    log('runtime already prepared for this target; pass --force to rebuild')
    return
  }

  rmSync(RUNTIME_DIR, { recursive: true, force: true })
  mkdirSync(RUNTIME_DIR, { recursive: true })

  const archive = join(RUNTIME_DIR, `${dist.file}.dwl`)
  await downloadNodeArchive(dist.file, archive)
  await extractNodeArchive(archive, target, dist.exe)
  rmSync(archive, { force: true })

  installDsh()
  const versions = verify()
  writeFileSync(
    join(RUNTIME_DIR, 'version.json'),
    JSON.stringify(
      {
        node: versions.node,
        dsh: versions.dsh,
        target,
        preparedAt: new Date().toISOString(),
      },
      null,
      2,
    ) + '\n',
  )
  log('done ->', RUNTIME_DIR)
}

main().catch((err) => {
  console.error('[prepare-runtime] FAILED:', err.message)
  process.exit(1)
})