import { execFileSync } from 'node:child_process'
import { existsSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import type { EgressProxyEndpoints, SandboxBackend, ShellLaunch } from './contract'
import { EGRESS_PROXY_INNER_PORT, egressProxyEnv } from './egress-proxy'
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
  // Honest: the bash session prelude only runs when bash is the resolved shell. On the
  // (near-impossible) bash-less host bwrap falls back to /bin/sh and callers skip it.
  supportsSession: resolvePosixShell().isBash,
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
      file: 'bwrap',
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
              ...egressProxyEnv(`http://127.0.0.1:${EGRESS_PROXY_INNER_PORT}`)
            }
          }
        : {})
    }
  }
}
