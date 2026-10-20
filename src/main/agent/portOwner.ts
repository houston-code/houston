import { execFile } from 'node:child_process'
import { readlink } from 'node:fs/promises'
import { basename, sep } from 'node:path'

/**
 * Who is listening on a local port, so view_localhost can say when the page it loaded
 * comes from some other project's server.
 *
 * A dev server whose usual port is taken moves to another one (Vite: "Port 5173 is in
 * use, trying another one..."), and a server left running by an earlier session keeps
 * answering on the usual port. Loading that port then shows a different app, and
 * nothing in the page says so. The listening process's working folder does: if it is
 * outside the workspace and the process isn't one of the agent's own background
 * shells, the result says so.
 */

/** A process listening on the port. `cwd` is null when it can't be read. */
export interface PortListener {
  pid: number
  pgid: number | null
  command: string
  cwd: string | null
}

interface LsofRecord {
  pid: number
  pgid: number | null
  command: string
  names: string[]
}

/** Parse `lsof -F` output: one field per line, each record opening with `p<pid>`. */
export function parseLsofFields(text: string): LsofRecord[] {
  const out: LsofRecord[] = []
  let cur: LsofRecord | null = null
  for (const line of text.split('\n')) {
    const tag = line[0]
    const value = line.slice(1)
    if (tag === 'p') {
      const pid = Number(value)
      cur = Number.isInteger(pid) && pid > 0 ? { pid, pgid: null, command: '', names: [] } : null
      if (cur) out.push(cur)
    } else if (!cur) {
      continue
    } else if (tag === 'g') {
      const pgid = Number(value)
      cur.pgid = Number.isInteger(pgid) ? pgid : null
    } else if (tag === 'c') {
      cur.command = value
    } else if (tag === 'n') {
      cur.names.push(value)
    }
  }
  return out
}

function run(file: string, args: string[]): Promise<string> {
  return new Promise((resolve) => {
    execFile(file, args, { timeout: 3_000, maxBuffer: 1024 * 1024 }, (_err, stdout) => resolve(String(stdout ?? '')))
  })
}

export interface PortOwnerDeps {
  platform?: NodeJS.Platform
  /** Runs `lsof` with these args and returns its stdout ('' on failure). */
  lsof?: (args: string[]) => Promise<string>
  /** Reads a Linux `/proc/<pid>/cwd` link, or null. */
  procCwd?: (pid: number) => Promise<string | null>
}

/**
 * The processes listening on TCP `port` (any address), with their working folders.
 * Empty when nothing listens, on Windows, or when `lsof` is missing or fails.
 */
export async function listenersOnPort(port: number, deps: PortOwnerDeps = {}): Promise<PortListener[]> {
  const platform = deps.platform ?? process.platform
  if (platform === 'win32' || !Number.isInteger(port) || port <= 0 || port > 65_535) return []
  const lsof = deps.lsof ?? ((args: string[]) => run('lsof', args))
  const procCwd =
    deps.procCwd ??
    (async (pid: number) => {
      try {
        return await readlink(`/proc/${pid}/cwd`)
      } catch {
        return null
      }
    })
  const listening = parseLsofFields(await lsof(['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-Fpgc']))
  const out: PortListener[] = []
  for (const rec of listening) {
    if (out.some((l) => l.pid === rec.pid)) continue // one record per address family
    let cwd: string | null = null
    if (platform === 'linux') cwd = await procCwd(rec.pid)
    if (!cwd) cwd = parseLsofFields(await lsof(['-a', '-p', String(rec.pid), '-d', 'cwd', '-Fn']))[0]?.names[0] ?? null
    out.push({ pid: rec.pid, pgid: rec.pgid, command: rec.command, cwd })
  }
  return out
}

/**
 * A process or folder name made safe to quote in a tool result: control characters and
 * quotes removed, capped. Both are text some other program chose, read by the model.
 */
function quotable(text: string, max = 48): string {
  // eslint-disable-next-line no-control-regex
  const clean = text.replace(/[\u0000-\u001f\u007f"`]/g, '').trim()
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean
}

function within(root: string, path: string): boolean {
  return path === root || path.startsWith(root.endsWith(sep) ? root : root + sep)
}

/**
 * The note view_localhost adds when `port` is served by a process that neither runs in
 * one of `roots` nor belongs to one of the agent's own background shells (`ownGroups`),
 * or null. A listener whose folder couldn't be read gets no note: a false alarm would
 * teach the model to ignore the real one. Names only the folder, not its full path.
 */
export function foreignListenerNote(
  port: number,
  listeners: PortListener[],
  roots: string[],
  ownGroups: Set<number>
): string | null {
  const foreign = listeners.find(
    (l) =>
      l.cwd !== null &&
      !(l.pgid !== null && ownGroups.has(l.pgid)) &&
      !roots.some((r) => within(r, l.cwd as string))
  )
  if (!foreign || !foreign.cwd) return null
  const command = quotable(foreign.command)
  const what = command ? `"${command}" (pid ${foreign.pid})` : `pid ${foreign.pid}`
  return (
    `[note: port ${port} is served by ${what}, started in a folder named "${quotable(basename(foreign.cwd))}" ` +
    'outside this workspace. If that is not the app you started, check the URL your server printed: ' +
    'it may have moved to another port.]'
  )
}

/** The port a loopback URL addresses, defaulting by scheme. Null when it doesn't parse. */
export function urlPort(url: string): number | null {
  try {
    const u = new URL(url)
    if (u.port) return Number(u.port)
    return u.protocol === 'https:' ? 443 : u.protocol === 'http:' ? 80 : null
  } catch {
    return null
  }
}
