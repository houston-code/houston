import { describe, expect, it, vi } from 'vitest'
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { bindShellLedger, resetShellLedger } from './shellLedger'
import { configureAgentHost, resetAgentHost, type AgentHost } from '../agentHost'
import {
  MAX_EXITED_SHELLS,
  appendCapped,
  backgroundShellGroups,
  findRunningDuplicate,
  killAllShells,
  killShell,
  killShellsFor,
  listPreviewServers,
  listShells,
  onShellsChanged,
  readShellOutput,
  registerShell,
  runningShellsFor,
  peekShell,
  shellTail,
  stopShell,
  unreadSlice,
  windowOf
} from './shells'

const onClose = (child: ChildProcess): Promise<void> =>
  new Promise((resolve) => child.on('close', () => resolve()))

const node = (code: string): ChildProcess => spawn(process.execPath, ['-e', code])

describe('killShellsFor', () => {
  it("stops a conversation's running shells and leaves other chats' alone", async () => {
    const mine = node('setInterval(() => {}, 1000)')
    const theirs = node('setInterval(() => {}, 1000)')
    const a = registerShell('node mine', mine, 'conv-gone')
    const b = registerShell('node theirs', theirs, 'conv-kept')
    const closed = onClose(mine)
    expect(killShellsFor('conv-gone')).toBe(1)
    await closed
    expect(peekShell(a)).toBeUndefined()
    expect(listShells().some((s) => s.id === a)).toBe(false)
    expect(peekShell(b)?.running).toBe(true)
    const closedB = onClose(theirs)
    killShell(b)
    await closedB
  })

  it('does nothing for a conversation with no shells', () => {
    expect(killShellsFor('conv-none')).toBe(0)
  })
})

describe('runningShellsFor / findRunningDuplicate', () => {
  it("lists a chat's running shells and finds one running the same command in the same folder", async () => {
    const a = node('setInterval(() => {}, 1000)')
    const b = node('setInterval(() => {}, 1000)')
    const done = node('process.exit(0)')
    const idA = registerShell('npm run dev', a, 'conv-run', '/ws/one')
    const idB = registerShell('npm run api', b, 'conv-run', '/ws/one')
    registerShell('npm run old', done, 'conv-run', '/ws/one')
    await onClose(done)
    try {
      expect(runningShellsFor('conv-run', '/ws/one')).toEqual([
        { id: idA, command: 'npm run dev' },
        { id: idB, command: 'npm run api' }
      ])
      expect(findRunningDuplicate('conv-run', '/ws/one', '  npm run dev ')?.id).toBe(idA)
      // Another folder, another chat, a different command, or one that exited: no duplicate.
      expect(findRunningDuplicate('conv-run', '/ws/two', 'npm run dev')).toBeUndefined()
      expect(findRunningDuplicate('conv-else', '/ws/one', 'npm run dev')).toBeUndefined()
      expect(findRunningDuplicate('conv-run', '/ws/one', 'npm run dev -- --port 3001')).toBeUndefined()
      expect(findRunningDuplicate('conv-run', '/ws/one', 'npm run old')).toBeUndefined()
      expect(runningShellsFor('conv-else', '/ws/one')).toEqual([])
    } finally {
      killShellsFor('conv-run')
      await Promise.all([onClose(a), onClose(b)])
    }
  })

  it('keys shells started without a chat by their folder', async () => {
    const a = node('setInterval(() => {}, 1000)')
    const id = registerShell('make watch', a, undefined, '/ws/nochat')
    try {
      expect(runningShellsFor(undefined, '/ws/nochat')).toEqual([{ id, command: 'make watch' }])
      expect(findRunningDuplicate(undefined, '/ws/nochat', 'make watch')?.id).toBe(id)
      expect(runningShellsFor(undefined, '/ws/elsewhere')).toEqual([])
    } finally {
      const closed = onClose(a)
      killShell(id)
      await closed
    }
  })
})

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

  it('keeps a trailing partial multibyte character the shell ended on', async () => {
    // Exits mid-character (0xC3 without its continuation byte): the decoder held that
    // byte back waiting for more, and nothing flushed it at close.
    const child = node(
      'process.stdout.write(Buffer.from([0x6f, 0x6b, 0xc3])); process.stderr.write(Buffer.from([0xe2, 0x82]))'
    )
    const id = registerShell('node partial', child)
    await onClose(child)
    const r = readShellOutput(id)
    expect(r.stdout).toBe('ok�')
    expect(r.stderr).toBe('�')
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

describe('rolling output window', () => {
  // The same stream fed to the old trim-on-every-chunk buffer and to the lazy one must
  // read back identically, whatever the chunking and wherever the cursor sits.
  it('reads back exactly what trimming on every chunk did', () => {
    const max = 10
    let lazy = ''
    let eager = ''
    let produced = 0
    let cursor = 0
    let seed = 3
    const rnd = (): number => ((seed = (seed * 1664525 + 1013904223) >>> 0), seed / 2 ** 32)
    for (let i = 0; i < 400; i++) {
      const chunk = String(i % 10).repeat(1 + Math.floor(rnd() * 7))
      produced += chunk.length
      lazy = appendCapped(lazy, chunk, max)
      const next = eager + chunk
      eager = next.length > max ? next.slice(next.length - max) : next
      expect(windowOf(lazy, max)).toBe(eager)
      expect(lazy.length).toBeLessThanOrEqual(max * 2)
      if (rnd() < 0.3) {
        expect(unreadSlice(windowOf(lazy, max), produced, cursor)).toBe(unreadSlice(eager, produced, cursor))
        cursor = produced
      }
    }
  })

  it('does not copy the window on every chunk once it is full', () => {
    const max = 1000
    let buf = 'x'.repeat(max)
    buf = appendCapped(buf, 'y', max)
    // One past the window is kept as is; the cut happens only past twice the window.
    expect(buf.length).toBe(max + 1)
    expect(windowOf(buf, max)).toBe('x'.repeat(max - 1) + 'y')
  })
})

describe('finished shells', () => {
  it('forgets the oldest finished shells past the cap, never a running one', async () => {
    const running = node('setTimeout(() => {}, 60_000)')
    const runningId = registerShell('long-lived', running)
    const ids: string[] = []
    for (let i = 0; i < MAX_EXITED_SHELLS + 3; i++) {
      const child = node(`process.stdout.write("done ${i}")`)
      ids.push(registerShell(`short ${i}`, child))
      await onClose(child)
    }
    // Pruning runs as the next shell registers.
    const last = node('process.stdout.write("last")')
    const lastId = registerShell('last', last)
    await onClose(last)
    expect(readShellOutput(ids[0]).found).toBe(false)
    expect(readShellOutput(ids[ids.length - 1], { full: true }).stdout).toBe(`done ${ids.length - 1}`)
    expect(readShellOutput(lastId).stdout).toBe('last')
    expect(readShellOutput(runningId).running).toBe(true)
    await killShell(runningId)
  }, 60_000)
})

// Graceful stops signal process groups, which Windows doesn't have (its tree kill is
// always forceful), so these are POSIX only.
describe.skipIf(process.platform === 'win32')('graceful stop', () => {
  const exited = (child: ChildProcess): Promise<{ code: number | null; signal: NodeJS.Signals | null }> =>
    new Promise((resolve) => child.on('exit', (code, signal) => resolve({ code, signal })))
  const groupAlive = (pgid: number): boolean => {
    try {
      process.kill(-pgid, 0)
      return true
    } catch {
      return false
    }
  }
  /** A detached shell (as the sandbox backends spawn them) that prints `ready` once its trap is set. */
  const shell = async (script: string): Promise<{ child: ChildProcess; id: string }> => {
    const child = spawn('/bin/sh', ['-c', script], { detached: true })
    const id = registerShell(script, child)
    await vi.waitFor(() => expect(readShellOutput(id, { full: true }).stdout).toContain('ready'))
    return { child, id }
  }

  it('lets a shell shut down on SIGTERM (as docker compose needs to stop its containers)', async () => {
    const { child, id } = await shell("trap 'echo stopping; exit 0' TERM; echo ready; while :; do sleep 0.05; done")
    const done = exited(child)
    expect(killShell(id, { graceMs: 5_000 })).toBe('killed')
    expect(await done).toEqual({ code: 0, signal: null })
    expect(readShellOutput(id, { full: true }).stdout).toContain('stopping')
  })

  it('sends SIGTERM first and SIGKILL only after the grace when the shell ignores it', async () => {
    const { child, id } = await shell("trap '' TERM; echo ready; while :; do sleep 0.05; done")
    const done = exited(child)
    // Monotonic clock: the grace timer runs on libuv's millisecond clock, so a wall-clock
    // (Date.now) reading can come out 1ms short of the grace and fail a correct kill.
    const started = performance.now()
    expect(killShell(id, { graceMs: 400 })).toBe('killed')
    await new Promise((r) => setTimeout(r, 200))
    expect(readShellOutput(id).running).toBe(true)
    const { signal } = await done
    expect(signal).toBe('SIGKILL')
    // 1ms for the timer clock's whole-millisecond rounding.
    expect(performance.now() - started).toBeGreaterThanOrEqual(399)
    await vi.waitFor(() => expect(groupAlive(child.pid!)).toBe(false))
  })

  it('stopShell resolves only once the shell is actually gone', async () => {
    const { child, id } = await shell("trap '' TERM; echo ready; while :; do sleep 0.05; done")
    expect(await stopShell(id, { graceMs: 300 })).toBe('killed')
    expect(readShellOutput(id).running).toBe(false)
    expect(groupAlive(child.pid!)).toBe(false)
  })

  it('killAllShells gives every shell a bounded chance to exit on SIGTERM, then SIGKILLs the rest', async () => {
    const polite = await shell("trap 'echo stopping; exit 0' TERM; echo ready; while :; do sleep 0.05; done")
    const stubborn = await shell("trap '' TERM; echo ready; while :; do sleep 0.05; done")
    const politeDone = exited(polite.child)
    const stubbornDone = exited(stubborn.child)
    const started = Date.now()
    killAllShells({ graceMs: 600 })
    const blocked = Date.now() - started
    // Bounded: the stubborn shell holds the quit for the grace, not forever.
    expect(blocked).toBeGreaterThanOrEqual(550)
    expect(blocked).toBeLessThan(3_000)
    expect(await politeDone).toEqual({ code: 0, signal: null })
    expect((await stubbornDone).signal).toBe('SIGKILL')
    await vi.waitFor(() => {
      expect(groupAlive(polite.child.pid!)).toBe(false)
      expect(groupAlive(stubborn.child.pid!)).toBe(false)
    })
  })

  it('killAllShells returns as soon as every shell has stopped, without waiting out the grace', async () => {
    const polite = await shell("trap 'exit 0' TERM; echo ready; while :; do sleep 0.05; done")
    const done = exited(polite.child)
    const started = Date.now()
    killAllShells({ graceMs: 5_000 })
    expect(Date.now() - started).toBeLessThan(2_500)
    expect(await done).toEqual({ code: 0, signal: null })
  })
})
