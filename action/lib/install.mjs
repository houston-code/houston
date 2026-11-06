// The action's "Install the Houston CLI" step: download the pinned release's CLI and its
// signed checksums into a fresh directory, verify them (lib/verify.mjs), and hand the
// verified path to the run step. Nothing from the download runs before it verifies.

import { appendFileSync, chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { CLI_ASSET, SIGNED_ASSETS, assetUrl, parseVersion, verifyRelease } from './verify.mjs'

const here = dirname(fileURLToPath(import.meta.url))
/** The action directory (action/), and the repository root above it. */
export const ACTION_DIR = resolve(here, '..')
const MAX_ASSET_BYTES = 64 * 1024 * 1024

export function pinnedRelease() {
  return JSON.parse(readFileSync(join(ACTION_DIR, 'cli-release.json'), 'utf8'))
}

/** Attempts per asset; the waits between them are RETRY_DELAYS_MS. */
export const RETRY_DELAYS_MS = [2000, 5000, 10000]
const realSleep = (ms) => delay(ms)

/** A status worth retrying: the release CDN's gateway errors and throttling, not a missing asset. */
function transient(status) {
  return status === 408 || status === 429 || status >= 500
}

async function download(fetchImpl, url, dest, { sleep = realSleep, log = () => {} } = {}) {
  for (let attempt = 0; ; attempt++) {
    let failure
    try {
      const res = await fetchImpl(url, { redirect: 'follow' })
      if (res.ok) {
        const body = Buffer.from(await res.arrayBuffer())
        if (body.length > MAX_ASSET_BYTES) throw Object.assign(new Error(`${url} is larger than expected`), { final: true })
        writeFileSync(dest, body)
        return
      }
      failure = new Error(`downloading ${url} failed: HTTP ${res.status}`)
      if (!transient(res.status)) failure.final = true
    } catch (e) {
      if (e?.final) throw e
      // fetch itself threw: a reset connection, DNS hiccup, or a body cut off mid-stream.
      failure = new Error(`downloading ${url} failed: ${e?.message ?? e}`)
    }
    if (failure.final || attempt >= RETRY_DELAYS_MS.length) throw failure
    log(`${failure.message}; retrying in ${RETRY_DELAYS_MS[attempt] / 1000}s`)
    await sleep(RETRY_DELAYS_MS[attempt])
  }
}

export async function install({
  env,
  exec,
  fetchImpl = fetch,
  log = (s) => process.stdout.write(`${s}\n`),
  platform = process.platform,
  sleep = realSleep
}) {
  // No OS sandbox for shell commands, and gpg there is an MSYS build that misreads native
  // paths, so the signature check can't be trusted to run as written.
  if (platform === 'win32') throw new Error('Windows runners are not supported: use a Linux or macOS runner')
  const pinned = pinnedRelease()
  const version = parseVersion((env.HOUSTON_INPUT_CLI_VERSION ?? '').trim() || pinned.version)
  const base = env.RUNNER_TEMP && isAbsolute(env.RUNNER_TEMP) ? env.RUNNER_TEMP : join(homedir(), '.houston-action')
  mkdirSync(base, { recursive: true })
  const dir = mkdtempSync(join(base, `houston-cli-${version}-`))
  const gnupgHome = mkdtempSync(join(base, 'houston-gnupg-'))
  chmodSync(gnupgHome, 0o700)

  log(`Downloading Houston CLI v${version}`)
  for (const name of SIGNED_ASSETS) await download(fetchImpl, assetUrl(version, name), join(dir, name), { sleep, log })

  const hasCosign = (await exec('cosign', ['version'])).code === 0
  const { sha256, checked } = await verifyRelease({
    dir,
    version,
    pinned,
    keyPath: join(ACTION_DIR, '..', 'houston-signing-key.asc'),
    gnupgHome,
    run: exec,
    hasCosign
  })
  log(`Verified ${CLI_ASSET} v${version} (${checked.join(', ')}): sha256 ${sha256}`)
  if (!hasCosign) log('cosign is not installed, so only the GPG signature was checked (either one is enough)')

  const cli = join(dir, CLI_ASSET)
  const node = env.HOUSTON_NODE || process.execPath
  const ver = await exec(node, [cli, '--version'])
  if (ver.code !== 0 || ver.stdout.trim() !== version) {
    throw new Error(`the verified CLI reports version ${JSON.stringify(ver.stdout.trim())}, expected ${version}`)
  }
  if (env.GITHUB_OUTPUT) appendFileSync(env.GITHUB_OUTPUT, `cli-path=${cli}\ncli-version=${version}\n`)
  return { cli, version, sha256, checked }
}
