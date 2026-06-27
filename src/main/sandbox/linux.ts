import { execFileSync } from 'node:child_process'
import { existsSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import type { SandboxBackend, ShellLaunch } from './contract'

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

/** Choose the shell to exec inside the sandbox: bash when present, else POSIX sh. */
export function bwrapShell(exists: (p: string) => boolean = existsSync): string {
  return exists('/bin/bash') ? '/bin/bash' : '/bin/sh'
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
  command: string
  cwd: string
  shell?: string
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

  // network gate: empty net namespace (loopback only) when denied; share the host's when allowed
  if (!input.allowNetwork) args.push('--unshare-net')

  // writable ONLY in roots + temp, layered over the read-only root
  for (const root of input.roots) args.push('--bind', root, root)
  for (const tmp of input.tmpDirs) args.push('--bind-try', tmp, tmp)

  // exec the command (env is inherited from the spawn's env)
  args.push(shell, '-c', input.command)
  return args
}

export interface BwrapProbeDeps {
  /** Runs the probe command; throws on any failure. Injectable for tests. */
  exec?: (file: string, args: string[]) => void
  shell?: string
}

const defaultProbeExec = (file: string, args: string[]): void => {
  execFileSync(file, args, { timeout: 3000, stdio: 'ignore' })
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
  const args = [
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
  let ok: boolean
  try {
    exec('bwrap', args)
    ok = true
  } catch {
    ok = false
  }
  if (!injected) cachedProbe = ok
  return ok
}

/** Test seam: clear the memoized probe result. */
export function resetBwrapProbeCache(): void {
  cachedProbe = undefined
}

export const BubblewrapBackend: SandboxBackend = {
  id: 'bubblewrap',
  sandboxed: true,
  confinesNetwork: true,
  supportsSession: true,
  buildLaunch({ command, roots, allowNetwork, cwd }): ShellLaunch {
    const shell = bwrapShell()
    const writableRoots = dedupeExisting(roots.length ? roots : [cwd])
    const tmpDirs = dedupeExisting(linuxTmpDirs())
    const args = buildBwrapArgs({ roots: writableRoots, tmpDirs, allowNetwork, command, cwd, shell })
    return { file: 'bwrap', args, detached: true, windowsHide: false, supportsSession: true }
  }
}
