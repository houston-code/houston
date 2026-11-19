import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { accessSync, constants as fsConstants, existsSync, realpathSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { posix } from 'node:path'
import type { EgressProxyEndpoints, SandboxBackend, ShellLaunch } from './contract'
import { EGRESS_PROXY_INNER_PORT, egressProxyEnv, egressProxyUrl } from './egress-proxy'
import { resolvePosixShell } from './shared'

/**
 * Linux bubblewrap (`bwrap`) backend.
 *
 * Reproduces the macOS Seatbelt contract with an unprivileged user namespace:
 *   - `--ro-bind / /` mounts the whole host filesystem read-only (read-everywhere),
 *   - `--bind <root> <root>` re-binds each writable root (and the temp dirs) read-write
 *     over the read-only base, so writes are confined to exactly that set,
 *   - a fresh `--dev /dev` and `--proc /proc` provide the device/proc nodes tools need
 *     without exposing the host's,
 *   - `--unshare-net` (when network is denied) drops the command into an empty network
 *     namespace — loopback only, no egress, no DNS — matching the Seatbelt network gate,
 *   - `--unshare-pid/-ipc/-uts` + `--die-with-parent` isolate and tie the lifetime of
 *     the sandbox to ours. Killing the host-side `bwrap` process group tears the whole
 *     PID namespace down atomically, so the existing process-group kill reaps everything.
 *
 * Proxied egress (network granted + egress allowlist active) KEEPS `--unshare-net`:
 * the namespace still has no route out, so direct egress stays impossible, and the
 * only road to the network is the egress proxy. The host's loopback is invisible
 * from inside the namespace, so the proxy is reached through its unix socket
 * (which crosses the boundary via the temp-dir bind): a small forwarder runs as
 * the bwrap entrypoint, listens on 127.0.0.1:EGRESS_PROXY_INNER_PORT inside the
 * namespace (bwrap brings the namespaced loopback up), bridges each connection
 * into the unix socket, and execs the real command once the bridge is listening —
 * see FORWARDER_SOURCE in egress-proxy.ts. The forwarder runs under the Electron
 * binary with ELECTRON_RUN_AS_NODE=1 (plain Node semantics; the variable is
 * scrubbed from the command's own environment).
 *
 * Where bubblewrap isn't usable (not installed, or unprivileged user namespaces are
 * disabled by the kernel/AppArmor), `selectBackend` falls back to the unconfined
 * backend, which reports `sandboxed: false` so the approval gate steps in.
 */

/** realpath a path, falling back to the input when it can't be resolved. */
export function realpathOrSelf(p: string): string {
  try {
    return realpathSync(p)
  } catch {
    return p
  }
}

/** Choose the shell to exec inside the sandbox: a real bash when present (searched
 *  across the standard locations), else POSIX sh. See {@link resolvePosixShell}. */
export function bwrapShell(exists: (p: string) => boolean = existsSync): string {
  return resolvePosixShell(exists).shell
}

/**
 * The temp dirs that must be writable inside the sandbox: the resolved `tmpdir()`,
 * plus `/tmp` and `$TMPDIR` when they resolve to something distinct. This is the
 * Linux analogue of the Seatbelt temp set — deliberately NOT including `/run/user`,
 * so the writable surface matches the contract exactly.
 */
export function linuxTmpDirs(env: NodeJS.ProcessEnv = process.env): string[] {
  const dirs = [tmpdir(), '/tmp']
  if (env.TMPDIR) dirs.push(env.TMPDIR)
  return dirs
}

/**
 * Filter a list of paths to the existing, canonical, de-duplicated set. Non-existent
 * paths are dropped (bind sources must exist); paths are realpath'd (bind sources must
 * be canonical for the rw layer to cover what the command actually writes); exact
 * duplicates are removed. Nested paths are intentionally NOT collapsed — overlapping
 * read-write binds are harmless.
 */
export function dedupeExisting(
  paths: string[],
  deps: { exists?: (p: string) => boolean; realpath?: (p: string) => string } = {}
): string[] {
  const exists = deps.exists ?? existsSync
  const realpath = deps.realpath ?? realpathOrSelf
  const seen = new Set<string>()
  const out: string[] = []
  for (const p of paths) {
    if (!p || !exists(p)) continue
    const real = realpath(p)
    if (seen.has(real)) continue
    seen.add(real)
    out.push(real)
  }
  return out
}

export interface BwrapArgsInput {
  /** Writable roots — already filtered to existing canonical paths (see dedupeExisting). */
  roots: string[]
  /** Writable temp dirs — already filtered to existing canonical paths. */
  tmpDirs: string[]
  allowNetwork: boolean
  /** Egress proxy endpoints; with allowNetwork:true switches the launch to proxied mode. */
  egressProxy?: EgressProxyEndpoints
  /** Node-capable binary that runs the forwarder (production: process.execPath). */
  nodeBin?: string
  command: string
  cwd: string
  shell?: string
}

/** True when this launch runs in proxied-egress mode (see the module docs). */
function proxiedMode(input: Pick<BwrapArgsInput, 'allowNetwork' | 'egressProxy'>): boolean {
  return (
    input.allowNetwork &&
    input.egressProxy?.unixSocketPath !== undefined &&
    input.egressProxy?.forwarderPath !== undefined
  )
}

/**
 * Build the `bwrap` argv that reproduces the Seatbelt write/read/network contract.
 * Pure string assembly (no filesystem access) — the caller pre-resolves roots/tmpDirs
 * via {@link dedupeExisting}, so this is fully unit-testable with arbitrary paths.
 *
 * Order matters: the writable `--bind`s come AFTER `--ro-bind / /`, so the read-write
 * layer wins for those subtrees. `command` is passed as a single argv element to
 * `shell -c`, never interpolated into a shell string — no injection surface.
 */
export function buildBwrapArgs(input: BwrapArgsInput): string[] {
  const shell = input.shell ?? '/bin/bash'
  const args: string[] = [
    // read EVERYWHERE: host / mounted read-only as the base layer
    '--ro-bind',
    '/',
    '/',
    // a fresh minimal /dev (null, zero, (u)random, full, tty, std-fd links)
    '--dev',
    '/dev',
    // procfs in the new pid namespace
    '--proc',
    '/proc',
    // process / namespace isolation; die-with-parent needs unshare-pid to reap the tree
    '--unshare-pid',
    '--unshare-ipc',
    '--unshare-uts',
    '--die-with-parent',
    // start directory inside the namespace
    '--chdir',
    input.cwd
  ]

  // Network gate: an empty net namespace (loopback only) when denied OR proxied —
  // in proxied mode the forwarder below is the only bridge out. The namespace is
  // shared with the host only for a full (mode 'all') grant.
  const proxied = proxiedMode(input)
  if (!input.allowNetwork || proxied) args.push('--unshare-net')

  // writable ONLY in roots + temp, layered over the read-only root
  for (const root of input.roots) args.push('--bind', root, root)
  for (const tmp of input.tmpDirs) args.push('--bind-try', tmp, tmp)

  if (proxied) {
    // Proxied egress: the forwarder is the entrypoint; the real command is its
    // child (argv passed verbatim after `--`, no extra quoting layer).
    const node = input.nodeBin ?? process.execPath
    args.push(
      node,
      input.egressProxy!.forwarderPath!,
      input.egressProxy!.unixSocketPath!,
      String(EGRESS_PROXY_INNER_PORT),
      '--',
      shell,
      '-c',
      input.command
    )
    return args
  }

  // exec the command (env is inherited from the spawn's env)
  args.push(shell, '-c', input.command)
  return args
}

/** Whether `p` is an executable regular file. */
function isExecutableFile(p: string): boolean {
  try {
    if (!statSync(p).isFile()) return false
    accessSync(p, fsConstants.X_OK)
    return true
  } catch {
    return false
  }
}

/**
 * Where `bwrap` lives: the first executable `bwrap` in the PATH entries that are
 * absolute, or undefined when none holds one.
 *
 * The wrapper must never be spawned by its bare name. That lookup happens on the
 * child's PATH at spawn time with the workspace as the working directory, so a PATH
 * holding a relative or empty entry (`.`, `node_modules/.bin`, a leading or trailing
 * `:`, which means the cwd) would run a `bwrap` the workspace planted: an unconfined
 * command reported as sandboxed. Resolving once here, from absolute entries only, and
 * spawning that path closes it. Distributions install bwrap in different places
 * (`/usr/bin`, `/usr/local/bin`, a Nix profile), hence a PATH search rather than one
 * fixed path.
 */
export function resolveBwrapPath(
  pathEnv: string = process.env.PATH ?? '',
  isExecutable: (p: string) => boolean = isExecutableFile
): string | undefined {
  for (const dir of pathEnv.split(':')) {
    if (!dir || !posix.isAbsolute(dir)) continue
    const candidate = posix.join(dir, 'bwrap')
    if (isExecutable(candidate)) return candidate
  }
  return undefined
}

/**
 * Where bwrap is spawned from when the PATH search found nothing. Only reached by a
 * launch built without a successful probe (`selectBackend` picks this backend only
 * after one), and still absolute, so it fails with ENOENT rather than searching PATH.
 */
const FALLBACK_BWRAP_PATH = '/usr/bin/bwrap'

let cachedBwrapPath: string | null | undefined

/** {@link resolveBwrapPath} for this process, memoized (null: not found). */
function bwrapPath(): string | undefined {
  if (cachedBwrapPath === undefined) cachedBwrapPath = resolveBwrapPath() ?? null
  return cachedBwrapPath ?? undefined
}

/** The absolute path a bubblewrap launch spawns (see {@link resolveBwrapPath}). */
export function bwrapExecutable(): string {
  return bwrapPath() ?? FALLBACK_BWRAP_PATH
}

export interface BwrapProbeDeps {
  /** Runs the probe command; throws on any failure. Injectable for tests. */
  exec?: (file: string, args: string[]) => void
  shell?: string
  /**
   * The resolved bwrap path, or undefined for none on PATH (default: the real
   * {@link resolveBwrapPath} result). Injectable for tests.
   */
  bwrapPath?: () => string | undefined
}

/** How long the bubblewrap probe may run before it is killed and counted as unusable. */
const PROBE_TIMEOUT_MS = 3000

const defaultProbeExec = (file: string, args: string[]): void => {
  execFileSync(file, args, { timeout: PROBE_TIMEOUT_MS, stdio: 'ignore' })
}

/**
 * The probe's argv: the namespace operations a real launch uses (see
 * {@link probeBwrapUsable}), running a no-op shell command.
 */
function probeArgs(shell: string): string[] {
  return [
    '--ro-bind',
    '/',
    '/',
    '--dev',
    '/dev',
    '--proc',
    '/proc',
    '--unshare-pid',
    '--unshare-net',
    '--die-with-parent',
    shell,
    '-c',
    ':'
  ]
}

let cachedProbe: boolean | undefined

/**
 * Whether bubblewrap can actually build the sandbox we need on this host — not just
 * whether the binary exists. The probe exercises the SAME namespace operations the
 * real command uses, INCLUDING `--unshare-net`, because the common failure mode on
 * hardened hosts (unprivileged user namespaces disabled, e.g. some AppArmor policies)
 * surfaces specifically on the network-namespace path. Any non-zero exit / missing
 * binary means "not usable" → fall back to the unconfined backend.
 *
 * Memoized for the real probe (one ~30ms spawn at startup); tests inject `exec` and
 * bypass the cache.
 */
export function probeBwrapUsable(deps: BwrapProbeDeps = {}): boolean {
  const injected = deps.exec !== undefined
  if (!injected && cachedProbe !== undefined) return cachedProbe
  const exec = deps.exec ?? defaultProbeExec
  const shell = deps.shell ?? bwrapShell()
  const args = probeArgs(shell)
  // Probe the very file a launch will spawn, so "usable" is never judged on one
  // bwrap and the command run under another.
  const file = (deps.bwrapPath ?? bwrapPath)()
  let ok: boolean
  if (file === undefined) {
    ok = false
  } else {
    try {
      exec(file, args)
      ok = true
    } catch {
      ok = false
    }
  }
  if (!injected) cachedProbe = ok
  return ok
}

/**
 * Run `file` with `args`, output discarded, resolving whether it exited 0. The
 * asynchronous twin of the probe's `execFileSync`, with the same outcomes: a missing
 * binary, a non-zero exit, or a kill (including the `timeoutMs` one) is false. One
 * that outlives even `giveUpMs` (it ignored the kill) is SIGKILLed and counted false
 * too, rather than holding its caller forever. Never rejects. Exported for tests.
 */
export function runProbeCommand(
  file: string,
  args: string[],
  timeoutMs = PROBE_TIMEOUT_MS,
  giveUpMs = PROBE_TIMEOUT_MS + 1000
): Promise<boolean> {
  return new Promise((resolve) => {
    let child: ChildProcess | undefined
    let settled = false
    const done = (ok: boolean): void => {
      if (settled) return
      settled = true
      clearTimeout(giveUp)
      resolve(ok)
    }
    const giveUp = setTimeout(() => {
      child?.kill('SIGKILL')
      done(false)
    }, giveUpMs)
    giveUp.unref()
    try {
      child = spawn(file, args, { stdio: 'ignore', timeout: timeoutMs, windowsHide: true })
    } catch {
      done(false)
      return
    }
    child.once('error', () => done(false))
    child.once('exit', (code) => done(code === 0))
  })
}

export interface BwrapAsyncProbeDeps {
  /** Runs the probe command, resolving whether it succeeded. Injectable for tests. */
  run?: (file: string, args: string[]) => Promise<boolean>
  shell?: string
  /** The resolved bwrap path, as for {@link probeBwrapUsable}. Injectable for tests. */
  bwrapPath?: () => string | undefined
}

let pendingProbe: Promise<boolean> | undefined

/**
 * {@link probeBwrapUsable} without blocking the process: the same command, run on the
 * same resolved bwrap file, and the same answer, from an asynchronous spawn, so a
 * terminal client can probe at launch while it starts up instead of stalling its first
 * run on a synchronous one. With no absolute PATH entry holding bwrap it is false and
 * runs nothing. Shares the memoized result both ways: an answer either form already
 * has is returned at once, and the first answer is the one kept (a synchronous probe
 * that ran meanwhile, for a caller that could not wait, wins). Tests inject `run` and
 * bypass the cache.
 */
export function probeBwrapUsableAsync(deps: BwrapAsyncProbeDeps = {}): Promise<boolean> {
  const injected = deps.run !== undefined
  if (!injected && cachedProbe !== undefined) return Promise.resolve(cachedProbe)
  if (!injected && pendingProbe) return pendingProbe
  const run = deps.run ?? runProbeCommand
  const shell = deps.shell ?? bwrapShell()
  // Probe the very file a launch will spawn, exactly as the synchronous probe does.
  const file = (deps.bwrapPath ?? bwrapPath)()
  const probe = (file === undefined ? Promise.resolve(false) : run(file, probeArgs(shell)))
    .catch(() => false)
    .then((ok) => {
      if (injected) return ok
      // Unless the cache was reset while this probe ran (a test seam).
      if (pendingProbe === probe) {
        pendingProbe = undefined
        cachedProbe ??= ok
      }
      return cachedProbe ?? ok
    })
  if (!injected) pendingProbe = probe
  return probe
}

/** Test seam: clear the memoized probe result and bwrap path. */
export function resetBwrapProbeCache(): void {
  cachedProbe = undefined
  pendingProbe = undefined
  cachedBwrapPath = undefined
}

export const BubblewrapBackend: SandboxBackend = {
  id: 'bubblewrap',
  sandboxed: true,
  confinesNetwork: true,
  // Honest: the bash session prelude only runs when bash is the resolved shell. On the
  // (near-impossible) bash-less host bwrap falls back to /bin/sh and callers skip it.
  supportsSession: resolvePosixShell().isBash,
  shellSyntax: 'posix',
  buildLaunch({ command, roots, allowNetwork, egressProxy, cwd }): ShellLaunch {
    const { shell, isBash } = resolvePosixShell()
    const writableRoots = dedupeExisting(roots.length ? roots : [cwd])
    const tmpDirs = dedupeExisting(linuxTmpDirs())
    const proxied = proxiedMode({ allowNetwork, egressProxy })
    const args = buildBwrapArgs({
      roots: writableRoots,
      tmpDirs,
      allowNetwork,
      egressProxy,
      command,
      cwd,
      shell
    })
    return {
      file: bwrapExecutable(),
      args,
      detached: true,
      windowsHide: false,
      supportsSession: isBash,
      // Proxied mode: ELECTRON_RUN_AS_NODE makes the Electron binary run the
      // forwarder as plain Node (the forwarder scrubs it from the command's own
      // env); the proxy vars point the toolchain at the forwarder's inner port.
      ...(proxied
        ? {
            env: {
              ELECTRON_RUN_AS_NODE: '1',
              ...egressProxyEnv(egressProxyUrl(`127.0.0.1:${EGRESS_PROXY_INNER_PORT}`, egressProxy?.token))
            }
          }
        : {})
    }
  }
}
