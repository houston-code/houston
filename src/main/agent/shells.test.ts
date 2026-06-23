import { describe, expect, it } from 'vitest'
import { spawn, type ChildProcess } from 'node:child_process'
import { killShell, listShells, readShellOutput, registerShell, unreadSlice } from './shells'

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
    expect(killShell('does-not-exist')).toBe(false)
  })

  it('kills a running shell', async () => {
    const child = node('setInterval(() => {}, 1000)') // runs until killed
    const id = registerShell('node loop', child)
    expect(readShellOutput(id).running).toBe(true)
    expect(listShells().find((s) => s.id === id)?.running).toBe(true)
    expect(killShell(id)).toBe(true)
    await onClose(child)
    expect(readShellOutput(id).running).toBe(false)
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
