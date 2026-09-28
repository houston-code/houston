import { describe, expect, it, vi } from 'vitest'
import { spawn, type ChildProcess } from 'node:child_process'
import {
  killShell,
  listShells,
  onShellsChanged,
  readShellOutput,
  registerShell,
  unreadSlice
} from './shells'

const onClose = (child: ChildProcess): Promise<void> =>
  new Promise((resolve) => child.on('close', () => resolve()))

const node = (code: string): ChildProcess => spawn(process.execPath, ['-e', code])

describe('background shell registry', () => {
  it('captures stdout/stderr and the exit code of a finished shell', async () => {
    const child = node('process.stdout.write("hello"); process.stderr.write("warn"); process.exit(3)')
    const id = registerShell('node script', child)
    await onClose(child)
    const r = readShellOutput(id)
    expect(r.found).toBe(true)
    expect(r.running).toBe(false)
    expect(r.exitCode).toBe(3)
    expect(r.stdout).toBe('hello')
    expect(r.stderr).toBe('warn')
  })

  it('returns only new output since the last read, unless full is set', async () => {
    const child = node('process.stdout.write("part1")')
    const id = registerShell('node', child)
    await onClose(child)
    expect(readShellOutput(id).stdout).toBe('part1')
    expect(readShellOutput(id).stdout).toBe('') // nothing new since last read
    expect(readShellOutput(id, { full: true }).stdout).toBe('part1') // full re-reads everything
  })

  it('reports not-found for an unknown id', () => {
    expect(readShellOutput('does-not-exist').found).toBe(false)
    expect(killShell('does-not-exist')).toBe('not-found')
  })

  it('kills a running shell', async () => {
    const child = node('setInterval(() => {}, 1000)') // runs until killed
    const id = registerShell('node loop', child)
    expect(readShellOutput(id).running).toBe(true)
    expect(listShells().find((s) => s.id === id)?.running).toBe(true)
    expect(killShell(id)).toBe('killed')
    await onClose(child)
    expect(readShellOutput(id).running).toBe(false)
  })

  it('reports already-exited for a finished shell with nothing left running', async () => {
    const child = node('process.exit(0)')
    const id = registerShell('node done', child)
    await onClose(child)
    expect(killShell(id)).toBe('already-exited')
  })

  // A detached shell (as the sandbox backends spawn them) that backgrounds a
  // long-lived child and exits: the child stays in the shell's process group, so the
  // registry sees the shell as exited while the "server" keeps running. POSIX only;
  // Windows has no process groups to probe.
  it.skipIf(process.platform === 'win32')('reaps a process a shell backgrounded before exiting', async () => {
    const child = spawn('/bin/sh', ['-c', 'sleep 30 >/dev/null 2>&1 &\necho started'], { detached: true })
    const id = registerShell('sleep 30 &', child)
    await onClose(child)
    const pgid = child.pid!
    const groupAlive = (): boolean => {
      try {
        process.kill(-pgid, 0)
        return true
      } catch {
        return false
      }
    }
    expect(readShellOutput(id).running).toBe(false)
    expect(groupAlive()).toBe(true)
    expect(killShell(id)).toBe('killed-leftovers')
    await vi.waitFor(() => expect(groupAlive()).toBe(false))
    expect(killShell(id)).toBe('already-exited')
  })

  it('exposes timestamps, exit code, and the spawning conversation in listShells', async () => {
    const child = node('process.exit(0)')
    const id = registerShell('node done', child, 'conv-7')
    const live = listShells().find((s) => s.id === id)!
    expect(live).toMatchObject({ command: 'node done', conversationId: 'conv-7', running: true, exitedAt: null })
    expect(live.startedAt).toBeGreaterThan(0)

    await onClose(child)
    const ended = listShells().find((s) => s.id === id)!
    expect(ended.running).toBe(false)
    expect(ended.exitCode).toBe(0)
    expect(ended.exitedAt).toBeGreaterThanOrEqual(ended.startedAt)
  })

  it('notifies subscribers when a shell starts and when it exits', async () => {
    const seen: number[] = []
    const off = onShellsChanged((list) => seen.push(list.filter((s) => s.running).length))
    const child = node('process.exit(0)')
    const id = registerShell('node ping', child)
    // The register call fired a change with the new shell running.
    expect(seen.at(-1)).toBeGreaterThanOrEqual(1)
    await onClose(child)
    // The exit fired another change; that shell is no longer counted as running.
    expect(listShells().find((s) => s.id === id)?.running).toBe(false)
    expect(seen.length).toBeGreaterThanOrEqual(2)
    off()
  })
})

describe('unreadSlice (rolling-buffer offsets)', () => {
  it('returns the tail after the cursor when nothing was dropped', () => {
    expect(unreadSlice('abcdef', 6, 2)).toBe('cdef')
  })

  it('returns nothing when the cursor has caught up', () => {
    expect(unreadSlice('abcdef', 6, 6)).toBe('')
  })

  it('accounts for dropped (trimmed) leading bytes', () => {
    // produced=6, buffer holds only the last 3 → 3 bytes dropped.
    expect(unreadSlice('def', 6, 4)).toBe('ef') // cursor 4 → start 1
    expect(unreadSlice('def', 6, 6)).toBe('') // caught up → nothing new
  })

  it('returns the whole buffer (no silent loss) when the poller fell behind the window', () => {
    // cursor (2) is older than what the buffer still holds (dropped 3).
    expect(unreadSlice('def', 6, 2)).toBe('def')
  })
})
