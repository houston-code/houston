import { readFileSync, renameSync, writeFileSync } from 'node:fs'

/**
 * The user's settings file, shared by the desktop app and the terminal client, which
 * run as separate processes against the same file and can save at the same moment.
 *
 * Reading and parsing it on every call showed up in a profile (the permission check
 * runs on every tool call), so the parsed file is kept after the first read.
 */
export const DEFAULTS = Object.freeze({ theme: 'light', fontSize: 13, allow: [] })

export function openSettings(file) {
  let cached = null

  function read() {
    if (cached) return cached
    try {
      cached = { ...DEFAULTS, ...JSON.parse(readFileSync(file, 'utf8')) }
    } catch (err) {
      if (err.code !== 'ENOENT') throw err
      cached = { ...DEFAULTS }
    }
    return cached
  }

  function write(next) {
    // Write-then-rename, so the other process never reads a half-written file.
    writeFileSync(`${file}.tmp`, JSON.stringify(next, null, 2))
    renameSync(`${file}.tmp`, file)
    cached = next
  }

  return {
    get: () => structuredClone(read()),
    update(patch) {
      write({ ...read(), ...patch })
    },
    allow(rule) {
      const s = read()
      if (!s.allow.includes(rule)) write({ ...s, allow: [...s.allow, rule] })
    },
    revoke(rule) {
      const s = read()
      write({ ...s, allow: s.allow.filter((r) => r !== rule) })
    },
    /** The permission check: is this command pre-approved? */
    isAllowed: (command) => read().allow.includes(command)
  }
}
