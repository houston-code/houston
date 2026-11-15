import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  RUN_MARKER_STALE_MS,
  conversationRunningElsewhere,
  recordRunningConversations,
  resetRunMarkers
} from './runMarkers'
import { resetUserDataDir, setUserDataDir } from './userData'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'houston-run-markers-'))
  setUserDataDir(dir)
})
afterEach(() => {
  resetRunMarkers()
  resetUserDataDir()
  rmSync(dir, { recursive: true, force: true })
})

const runs = (): string => join(dir, 'runs')
/** A marker as another process writes it. */
function otherMarker(pid: number, conversations: string[]): string {
  mkdirSync(runs(), { recursive: true })
  const path = join(runs(), `${pid}.json`)
  writeFileSync(path, JSON.stringify({ pid, conversations }))
  return path
}

describe('run markers', () => {
  it("records this process's running chats, and removes the file once none is left", () => {
    const mine = join(runs(), `${process.pid}.json`)
    recordRunningConversations(['c1', 'c2'])
    expect(JSON.parse(readFileSync(mine, 'utf8'))).toEqual({ pid: process.pid, conversations: ['c1', 'c2'] })
    recordRunningConversations([])
    expect(existsSync(mine)).toBe(false)
  })

  it("never reports this process's own runs", () => {
    recordRunningConversations(['c1'])
    expect(conversationRunningElsewhere('c1')).toBeNull()
  })

  it('reports a chat another live process is running', () => {
    otherMarker(process.ppid, ['c1'])
    expect(conversationRunningElsewhere('c1')).toBe(process.ppid)
    expect(conversationRunningElsewhere('c2')).toBeNull()
  })

  it('ignores a marker that was not refreshed, whatever process now has its pid', () => {
    const path = otherMarker(process.ppid, ['c1'])
    const old = (Date.now() - RUN_MARKER_STALE_MS - 1000) / 1000
    utimesSync(path, old, old)
    expect(conversationRunningElsewhere('c1')).toBeNull()
  })

  it('ignores a marker whose process is gone, and one it cannot parse', () => {
    otherMarker(2 ** 22 + 12345, ['c1'])
    mkdirSync(runs(), { recursive: true })
    writeFileSync(join(runs(), `${process.ppid}.json`), '{ half')
    expect(conversationRunningElsewhere('c1')).toBeNull()
  })

  it('reports nothing when no process has written a marker', () => {
    expect(conversationRunningElsewhere('c1')).toBeNull()
  })
})
