import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

/** One row of the OS process table. */
export interface ProcessRow {
  pid: number
  ppid: number
  command: string
}

/**
 * Every process on the machine with its parent and command line, on macOS, Linux and
 * Windows. Used to find what Houston left running (shells, ripgrep, MCP servers,
 * language servers) after a run, a window close, or a CLI exit.
 */
export function processTable(): ProcessRow[] {
  if (process.platform === 'win32') {
    const out = execFileSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        'Get-CimInstance Win32_Process | ForEach-Object { "$($_.ProcessId)`t$($_.ParentProcessId)`t$($_.CommandLine)" }'
      ],
      { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, windowsHide: true }
    )
    return out
      .split(/\r?\n/)
      .map((line) => line.split('\t'))
      .filter((f) => f.length >= 2 && /^\d+$/.test(f[0]))
      .map((f) => ({ pid: Number(f[0]), ppid: Number(f[1]), command: f.slice(2).join('\t') }))
  }
  const out = execFileSync('ps', ['-A', '-o', 'pid=,ppid=,command='], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  return out
    .split('\n')
    .map((line) => /^\s*(\d+)\s+(\d+)\s(.*)$/.exec(line))
    .filter((m): m is RegExpExecArray => m !== null)
    .map((m) => ({ pid: Number(m[1]), ppid: Number(m[2]), command: m[3] }))
}

/** Every process below `pid` (children, grandchildren, ...). */
export function descendants(pid: number, table = processTable()): ProcessRow[] {
  const byParent = new Map<number, ProcessRow[]>()
  for (const row of table) {
    const list = byParent.get(row.ppid)
    if (list) list.push(row)
    else byParent.set(row.ppid, [row])
  }
  const out: ProcessRow[] = []
  const seen = new Set<number>([pid])
  const queue = [pid]
  while (queue.length) {
    for (const row of byParent.get(queue.shift()!) ?? []) {
      if (seen.has(row.pid)) continue
      seen.add(row.pid)
      out.push(row)
      queue.push(row.pid)
    }
  }
  return out
}

/** Processes whose command line contains `tag`, anywhere on the machine (never the lookup itself). */
export function processesTagged(tag: string, table = processTable()): ProcessRow[] {
  return table.filter((row) => row.command.includes(tag) && !/Get-CimInstance|\bps -A\b/.test(row.command))
}

/** A process's resident memory in MB (its working set on Windows), or 0 once it is gone. */
export function residentMB(pid: number): number {
  try {
    if (process.platform === 'linux') {
      const m = /VmRSS:\s+(\d+)\s+kB/.exec(readFileSync(`/proc/${pid}/status`, 'utf8'))
      return m ? Number(m[1]) / 1024 : 0
    }
    if (process.platform === 'win32') {
      const out = execFileSync(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-Command', `(Get-Process -Id ${pid}).WorkingSet64`],
        { encoding: 'utf8', windowsHide: true }
      )
      return Number(out.trim()) / 1048576 || 0
    }
    const out = execFileSync('ps', ['-o', 'rss=', '-p', String(pid)], { encoding: 'utf8' })
    return Number(out.trim()) / 1024 || 0
  } catch {
    return 0
  }
}

/** Poll `check` until it holds or `timeoutMs` passes; returns whether it held. */
export async function waitUntil(check: () => boolean, timeoutMs: number, everyMs = 250): Promise<boolean> {
  const end = Date.now() + timeoutMs
  for (;;) {
    if (check()) return true
    if (Date.now() >= end) return false
    await new Promise((r) => setTimeout(r, everyMs))
  }
}
