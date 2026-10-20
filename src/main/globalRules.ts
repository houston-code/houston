import { mkdirSync, readFileSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import type { AppSettings, LegacyRulesDecideResult } from '@shared/types'
import {
  GLOBAL_RULES_DIRNAME,
  GLOBAL_RULES_FILE,
  MAX_IMPORT_DEPTH,
  importTargets
} from './agent/rules'
import { writeFileAtomicSync } from './atomic-write'

/**
 * Houston's global rules file, `~/.houston/AGENTS.md`, and the one-time offer to
 * import a pre-existing `~/.claude/CLAUDE.md` into it.
 *
 * Houston used to load `~/.claude/CLAUDE.md` as its global layer. That file usually
 * belongs to another tool and is written for it, so Houston now owns its own file
 * and loads the old one only when the user imports it with a single
 * `@~/.claude/CLAUDE.md` line. Someone who relied on the old behavior would
 * otherwise lose those rules silently, hence the notice: shown once, while the old
 * file exists and the new one doesn't import it.
 */

/** The directory holding Houston's global rules file. */
export function globalRulesDir(home: string = homedir()): string {
  return join(home, GLOBAL_RULES_DIRNAME)
}

/** Houston's global rules file. */
export function globalRulesFile(home: string = homedir()): string {
  return join(globalRulesDir(home), GLOBAL_RULES_FILE)
}

/** The rules file Houston loaded globally before it had its own. */
export function legacyRulesFile(home: string = homedir()): string {
  return join(home, '.claude', 'CLAUDE.md')
}

/** The import line that brings the legacy file into the global one. */
export const LEGACY_RULES_IMPORT = '@~/.claude/CLAUDE.md'

/** Heading for a global rules file Houston creates itself. */
export const GLOBAL_RULES_HEADING = '# Global instructions'

/** A file's text, or null when it's missing or unreadable (a directory included). */
export function readTextOrNull(path: string): string | null {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return null
  }
}

/** Canonical path (symlinks resolved), or the plain resolved path when it doesn't exist. */
function canonical(path: string): string {
  try {
    return realpathSync(path)
  } catch {
    return resolve(path)
  }
}

/**
 * Whether the global file already brings in the legacy rules: it IS the legacy file
 * (a symlink either way), or imports it directly or through other imports. The walk
 * mirrors the loader's depth cap and compares canonical paths, so `~/`, absolute,
 * and symlinked spellings all count.
 */
function alreadyHasLegacy(home: string): boolean {
  const legacy = canonical(legacyRulesFile(home))
  const start = globalRulesFile(home)
  if (canonical(start) === legacy) return true
  const seen = new Set<string>([canonical(start)])
  let frontier: Array<{ path: string; text: string }> = []
  const startText = readTextOrNull(start)
  if (startText !== null) frontier.push({ path: start, text: startText })
  for (let depth = 1; depth <= MAX_IMPORT_DEPTH && frontier.length > 0; depth++) {
    const next: typeof frontier = []
    for (const { path, text } of frontier) {
      for (const target of importTargets(text, dirname(path), home)) {
        const real = canonical(target)
        if (real === legacy) return true
        if (seen.has(real)) continue
        seen.add(real)
        const body = readTextOrNull(target)
        if (body !== null) next.push({ path: target, text: body })
      }
    }
    frontier = next
  }
  return false
}

/**
 * Whether the move notice applies: the legacy file exists with content, and the
 * global file doesn't import it. Whether the user already dismissed it is the
 * caller's concern (that lives in settings).
 */
export function legacyRulesNoticeApplies(home: string = homedir()): boolean {
  // Blank counts as absent, exactly as the rules loader treats it.
  if (!readTextOrNull(legacyRulesFile(home))?.trim()) return false
  return !alreadyHasLegacy(home)
}

/**
 * Add the legacy import to the global rules file, creating it if needed. The line
 * goes first (under the file's own top heading, when it has one) so the user's
 * Houston-specific rules come after it and win where the two disagree. Idempotent:
 * a file that already imports the legacy one is left as is. Returns the file path.
 */
export function importLegacyRules(home: string = homedir()): string {
  const file = globalRulesFile(home)
  // Already there (including a symlink between the two files, where writing would
  // replace the link with a copy, or make the file import itself).
  if (alreadyHasLegacy(home)) return file
  const current = readTextOrNull(file)
  let next: string
  if (current === null || !current.trim()) {
    next = `${GLOBAL_RULES_HEADING}\n\n${LEGACY_RULES_IMPORT}\n`
  } else {
    const heading = /^# [^\n]*(?:\n|$)/.exec(current)
    if (heading) {
      const head = heading[0].endsWith('\n') ? heading[0] : `${heading[0]}\n`
      const rest = current.slice(heading[0].length).replace(/^\n*/, '')
      next = `${head}\n${LEGACY_RULES_IMPORT}\n${rest ? `\n${rest}` : ''}`
    } else {
      next = `${LEGACY_RULES_IMPORT}\n\n${current}`
    }
  }
  mkdirSync(globalRulesDir(home), { recursive: true })
  writeFileAtomicSync(file, next)
  return file
}

/** The settings operations {@link decideLegacyRulesNotice} needs (injected for tests). */
export interface LegacyRulesDecideDeps {
  current: () => AppSettings
  dismiss: () => AppSettings
  importRules?: () => string
}

/**
 * Apply the user's answer to the desktop banner. 'import' adds the import line
 * first; if that write fails the error is returned and NOTHING is recorded, so the
 * banner stays up to retry. Either successful answer dismisses it for good. Any
 * other value is ignored.
 */
export function decideLegacyRulesNotice(
  choice: unknown,
  deps: LegacyRulesDecideDeps
): LegacyRulesDecideResult {
  if (choice !== 'import' && choice !== 'keep') return { settings: deps.current() }
  let file: string | undefined
  if (choice === 'import') {
    try {
      file = (deps.importRules ?? (() => importLegacyRules()))()
    } catch (err) {
      return { settings: deps.current(), error: (err as Error).message }
    }
  }
  return { settings: deps.dismiss(), ...(file ? { file } : {}) }
}
