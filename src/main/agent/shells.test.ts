import { describe, expect, it, vi } from 'vitest'
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { bindShellLedger, resetShellLedger } from './shellLedger'
import { configureAgentHost, resetAgentHost, type AgentHost } from '../agentHost'
import {
  backgroundShellGroups,
  killShell,
  listPreviewServers,
  listShells,
  onShellsChanged,
  readShellOutput,
  registerShell,
  peekShell,
  shellTail,
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

  it('keeps a multibyte character that arrives split across two output chunks', async () => {
    // 'é' is 0xC3 0xA9. Written as two separate pipe chunks, decoding each chunk on
    // its own turned both halves into replacement characters.
    const child = node(
      'process.stdout.write(Buffer.from([0x63, 0x61, 0x66, 0xc3]));' +
        'setTimeout(() => process.stdout.write(Buffer.from([0xa9, 0x0a])), 50)'
    )
    const id = registerShell('node split', child)
    await onClose(child)
    expect(readShellOutput(id).stdout).toBe('café\n')
  })

  it('peeks at a shell without hiding its output from the next read', async () => {
    const child = node('process.stdout.write("# pass 2\\n# fail 0\\n"); process.exit(0)')
    const id = registerShell('node test.mjs', child)
    await onClose(child)
    expect(peekShell(id)).toEqual({ running: false, exitCode: 0, output: '# pass 2\n# fail 0\n' })
    // The agent's own read still gets everything: the peek moved no cursor.
    expect(readShellOutput(id).stdout).toBe('# pass 2\n# fail 0\n')
    expect(peekShell('does-not-exist')).toBeUndefined()
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
    expect(listShells().find((s) => s.id === id)?.leftover).toBe(true)
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

  it('lists the workspace and printed URLs for the Tasks panel', async () => {
    const child = node('process.stdout.write("  Local:   http://localhost:5173/\\n"); process.exit(0)')
    const id = registerShell('npm run dev', child, 'conv-1', '/w/app')
    await onClose(child)
    expect(listShells().find((s) => s.id === id)).toMatchObject({
      workspace: '/w/app',
      urls: ['http://localhost:5173/']
    })
    // A cleanly exited shell with nothing left running is not a leftover.
    expect(listShells().find((s) => s.id === id)?.leftover).toBeUndefined()
  })

  it('tails recent output without colors, redraws, or secrets', async () => {
    const token = 'ghp_' + 'A'.repeat(36)
    const child = node(
      `process.stdout.write("\\x1b[32mready\\x1b[39m in 90ms\\n");` +
        `process.stderr.write("warn: slow\\n");` +
        `process.stdout.write("10%\\r50%\\r100%\\n");` +
        `process.stdout.write("token=${token}\\n\\n");` +
        'process.exit(0)'
    )
    const id = registerShell('build', child)
    await onClose(child)
    const tail = shellTail(id)!
    // stdout and stderr are separate pipes, so only order within a stream is fixed.
    expect(tail.filter((l) => l !== 'warn: slow')).toEqual([
      'ready in 90ms',
      '100%',
      expect.stringContaining('[redacted')
    ])
    expect(tail).toContain('warn: slow')
    expect(tail.join('\n')).not.toContain(token)
    expect(shellTail(id, 2)).toHaveLength(2)
    // Tailing moves no cursor: the agent's next read still sees everything.
    expect(readShellOutput(id).stdout).toContain('ready')
    expect(shellTail('nope')).toBeUndefined()
  })

  it.skipIf(process.platform === 'win32')(
    'never treats a recycled group id as a leftover once the group was seen empty',
    async () => {
      const child = node('process.exit(0)')
      const id = registerShell('node done', child)
      await onClose(child)
      // The exit's ledger write probed the (empty) group and latched it gone.
      expect(listShells().find((s) => s.id === id)?.leftover).toBeUndefined()
      // Now pretend the pgid was recycled by an unrelated live group leader.
      const kill = vi.spyOn(process, 'kill').mockImplementation(() => true)
      try {
        expect(listShells().find((s) => s.id === id)?.leftover).toBeUndefined()
        expect(killShell(id)).toBe('already-exited')
        expect(kill).not.toHaveBeenCalledWith(-child.pid!, expect.anything())
      } finally {
        kill.mockRestore()
      }
    }
  )

  it.skipIf(process.platform === 'win32')(
    'broadcasts when a leftover dies on its own, without anyone polling',
    async () => {
      const child = spawn('/bin/sh', ['-c', 'sleep 2 >/dev/null 2>&1 &\necho started'], { detached: true })
      const id = registerShell('sleep 2 &', child)
      await onClose(child)
      expect(listShells().find((s) => s.id === id)?.leftover).toBe(true)
      const seen: boolean[] = []
      const off = onShellsChanged((list) => seen.push(!!list.find((s) => s.id === id)?.leftover))
      try {
        await vi.waitFor(() => expect(seen).toContain(false), { timeout: 12_000, interval: 200 })
      } finally {
        off()
      }
    },
    20_000
  )

  it('tags each preview server with the conversation that started it', async () => {
    const child = node('process.exit(0)')
    const id = registerShell('npm run dev', child, 'conv-1')
    await onClose(child)
    expect(listPreviewServers().find((s) => s.id === id)?.conversationId).toBe('conv-1')
  })

  it('masks secrets in the listed command and the tail, including configured credentials', async () => {
    const known = 'k3y-' + 'Z'.repeat(24)
    configureAgentHost({ collectSecrets: () => [known] } as unknown as AgentHost)
    try {
      const token = 'ghp_' + 'B'.repeat(36)
      const child = node(`console.log("using ${known}"); process.exit(0)`)
      const id = registerShell(`GH_TOKEN=${token} PROVIDER_KEY=${known} node app.js`, child)
      await onClose(child)
      const listed = listShells().find((s) => s.id === id)!.command
      expect(listed).not.toContain(token)
      expect(listed).not.toContain(known)
      expect(listPreviewServers().find((s) => s.id === id)!.command).not.toContain(known)
      expect(shellTail(id)!.join('\n')).not.toContain(known)
    } finally {
      resetAgentHost()
    }
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

describe('background shell ledger', () => {
  it.skipIf(process.platform === 'win32')(
    'records a running shell in the crash-safe ledger and drops it once its group is gone',
    async () => {
      const dir = mkdtempSync(join(tmpdir(), 'houston-shells-ledger-'))
      bindShellLedger(dir)
      try {
        // Detached, as the sandbox backends spawn background shells: the child leads its group.
        const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true })
        const id = registerShell('node server', child)
        const files = readdirSync(dir)
        expect(files).toHaveLength(1)
        const body = JSON.parse(readFileSync(join(dir, files[0]), 'utf8'))
        expect(body.shells).toEqual([{ pgid: child.pid, startedAt: expect.any(Number) }])
        expect(killShell(id)).toBe('killed')
        await onClose(child)
        expect(readdirSync(dir)).toEqual([])
      } finally {
        resetShellLedger()
        rmSync(dir, { recursive: true, force: true })
      }
    }
  )
})

describe('dev-server URLs', () => {
  it('keeps every URL a combined dev script prints, the one labeled Local: first', async () => {
    const child = node(
      "console.log('[server] listening on http://localhost:3001'); setTimeout(() => console.log('[client]   Local:   http://localhost:5175/'), 50)"
    )
    const id = registerShell('npm run dev', child)
    await onClose(child)
    const server = listPreviewServers().find((s) => s.id === id)
    expect(server?.url).toBe('http://localhost:5175/')
    expect(server?.urls).toEqual(['http://localhost:5175/', 'http://localhost:3001/'])
    expect(backgroundShellGroups().has(child.pid as number)).toBe(true)
  })

  it('reports each URL to read_shell_output once, and all of them on a full read', async () => {
    const child = node("console.log('Local: http://localhost:4000/')")
    const id = registerShell('serve', child)
    await onClose(child)
    expect(readShellOutput(id).newUrls).toEqual(['http://localhost:4000/'])
    expect(readShellOutput(id).newUrls).toEqual([])
    expect(readShellOutput(id, { full: true }).newUrls).toEqual(['http://localhost:4000/'])
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
