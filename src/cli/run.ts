import { randomUUID } from 'node:crypto'
import { parseTuiArgs, type TuiOptions } from '../main/tui'
import { parseHeadlessArgs, type HeadlessOptions } from '../main/headless'
import { parseAcpArgs } from '../main/acp'
import {
  readAllStdin,
  runTuiEntry,
  runHeadlessEntry,
  runAcpEntry,
  runScheduleDaemonEntry,
  stdinIsPiped
} from '../main/terminalEntry'
import { existsSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import {
  disableScheduleDaemon,
  installLoginAgent,
  realLoginAgentDeps,
  scheduleDaemonState,
  type DaemonCommand
} from '../main/loginAgent'
import { runningDaemonPid } from '../main/scheduleDaemon'
import { runScheduleDaemonCommand } from './scheduleDaemon'
import { configureAgentHost } from '../main/agentHost'
import {
  addPermissionRule,
  updateSettings,
  configureFreshInstallApprovalPolicy,
  configureHasKey,
  configureHeaderSecrets,
  configureMcpOAuthPresence,
  configureRemoveKey,
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
import { runDoctorCommand } from './doctor'
import { runMcpCliCommand } from './mcp'
import { runUpdateCommand, type UpgradeStep } from './update'
import { terminalDoctorFacts } from '../main/terminalEntry'
import { disconnectAllMcp, reconnectMcpServers } from '../main/mcp/manager'
import { runMcpOAuthFlow } from '../main/mcp/oauth'
import { canStoreMcpOAuth, setMcpOAuth } from '../main/agentHost'
import { checkForUpdate, checkForUpdateNow } from '../main/update-check'
import { currentInstallMethod, upgradeHint } from '../main/install-method'
import { renderDoctor } from '../main/tui-doctor'
import { makePainter, type Painter } from '../main/tui'
import { resolveColor } from '../main/tui-io'
import { plainText, resolveAccessibility } from '../main/tui-a11y'
import { spawn } from 'node:child_process'
import type { McpServerConfig } from '@shared/types'
import { deferTrustSystemCertificates } from '../main/system-ca'
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

/**
 * Wire the Node-side host capabilities. Must run before any settings read. Returns the
 * deferred read of the system certificate store, for the interactive client to run once
 * its prompt is drawn.
 */
export function wireCliHost(): { trustCertificatesNow: () => void } {
  setUserDataDir(resolveUserDataDir())
  // Record background shells in the profile and stop any a crashed session left running.
  void startShellLedger(resolveUserDataDir())
  // Before any provider call: a TLS-inspecting network's root CA lives in the OS store.
  // Reading it takes tens of milliseconds, so it waits: the TUI reads it once its prompt
  // is on screen, and until then the first TLS connection reads it before connecting.
  const trustCertificatesNow = deferTrustSystemCertificates()
  // Provider, MCP and search traffic honours the proxy setting or HTTPS_PROXY.
  configureOutboundProxy(() => getSettings().proxyUrl)
  configureHasKey((id) => cliHasKey(id))
  // A fresh install starts in full-auto only where the sandbox confines shell commands.
  configureFreshInstallApprovalPolicy(() => freshInstallApprovalPolicy(isSandboxed()))
  // In-session key writes (the TUI's /login flow) land in cli-credentials.json,
  // the same store `houston providers set-key` uses.
  configureSetKey((id, key) => cliSetKey(id, key))
  configureRemoveKey((id) => cliRemoveKey(id))
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
  return { trustCertificatesNow }
}

/**
 * A Homebrew keg path (`<prefix>/Cellar/<formula>/<version>/...`) as the formula's
 * stable link (`<prefix>/opt/<formula>/...`), which follows upgrades while the keg is
 * removed by them. Any other path, or a keg whose link is missing, is kept as it is.
 */
export function stableLauncherPath(p: string, exists: (p: string) => boolean = existsSync): string {
  const m = /^(.*)\/Cellar\/([^/]+)\/[^/]+\/(.+)$/.exec(p)
  if (!m) return p
  const stable = `${m[1]}/opt/${m[2]}/${m[3]}`
  return exists(stable) ? stable : p
}

export interface CliDaemonCommandDeps {
  execPath?: string
  /** The script this CLI was started with (argv[1]). */
  script?: string
  env?: NodeJS.ProcessEnv
  realpath?: (p: string) => string
  exists?: (p: string) => boolean
}

/**
 * What the terminal daemon's login agent starts: this same CLI (the Node binary and
 * the script it runs, resolved through any npm symlink) in `schedule-daemon run` mode,
 * with the profile override when one is set. Both paths are recorded through a
 * Homebrew formula's stable link when they resolve into a versioned keg, so the agent
 * survives `brew upgrade`.
 */
export function cliDaemonCommand(deps: CliDaemonCommandDeps = {}): DaemonCommand {
  const exists = deps.exists ?? existsSync
  const script = stableLauncherPath((deps.realpath ?? realpathSync)(deps.script ?? process.argv[1]!), exists)
  const env = deps.env ?? process.env
  const dataDir = env.HOUSTON_DATA_DIR?.trim()
  return {
    program: stableLauncherPath(deps.execPath ?? process.execPath, exists),
    args: [script, 'schedule-daemon', 'run'],
    ...(dataDir ? { env: { HOUSTON_DATA_DIR: dataDir } } : {}),
    logFile: join(resolveUserDataDir({ env }), 'schedule-daemon.out.log')
  }
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
  const { trustCertificatesNow } = wireCliHost()

  // `houston doctor|mcp|update …`: matched only as the very first argument, like
  // `open`, so a prompt that is one of these words (`-p doctor`) still runs as a prompt.
  const first = argv[2]
  if (first === 'doctor') return runDoctorCommand(argv.slice(3), doctorDeps(version))
  if (first === 'mcp') return runMcpCliCommand(argv.slice(3), mcpDeps())
  if (first === 'update') return runUpdateCommand(argv.slice(3), updateDeps(version))

  // `houston providers …` — manage providers/keys before the run-mode parsers,
  // which only match `-i`/`-p`. Matched as the first positional so flags before it
  // don't hide it.
  const positionals = argv.slice(2).filter((a) => !a.startsWith('-'))
  if (positionals[0] === 'providers') {
    return runProvidersCommand(argv.slice(argv.indexOf('providers') + 1), providersDeps())
  }
  if (positionals[0] === 'schedule-daemon') {
    const loginDeps = realLoginAgentDeps()
    return runScheduleDaemonCommand(argv.slice(argv.indexOf('schedule-daemon') + 1), {
      run: () => runScheduleDaemonEntry({ version }),
      install: (cmd) => installLoginAgent(cmd, loginDeps),
      uninstall: () => disableScheduleDaemon(loginDeps, () => runningDaemonPid()),
      state: () => scheduleDaemonState(loginDeps, () => runningDaemonPid()),
      command: () => cliDaemonCommand(),
      out: (s) => void process.stdout.write(s),
      err: (s) => void process.stderr.write(s)
    })
  }
  const problem = argvProblem(argv.slice(2))
  if (problem) {
    process.stderr.write(problem)
    return 2
  }

  const mode = selectRunMode(argv, process.cwd(), Boolean(process.stdin.isTTY), stdinIsPiped())
  if (mode.kind === 'acp') {
    const launch = parseAcpArgs(argv.slice(2))
    if ('error' in launch) {
      process.stderr.write(`houston: ${launch.error}\n`)
      return 2
    }
    return runAcpEntry({ version }, launch)
  }
  if (mode.kind === 'tui') return runTuiEntry(mode.options, { version, afterFirstPrompt: trustCertificatesNow })
  if (mode.kind === 'headless') return runHeadlessEntry(mode.options, { version })

  process.stderr.write(usage)
  return 2
}

/**
 * Output for the subcommands that print reports (`doctor`, `mcp`, `update`): color only
 * at a terminal that wants it, and in screen-reader mode (the flag's env var or the
 * saved setting) plain lines with status marks spoken as words. Progress goes to
 * stderr, and only at a terminal, so a script reading stdout gets the report alone.
 */
function subcommandIo(): {
  paint: Painter
  color: boolean
  text: (s: string) => string
  out: (s: string) => void
  err: (s: string) => void
  progress?: (message: string) => void
} {
  const { screenReader } = resolveAccessibility({}, process.env, getSettings())
  const color = !screenReader && resolveColor(process.env, Boolean(process.stdout.isTTY))
  const text = (s: string): string => (screenReader ? plainText(s) : s)
  return {
    paint: makePainter(color),
    color,
    text,
    out: (s) => void process.stdout.write(text(s)),
    err: (s) => void process.stderr.write(text(s)),
    ...(process.stderr.isTTY ? { progress: (m: string) => void process.stderr.write(text(`${m}\n`)) } : {})
  }
}

/** Connect each named server now, and close every connection once it has answered. */
async function connectOnce(all: McpServerConfig[], ids: string[]): ReturnType<typeof reconnectMcpServers> {
  try {
    return await reconnectMcpServers(all, ids)
  } finally {
    disconnectAllMcp()
  }
}

/** Host wiring for `houston doctor`: the interactive /doctor's facts, with MCP servers connected first. */
function doctorDeps(version: string): Parameters<typeof runDoctorCommand>[1] {
  const io = subcommandIo()
  return {
    facts: async () => {
      const servers = getSettings().mcpServers ?? []
      const enabled = servers.filter((m) => m.enabled && m.id && (m.command || m.url)).map((m) => m.id)
      try {
        const [update] = await Promise.all([
          checkForUpdate(version),
          enabled.length ? reconnectMcpServers(servers, enabled) : null
        ])
        const hint = upgradeHint(currentInstallMethod()).fix
        // Read while the connections are up: closing them forgets their statuses.
        return terminalDoctorFacts(process.cwd(), version, io.color, update ? { ...update, hint } : null)
      } finally {
        disconnectAllMcp()
      }
    },
    // JSON goes out untouched; the painted report gets the screen-reader treatment.
    render: (report) => io.text(renderDoctor(report, io.paint)),
    out: (s) => void process.stdout.write(s),
    err: io.err,
    ...(io.progress ? { progress: io.progress } : {})
  }
}

/** Host wiring for `houston mcp`: the shared settings, the manager, and the OAuth store. */
function mcpDeps(): Parameters<typeof runMcpCliCommand>[1] {
  const io = subcommandIo()
  return {
    servers: () => getSettings().mcpServers ?? [],
    save: (mcpServers) => void updateSettings({ mcpServers }),
    connect: (servers) => connectOnce(getSettings().mcpServers ?? [], servers.map((s) => s.id)),
    ...(canStoreMcpOAuth()
      ? {
          login: async (server: McpServerConfig, onStatus: (m: string) => void) => {
            const tokens = await runMcpOAuthFlow(server.url ?? '', { onStatus })
            setMcpOAuth(server.id, tokens)
          },
          logout: (serverId: string) => setMcpOAuth(serverId, null)
        }
      : {}),
    paint: io.paint,
    out: io.out,
    err: io.err,
    ...(io.progress ? { progress: io.progress } : {})
  }
}

/**
 * Run one upgrade step with the terminal attached. No shell: the program and its fixed
 * arguments go straight to the OS. Windows runs npm and bun through `.cmd` shims, which
 * only a shell can start, so there (and only there) it goes through cmd with the same
 * fixed words, none of which come from the network or the user.
 */
export function runUpgradeStep(step: UpgradeStep): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(step.program, step.args, { stdio: 'inherit', shell: process.platform === 'win32' })
    child.on('error', reject)
    child.on('exit', (code, signal) => resolve(code ?? (signal ? 1 : 0)))
  })
}

/** Host wiring for `houston update`. */
function updateDeps(version: string): Parameters<typeof runUpdateCommand>[1] {
  const io = subcommandIo()
  const method = currentInstallMethod()
  return {
    version,
    method,
    hint: upgradeHint(method),
    check: () => checkForUpdateNow(version),
    run: runUpgradeStep,
    out: io.out,
    err: io.err
  }
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
