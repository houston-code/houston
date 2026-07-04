import { parseTuiArgs } from '../main/tui'
import { parseHeadlessArgs } from '../main/headless'
import { runTuiEntry, runHeadlessEntry } from '../main/terminalEntry'
import { configureAgentHost } from '../main/agentHost'
import {
  addPermissionRule,
  configureHasKey,
  configureHeaderSecrets,
  getProvider,
  getSettings
} from '../main/store'
import { setUserDataDir } from '../main/userData'
import { configureLogRedactor, log } from '../main/logger'
import { redactSecrets } from '../main/agent/redact'
import { resolveUserDataDir } from './paths'
import { cliCollectSecrets, cliGetHeaders, cliGetKey, cliHasKey } from './credentials'

/**
 * Standalone CLI entry — the interactive TUI (`-i`) and one-shot headless (`-p`)
 * clients as a plain Node program, no Electron (and so no Chromium, no display
 * server). It reuses the exact client wiring the desktop app boots
 * (terminalEntry.ts) after swapping in Node-side host capabilities:
 *
 *   - profile dir: the same per-platform path Electron resolves (paths.ts), so
 *     settings and conversations are shared with the desktop app when both are
 *     installed; `HOUSTON_DATA_DIR` isolates a profile.
 *   - credentials: env-first with an optional credentials file (credentials.ts) —
 *     Electron's safeStorage needs a running desktop app and an OS keyring.
 *
 * Capabilities that require Chromium stay desktop-only: `view_localhost`
 * (offscreen screenshot) needs a capture backend the CLI never wires, so the loop
 * omits it from the toolset entirely — the agent isn't offered a tool it can't
 * use. The build (scripts/build-cli.mjs) fails if `electron` ever sneaks into this
 * entry's module graph.
 */

// Injected by the build (scripts/build-cli.mjs); absent under tsc/vitest.
declare const __HOUSTON_VERSION__: string | undefined

const VERSION = typeof __HOUSTON_VERSION__ === 'string' ? __HOUSTON_VERSION__ : 'dev'

/** Node major this build targets (esbuild `target: node22`); older crashes cryptically. */
const MIN_NODE_MAJOR = 22

/**
 * The bundle is emitted for Node 22, and `engines` doesn't govern a downloaded
 * `.cjs`, so guard the runtime explicitly: an old Node otherwise dies with an
 * opaque syntax/API error. Pure (takes the version string) so it's unit-testable.
 * Returns an error message, or null when the runtime is new enough / unparseable.
 */
export function nodeVersionError(nodeVersion: string, min = MIN_NODE_MAJOR): string | null {
  const major = Number.parseInt(nodeVersion.replace(/^v/, '').split('.')[0] ?? '', 10)
  if (Number.isNaN(major)) return null // unrecognizable version — don't block on it
  if (major < min) {
    return `Houston CLI requires Node ${min} or newer (this is ${nodeVersion}). Install Node ${min}+ and re-run.`
  }
  return null
}

export const USAGE = `Houston CLI ${VERSION} — coding agent in your terminal (no desktop app required).

Usage:
  houston -i [options]                 stay-resident interactive session
  houston -p "<prompt>" [options]      one-shot run; assistant text on stdout

Options:
  --cwd <dir>          project folder (default: the current directory)
  --provider <id>      provider id from your settings (default: your selection)
  --model <id>         model id (default: your selection)
  --approval <policy>  plan | ask | auto-edit | full-auto
  --accept-terms       accept the terms on first use of this profile
  --json               (-p) machine-readable: one JSON event per line
  --continue           (-p) resume the folder's most recent session
  --resume <id>        (-p) resume a specific session
  -h, --help           this help
  -v, --version        print the version

Credentials (checked in this order):
  ANTHROPIC_API_KEY / OPENAI_API_KEY / GEMINI_API_KEY / HOUSTON_API_KEY_<ID>
  <profile>/cli-credentials.json — {"<provider-id>": "<key>"} with 0600 perms

Custom provider/MCP auth headers (optional):
  <profile>/cli-headers.json — {"provider:<id>"|"mcp:<id>": {"<Header>": "<value>"}} with 0600 perms

Profile: shared with the desktop app; override with HOUSTON_DATA_DIR.
`

/** Wire the Node-side host capabilities. Must run before any settings read. */
export function wireCliHost(): void {
  setUserDataDir(resolveUserDataDir())
  configureHasKey((id) => cliHasKey(id))
  // Scrub stored secrets (and token-shaped strings) from every log line.
  configureLogRedactor((message) => redactSecrets(message, cliCollectSecrets()))
  // Header secrets come from cli-headers.json (see cliGetHeaders); the CLI has no UI
  // that writes them, so set/remove are no-ops — settings saves just preserve the keys.
  configureHeaderSecrets({
    get: (scope) => cliGetHeaders(scope),
    set: () => {},
    remove: () => {}
  })
  configureAgentHost({
    getProvider,
    getSettings,
    addPermissionRule,
    getKey: (id) => cliGetKey(id),
    hasStoredKey: (id) => cliHasKey(id),
    getSecretHeaders: (scope) => cliGetHeaders(scope),
    collectSecrets: () => cliCollectSecrets()
  })
}

async function main(): Promise<number> {
  const argv = process.argv
  if (argv.includes('-h') || argv.includes('--help')) {
    process.stdout.write(USAGE)
    return 0
  }
  if (argv.includes('-v') || argv.includes('--version')) {
    process.stdout.write(`${VERSION}\n`)
    return 0
  }

  // Checked after -h/-v (those stay useful on any Node) but before any real work.
  const versionError = nodeVersionError(process.version)
  if (versionError) {
    process.stderr.write(`${versionError}\n`)
    return 1
  }

  wireCliHost()

  // Same mode selection as the desktop binary: `-i` wins, then `-p`; anything
  // else is usage (the desktop app opens the GUI here — the CLI has none).
  const tui = parseTuiArgs(argv, process.cwd())
  const headless = tui ? null : parseHeadlessArgs(argv, process.cwd())
  if (tui) return runTuiEntry(tui)
  if (headless) return runHeadlessEntry(headless)

  process.stderr.write(USAGE)
  return 2
}

/** True when this module is the executed entry (bundled CLI), not an import. */
function isDirectRun(): boolean {
  return typeof require !== 'undefined' && require.main === module
}

if (isDirectRun()) {
  // Mirror the desktop headless path's fatal handling: log, one-line stderr, exit.
  process.on('uncaughtException', (err) => {
    log.error('uncaughtException', err)
    process.stderr.write(`Fatal: ${err instanceof Error ? err.message : String(err)}\n`)
    process.exit(1)
  })
  process.on('unhandledRejection', (reason) => {
    log.error('unhandledRejection', reason)
    process.stderr.write(`Fatal: ${reason instanceof Error ? reason.message : String(reason)}\n`)
    process.exit(1)
  })

  void main().then(
    (code) => process.exit(code),
    (e) => {
      process.stderr.write(`Fatal: ${(e as Error).message}\n`)
      process.exit(1)
    }
  )
}
