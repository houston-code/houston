import { callTool, say, turn, type EvalTask } from '../../types'

// The reference fix, kept as lines so a fixture change diffs like code.
const SETTINGS = [
  'import { closeSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from \'node:fs\'',
  '',
  '/**',
  ' * The user\'s settings file, shared by the desktop app and the terminal client, which',
  ' * run as separate processes against the same file and can save at the same moment.',
  ' *',
  ' * Reading and parsing it on every call showed up in a profile (the permission check',
  ' * runs on every tool call), so the parsed file is kept, and re-read only when the file',
  ' * on disk has changed (a save replaces it, so its inode, size or mtime moves).',
  ' *',
  ' * A save is read-modify-write, so two processes saving at once would each write back',
  ' * the copy they read and drop the other\'s change. Saves therefore hold a lock file',
  ' * while they re-read, merge and replace the settings file.',
  ' */',
  'export const DEFAULTS = Object.freeze({ theme: \'light\', fontSize: 13, allow: [] })',
  '',
  'const LOCK_STALE_MS = 2000',
  'const pause = new Int32Array(new SharedArrayBuffer(4))',
  'const sleep = (ms) => Atomics.wait(pause, 0, 0, ms)',
  'let writes = 0',
  '',
  '// On Windows a file another process has just deleted, or still has open, can refuse',
  '// to be created or replaced for a moment with one of these instead of EEXIST.',
  'const BUSY = new Set(process.platform === \'win32\' ? [\'EPERM\', \'EACCES\', \'EBUSY\'] : [])',
  '',
  '/** Run a filesystem call, retried while Windows briefly holds the file. */',
  'function retrying(fn) {',
  '  for (let attempt = 0; ; attempt++) {',
  '    try {',
  '      return fn()',
  '    } catch (err) {',
  '      if (!BUSY.has(err.code) || attempt >= 50) throw err',
  '      sleep(5)',
  '    }',
  '  }',
  '}',
  '',
  '/** Run `fn` holding `<file>.lock`, created exclusively; a lock older than LOCK_STALE_MS is a crashed writer\'s. */',
  'function withLock(file, fn) {',
  '  const lock = `${file}.lock`',
  '  for (;;) {',
  '    try {',
  '      closeSync(openSync(lock, \'wx\'))',
  '      break',
  '    } catch (err) {',
  '      if (err.code !== \'EEXIST\' && !BUSY.has(err.code)) throw err',
  '      try {',
  '        if (Date.now() - statSync(lock).mtimeMs > LOCK_STALE_MS) unlinkSync(lock)',
  '      } catch {',
  '        // Released (or broken) by someone else in the meantime: just try again.',
  '      }',
  '      sleep(2)',
  '    }',
  '  }',
  '  try {',
  '    return fn()',
  '  } finally {',
  '    retrying(() => unlinkSync(lock))',
  '  }',
  '}',
  '',
  'export function openSettings(file) {',
  '  let cached = null',
  '  let cachedStamp = null',
  '',
  '  function stamp() {',
  '    try {',
  '      const s = statSync(file)',
  '      return `${s.ino}:${s.size}:${s.mtimeMs}`',
  '    } catch (err) {',
  '      if (err.code === \'ENOENT\') return \'missing\'',
  '      throw err',
  '    }',
  '  }',
  '',
  '  function read() {',
  '    const now = stamp()',
  '    if (cached && now === cachedStamp) return cached',
  '    try {',
  '      cached = { ...DEFAULTS, ...JSON.parse(readFileSync(file, \'utf8\')) }',
  '    } catch (err) {',
  '      if (err.code !== \'ENOENT\') throw err',
  '      cached = { ...DEFAULTS }',
  '    }',
  '    cachedStamp = now',
  '    return cached',
  '  }',
  '',
  '  /** Re-read under the lock, apply `change`, and replace the file. */',
  '  function save(change) {',
  '    withLock(file, () => {',
  '      const next = change(read())',
  '      if (!next) return',
  '      // Write-then-rename, so the other process never reads a half-written file. The',
  '      // temp name is this process\'s own, or two savers would rename each other\'s away.',
  '      const tmp = `${file}.${process.pid}.${++writes}.tmp`',
  '      writeFileSync(tmp, JSON.stringify(next, null, 2))',
  '      retrying(() => renameSync(tmp, file))',
  '      cached = next',
  '      cachedStamp = stamp()',
  '    })',
  '  }',
  '',
  '  return {',
  '    get: () => structuredClone(read()),',
  '    update(patch) {',
  '      save((s) => ({ ...s, ...patch }))',
  '    },',
  '    allow(rule) {',
  '      save((s) => (s.allow.includes(rule) ? null : { ...s, allow: [...s.allow, rule] }))',
  '    },',
  '    revoke(rule) {',
  '      save((s) => ({ ...s, allow: s.allow.filter((r) => r !== rule) }))',
  '    },',
  '    /** The permission check: is this command pre-approved? */',
  '    isAllowed: (command) => read().allow.includes(command)',
  '  }',
  '}',
  ''
].join('\n')

/**
 * From Houston PR #457, and #327 before it: settings.json was cached per process
 * forever, so the desktop app and the terminal client, which share the file, clobbered
 * each other, and a permission rule revoked in one stayed live in the other and got
 * written back. The cache is there on purpose (the permission check runs on every tool
 * call), so the fix is to notice the file changed, not to drop caching. The visible
 * test is the first report, a terminal change the running app never sees.
 *
 * The holdout checks the other reads of the same cache (the permission check, and the
 * read-modify-write behind every update, which must not resurrect a revoked rule) and
 * the prompt's second report: four processes saving at the same instant. That needs a
 * lock around read-modify-write, and a temp file per writer, because they all write
 * `settings.json.tmp` and rename each other's away. A refreshed cache alone loses most
 * of the 160 saves every run.
 */
export const task: EvalTask = {
  id: 'settings-two-processes',
  title: 'Keep two processes from clobbering a shared settings file',
  prompt:
    "Changes I make in the terminal client's settings don't show up in the desktop app while it's running; I have to restart the app to see them. Both use the same settings file. Also, when the two save at about the same moment, one of the changes sometimes just vanishes. `node test.mjs` reproduces the first problem. Fix it. test.mjs is the spec, so do not change it.",
  verify: { cmd: 'node', args: ['test.mjs'] },
  // The permission check and the writes read the same stale copy.
  holdout: { cmd: 'node', args: ['hidden.test.mjs'] },
  script: [
    turn(callTool('c1', 'run_shell', { command: 'node test.mjs' })),
    turn(callTool('c2', 'read_file', { path: 'src/settings.mjs' }), callTool('c3', 'read_file', { path: 'src/cli.mjs' })),
    turn(callTool('c4', 'write_file', { path: 'src/settings.mjs', content: SETTINGS })),
    turn(callTool('c5', 'run_shell', { command: 'node test.mjs' })),
    turn(
      say(
        "The parsed settings were cached for the life of the process, so the app never saw the terminal's writes and its next save put its stale copy back. The cache now reloads when the file's inode, size or mtime changes, which covers `get()`, the permission check and every save. Simultaneous saves were a second bug: each process read, merged and wrote back without coordinating, through one shared temp file name. Saves now hold a lock file while they re-read and merge, and each write uses its own temp file. `node test.mjs` prints ok."
      )
    )
  ]
}
