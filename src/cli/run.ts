import { randomUUID } from 'node:crypto'
import { parseTuiArgs, type TuiOptions } from '../main/tui'
import { parseHeadlessArgs, type HeadlessOptions } from '../main/headless'
import { readAllStdin, runTuiEntry, runHeadlessEntry, runAcpEntry, stdinIsPiped } from '../main/terminalEntry'
import { configureAgentHost } from '../main/agentHost'
import {
  addPermissionRule,
  configureFreshInstallApprovalPolicy,
  configureHasKey,
  configureHeaderSecrets,
  configureMcpOAuthPresence,
  configureSetKey,
  getProvider,
  getSettings,
  saveSettings,
  setModelUnavailable
} from '../main/store'
import { setUserDataDir } from '../main/userData'
import { isSandboxed } from '../main/sandbox'
import { freshInstallApprovalPolicy } from '@shared/defaults'
import { configureLogRedactor } from '../main/logger'
import { configureTitleRedaction } from '../main/conversations'
import { redactSecrets } from '../main/agent/redact'
import { resolveUserDataDir } from './paths'
import { startShellLedger } from '../main/agent/shellLedger'
import {
  cliCollectSecrets,
  cliGetHeaders,
  cliGetKey,
  cliGetMcpOAuth,
  cliHasKey,
  cliRemoveKey,
  cliSetKey,
  cliSetMcpOAuth
} from './credentials'
import { runProvidersCommand, type ProvidersDeps } from './providers'
import { trustSystemCertificates } from '../main/system-ca'
import { configureOutboundProxy } from '../main/outbound-proxy'
import { noteRuleUsed } from '../main/ruleUsage'

export { log } from '../main/logger'
export { flushRuleUsage } from '../main/ruleUsage'

/**
 * The standalone CLI's real work: host wiring and the run modes (interactive,
 * one-shot, ACP, `providers`). Kept out of the entry (index.ts), which loads this
 * module only after `-h`/`-v` and the Node version check, so `houston --version`
 * answers without evaluating the agent core, the store, or the TUI.
 */

/** Wire the Node-side host capabilities. Must run before any settings read. */
export function wireCliHost(): void {
  setUserDataDir(resolveUserDataDir())
  // Record background shells in the profile and stop any a crashed session left running.
  void startShellLedger(resolveUserDataDir())
  // Before any provider call: a TLS-inspecting network's root CA lives in the OS store.
  trustSystemCertificates()
  // Provider, MCP and search traffic honours the proxy setting or HTTPS_PROXY.
  configureOutboundProxy(() => getSettings().proxyUrl)
  configureHasKey((id) => cliHasKey(id))
  // A fresh install starts in full-auto only where the sandbox confines shell commands.
  configureFreshInstallApprovalPolicy(() => freshInstallApprovalPolicy(isSandboxed()))
  // In-session key writes (the TUI's /login flow) land in cli-credentials.json,
  // the same store `houston providers set-key` uses.
  configureSetKey((id, key) => cliSetKey(id, key))
  // Scrub stored secrets (and token-shaped strings) from every log line.
  configureLogRedactor((message) => redactSecrets(message, cliCollectSecrets()))
  // Known-value source for redacting derived conversation titles.
  configureTitleRedaction(() => cliCollectSecrets())
  // Header secrets come from cli-headers.json (see cliGetHeaders); the CLI has no UI
  // that writes them, so set/remove are no-ops — settings saves just preserve the keys.
  configureHeaderSecrets({
    get: (scope) => cliGetHeaders(scope),
    set: () => {},
    remove: () => {},
    writable: false
  })
  // The derived `hasOAuth` flag on MCP server configs (drives /mcp's sign-in hints).
  configureMcpOAuthPresence((serverId) => cliGetMcpOAuth(serverId) !== null)
  configureAgentHost({
    getProvider,
    getSettings,
    addPermissionRule,
    getKey: (id) => cliGetKey(id),
    hasStoredKey: (id) => cliHasKey(id),
    getSecretHeaders: (scope) => cliGetHeaders(scope),
    collectSecrets: () => cliCollectSecrets(),
    getMcpOAuth: (serverId) => cliGetMcpOAuth(serverId),
    setMcpOAuth: (serverId, tokens) => cliSetMcpOAuth(serverId, tokens),
    setModelUnavailable,
    // When each permission rule last decided a call (rule-usage.json, shared with the
    // desktop app), so Settings shows rules used from the terminal as used.
    noteRuleUsed
  })
}

export interface RunCliOptions {
  version: string
  /** Printed when nothing selects a mode. */
  usage: string
  /** The error text for a malformed run-mode command line (everything after `houston`), or null. */
  argvProblem: (args: string[]) => string | null
}

/**
 * Run a real CLI invocation (anything but `-h`/`-v`/`open`) and return its exit code.
 */
export async function runCli(argv: string[], { version, usage, argvProblem }: RunCliOptions): Promise<number> {
  wireCliHost()

  // `houston providers …` — manage providers/keys before the run-mode parsers,
  // which only match `-i`/`-p`. Matched as the first positional so flags before it
  // don't hide it.
  const positionals = argv.slice(2).filter((a) => !a.startsWith('-'))
  if (positionals[0] === 'providers') {
    return runProvidersCommand(argv.slice(argv.indexOf('providers') + 1), providersDeps())
  }
  const problem = argvProblem(argv.slice(2))
  if (problem) {
    process.stderr.write(problem)
    return 2
  }

  const mode = selectRunMode(argv, process.cwd(), Boolean(process.stdin.isTTY), stdinIsPiped())
  if (mode.kind === 'acp') return runAcpEntry({ version })
  if (mode.kind === 'tui') return runTuiEntry(mode.options, { version })
  if (mode.kind === 'headless') return runHeadlessEntry(mode.options, { version })

  process.stderr.write(usage)
  return 2
}

/** Host wiring for the `providers` subcommand (real store + credential file). */
function providersDeps(): ProvidersDeps {
  return {
    getSettings,
    saveSettings,
    hasKey: (id) => cliHasKey(id),
    setKey: (id, key) => cliSetKey(id, key),
    removeKey: (id) => cliRemoveKey(id),
    out: (s) => process.stdout.write(s),
    err: (s) => process.stderr.write(s),
    isMac: process.platform === 'darwin',
    newId: () => randomUUID(),
    // Only consume stdin when it's piped — a TTY would block waiting for input.
    readStdin: async () => (process.stdin.isTTY ? null : readAllStdin())
  }
}

export type RunMode =
  | { kind: 'acp' }
  | { kind: 'tui'; options: TuiOptions }
  | { kind: 'headless'; options: HeadlessOptions }
  | { kind: 'usage' }

/**
 * Decide what a standalone-CLI invocation runs, once `-h`/`-v`/node-version have
 * been ruled out. Explicit modes stay explicit — `--acp` first, then `-i` (or
 * `--interactive`/`--tui`), then `-p` — but unlike the desktop binary (where a bare launch opens the
 * GUI), a bare `houston` at a TTY defaults to interactive, so typing `houston`
 * alone drops into the REPL just like `houston -i`. A bare invocation with a prompt
 * piped in (`echo "fix the build" | houston --json`) is a one-shot run reading it.
 * One with no TTY and nothing piped (CI with no input, cron) has nowhere to host a
 * REPL, so it falls to usage rather than hanging on input that will never arrive.
 * Pure — takes the TTY and pipe facts as input — so the whole decision is
 * unit-testable.
 */
export function selectRunMode(argv: string[], cwd: string, isTTY: boolean, stdinPiped = false): RunMode {
  // An editor launching the agent: stdin and stdout are its protocol channel.
  if (argv.includes('--acp')) return { kind: 'acp' }
  const tui = parseTuiArgs(argv, cwd)
  if (tui) return { kind: 'tui', options: tui }
  const headless = parseHeadlessArgs(argv, cwd, { stdinPiped, bareStdinPrompt: true })
  if (headless) return { kind: 'headless', options: headless }
  // No explicit mode: a bare `houston`. Interactive on a real terminal, else usage.
  if (isTTY) return { kind: 'tui', options: parseTuiArgs(argv, cwd, true)! }
  return { kind: 'usage' }
}
