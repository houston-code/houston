import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  bindShellLedger,
  orphanedGroups,
  ownerAlive,
  parseLstart,
  parsePsRows,
  reapOrphanedShells,
  resetShellLedger,
  writeShellLedger,
  type LedgerFile,
  type ProcRow
} from './shellLedger'

const posix = process.platform !== 'win32'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'houston-ledger-'))
})
afterEach(() => {
  resetShellLedger()
  rmSync(dir, { recursive: true, force: true })
})

const T0 = new Date(2026, 8, 28, 21, 34, 6).getTime()

function ledger(over: Partial<LedgerFile> = {}): LedgerFile {
  return {
    version: 1,
    ownerPid: 4242,
    ownerStartedAt: T0 - 60_000,
    updatedAt: T0 + 10_000,
    shells: [{ pgid: 9000, startedAt: T0 }],
    ...over
  }
}

function writeFile(name: string, body: unknown): string {
  const path = join(dir, name)
  writeFileSync(path, typeof body === 'string' ? body : JSON.stringify(body))
  return path
}

describe('parseLstart / parsePsRows', () => {
  it('parses the C-locale lstart format as local time', () => {
    expect(parseLstart('Mon Sep 28 21:34:06 2026')).toBe(T0)
    // ps pads a single-digit day with a space
    expect(parseLstart('Mon Oct  5 01:02:03 2026')).toBe(new Date(2026, 9, 5, 1, 2, 3).getTime())
  })

  it('rejects anything else', () => {
    expect(parseLstart('')).toBeNaN()
    expect(parseLstart('2026-09-28T21:34:06')).toBeNaN()
    expect(parseLstart('Mon Foo 28 21:34:06 2026')).toBeNaN()
  })

  it('reads pid, pgid, and start time from ps rows, dropping junk', () => {
    const out = [
      ' 9395  8907 Mon Sep 28 21:34:06 2026    ',
      '    1     1 Fri Aug 21 01:23:00 2026',
      'garbage line',
      ' 12 34 not a date',
      ''
    ].join('\n')
    expect(parsePsRows(out)).toEqual([
      { pid: 9395, pgid: 8907, startMs: T0 },
      { pid: 1, pgid: 1, startMs: new Date(2026, 7, 21, 1, 23, 0).getTime() }
    ])
  })
})

describe('ownerAlive', () => {
  it('is false when no process has the owner pid', () => {
    expect(ownerAlive(ledger(), [])).toBe(false)
  })

  it('is false when the owner pid now belongs to a process that started later', () => {
    const rows: ProcRow[] = [{ pid: 4242, pgid: 4242, startMs: T0 + 3_600_000 }]
    expect(ownerAlive(ledger(), rows)).toBe(false)
  })

  it('is true for the same pid with the same start time (to the second)', () => {
    const file = ledger({ ownerStartedAt: T0 + 700 })
    expect(ownerAlive(file, [{ pid: 4242, pgid: 4242, startMs: T0 }])).toBe(true)
  })
})

describe('orphanedGroups', () => {
  it('claims a group with a member that started while the owner tracked it', () => {
    // The group leader exited; a server it backgrounded is still running.
    const rows: ProcRow[] = [{ pid: 9395, pgid: 9000, startMs: T0 + 1_000 }]
    expect(orphanedGroups(ledger(), rows)).toEqual([9000])
  })

  it('claims the leader even though ps rounds its start time down', () => {
    const file = ledger({ shells: [{ pgid: 9000, startedAt: T0 + 900 }] })
    expect(orphanedGroups(file, [{ pid: 9000, pgid: 9000, startMs: T0 }])).toEqual([9000])
  })

  it('leaves a recycled group id alone: every member is younger than the last write', () => {
    const rows: ProcRow[] = [
      { pid: 9000, pgid: 9000, startMs: T0 + 20_000 },
      { pid: 9001, pgid: 9000, startMs: T0 + 21_000 }
    ]
    expect(orphanedGroups(ledger(), rows)).toEqual([])
  })

  it('leaves a group whose members predate the shell', () => {
    const rows: ProcRow[] = [{ pid: 9000, pgid: 9000, startMs: T0 - 10_000 }]
    expect(orphanedGroups(ledger(), rows)).toEqual([])
  })

  it('lists a group once, however many entries or members match', () => {
    const file = ledger({ shells: [{ pgid: 9000, startedAt: T0 }, { pgid: 9000, startedAt: T0 }] })
    const rows: ProcRow[] = [
      { pid: 9000, pgid: 9000, startMs: T0 },
      { pid: 9001, pgid: 9000, startMs: T0 + 1_000 }
    ]
    expect(orphanedGroups(file, rows)).toEqual([9000])
  })
})

describe('writeShellLedger', () => {
  it('does nothing until bound', () => {
    writeShellLedger([{ pgid: 9000, startedAt: T0 }])
    expect(readdirSync(dir)).toEqual([])
  })

  it.skipIf(!posix)('writes this process file with 0600 perms, and removes it when empty', () => {
    const ledgerDir = join(dir, 'background-shells')
    bindShellLedger(ledgerDir)
    writeShellLedger([{ pgid: 9000, startedAt: T0 }])
    const [name] = readdirSync(ledgerDir)
    expect(name).toMatch(new RegExp(`^${process.pid}-\\d+\\.json$`))
    const path = join(ledgerDir, name)
    expect(statSync(path).mode & 0o777).toBe(0o600)
    const body = JSON.parse(readFileSync(path, 'utf8')) as LedgerFile
    expect(body).toMatchObject({ version: 1, ownerPid: process.pid, shells: [{ pgid: 9000, startedAt: T0 }] })
    expect(body.updatedAt).toBeGreaterThan(0)
    // No command text is persisted: a command line can carry a secret.
    expect(JSON.stringify(body)).not.toContain('command')

    writeShellLedger([])
    expect(readdirSync(ledgerDir)).toEqual([])
  })

  it('is a no-op on Windows', () => {
    bindShellLedger(dir)
    writeShellLedger([{ pgid: 9000, startedAt: T0 }], 'win32')
    expect(readdirSync(dir)).toEqual([])
  })
})

describe('reapOrphanedShells', () => {
  const orphanRows: ProcRow[] = [{ pid: 9395, pgid: 9000, startMs: T0 + 1_000 }]

  it("kills a dead owner's groups that still belong to it, then deletes its file", async () => {
    const path = writeFile('4242-1.json', ledger())
    const killed: number[] = []
    const reaped = await reapOrphanedShells(dir, {
      platform: 'darwin',
      listProcesses: async () => orphanRows,
      killGroup: (pgid) => killed.push(pgid)
    })
    expect(reaped).toEqual([9000])
    expect(killed).toEqual([9000])
    expect(existsSync(path)).toBe(false)
  })

  it('leaves a live owner alone', async () => {
    const path = writeFile('4242-1.json', ledger())
    const killed: number[] = []
    const rows: ProcRow[] = [...orphanRows, { pid: 4242, pgid: 4242, startMs: T0 - 60_000 }]
    const reaped = await reapOrphanedShells(dir, {
      platform: 'darwin',
      listProcesses: async () => rows,
      killGroup: (pgid) => killed.push(pgid)
    })
    expect(reaped).toEqual([])
    expect(killed).toEqual([])
    expect(existsSync(path)).toBe(true)
  })

  it('keeps every file when the process list could not be read', async () => {
    const path = writeFile('4242-1.json', ledger())
    const reaped = await reapOrphanedShells(dir, {
      platform: 'darwin',
      listProcesses: async () => [],
      killGroup: () => {
        throw new Error('must not kill')
      }
    })
    expect(reaped).toEqual([])
    expect(existsSync(path)).toBe(true)
  })

  it('deletes a corrupt or unknown-version file without killing anything', async () => {
    const corrupt = writeFile('4242-1.json', '{not json')
    const future = writeFile('4243-1.json', { ...ledger(), version: 2 })
    const killed: number[] = []
    await reapOrphanedShells(dir, {
      platform: 'darwin',
      listProcesses: async () => orphanRows,
      killGroup: (pgid) => killed.push(pgid)
    })
    expect(killed).toEqual([])
    expect(existsSync(corrupt)).toBe(false)
    expect(existsSync(future)).toBe(false)
  })

  it('never signals its own process group, or a group id of 0 or 1', async () => {
    const ownGroup = 7777
    writeFile(
      '4242-1.json',
      ledger({
        shells: [
          { pgid: ownGroup, startedAt: T0 },
          { pgid: 1, startedAt: T0 },
          { pgid: 0, startedAt: T0 }
        ]
      })
    )
    const killed: number[] = []
    await reapOrphanedShells(dir, {
      platform: 'darwin',
      listProcesses: async () => [
        { pid: process.pid, pgid: ownGroup, startMs: T0 + 1_000 },
        { pid: 1, pgid: 1, startMs: T0 + 1_000 },
        { pid: 5, pgid: 0, startMs: T0 + 1_000 }
      ],
      killGroup: (pgid) => killed.push(pgid)
    })
    expect(killed).toEqual([])
  })

  it('ignores files that are not ledger files, and does nothing on Windows', async () => {
    const other = writeFile('notes.json', ledger())
    expect(await reapOrphanedShells(dir, { platform: 'darwin', listProcesses: async () => orphanRows })).toEqual([])
    expect(existsSync(other)).toBe(true)
    writeFile('4242-1.json', ledger())
    expect(await reapOrphanedShells(dir, { platform: 'win32', listProcesses: async () => orphanRows })).toEqual([])
  })

  it('returns nothing when the directory does not exist yet', async () => {
    expect(await reapOrphanedShells(join(dir, 'missing'))).toEqual([])
  })

  it.skipIf(!posix)('stops a real detached process group a dead owner recorded', async () => {
    // A detached child leads its own group, as a background shell does.
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      detached: true,
      stdio: 'ignore'
    })
    const pgid = child.pid as number
    const closed = new Promise<void>((resolve) => child.on('exit', () => resolve()))
    // An owner pid that can't be running: spawn something and let it finish.
    const dead = spawn(process.execPath, ['-e', ''])
    await new Promise<void>((resolve) => dead.on('exit', () => resolve()))
    const startedAt = Date.now() - 1_000
    // Give ps a whole second to report a start time no later than the write.
    await new Promise((r) => setTimeout(r, 1_100))
    writeFile(
      `${dead.pid}-1.json`,
      ledger({ ownerPid: dead.pid as number, ownerStartedAt: 1, updatedAt: Date.now(), shells: [{ pgid, startedAt }] })
    )
    try {
      const reaped = await reapOrphanedShells(dir)
      expect(reaped).toEqual([pgid])
      await closed
      expect(() => process.kill(-pgid, 0)).toThrow()
    } finally {
      try {
        process.kill(-pgid, 'SIGKILL')
      } catch {
        // already reaped
      }
    }
  }, 15_000)
})
