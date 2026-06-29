import { shell } from 'electron'
import { spawn } from 'node:child_process'
import { existsSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { resolveBinaryPath } from './agent/format'
import { log } from './logger'
import { EDITORS, editorById, type EditorDef, type EditorStatus, type OpenResult } from '@shared/editors'

/**
 * "Open project in <editor>" and "Reveal in <file manager>" — a *user gesture*
 * (never an agent tool), so it runs unsandboxed. Editors are launched with an argv
 * array (never a shell string) and the directory is validated as an existing
 * absolute path, so a path can't be read as a flag or smuggle shell metacharacters.
 */

/** Standard macOS app dirs probed for the `open -a` fallback. */
function macAppDirs(): string[] {
  return ['/Applications', join(homedir(), 'Applications')]
}

/** Whether an editor's macOS .app bundle is installed (enables the open -a fallback). */
function macAppPresent(app: string, exists: (p: string) => boolean): boolean {
  return macAppDirs().some((d) => exists(join(d, `${app}.app`)))
}

export interface DetectDeps {
  platform?: NodeJS.Platform
  /** Resolve a CLI launcher to its full path, or null (default: the real PATH probe). */
  resolveBin?: (bin: string) => string | null
  /** Path-existence check, for the macOS .app probe (default: real fs). */
  exists?: (p: string) => boolean
}

/**
 * Which supported editors can be launched on this machine. An editor is "available"
 * when its CLI resolves, or (macOS only) its .app bundle is installed. Deps are
 * injectable so the logic is unit-testable without a real filesystem.
 */
export function detectEditors(deps: DetectDeps = {}): EditorStatus[] {
  const platform = deps.platform ?? process.platform
  const resolveBin = deps.resolveBin ?? ((b: string) => resolveBinaryPath(b))
  const exists = deps.exists ?? existsSync
  const onMac = platform === 'darwin'
  return EDITORS.map((e) => ({
    id: e.id,
    label: e.label,
    // macOS-only editors (Xcode) are never available elsewhere — and only there can
    // its CLI hit count, since the bare name collides with an unrelated Linux tool.
    available: e.macOnly
      ? onMac && (resolveBin(e.bin) !== null || macAppPresent(e.macAppName, exists))
      : resolveBin(e.bin) !== null || (onMac && macAppPresent(e.macAppName, exists))
  }))
}

export interface LaunchPlan {
  cmd: string
  args: string[]
}

/**
 * Pure planner for how to open `dir` in `editor`. On macOS, when the editor's .app
 * is installed, launch by exact app name (`open -a <app> <dir>`): the bare CLI
 * launcher is easily shadowed on PATH by a VS Code fork's shim — Cursor installs
 * its own `code` — so resolving `code` could silently open the wrong editor.
 * LaunchServices resolves the app by name, so the chosen editor always opens.
 * Otherwise use the resolved CLI (`<bin> <dir>`), which is the only option off
 * macOS and the fallback when no .app is present. Returns null when neither exists.
 */
export function planEditorLaunch(
  editor: EditorDef,
  dir: string,
  platform: NodeJS.Platform,
  binPath: string | null,
  appPresent: boolean
): LaunchPlan | null {
  if (platform === 'darwin' && appPresent) return { cmd: 'open', args: ['-a', editor.macAppName, dir] }
  if (binPath) return { cmd: binPath, args: [dir] }
  return null
}

/** Whether `dir` is an absolute path to an existing directory (the only thing we open). */
function isOpenableDir(dir: unknown, exists: (p: string) => boolean): dir is string {
  if (typeof dir !== 'string' || dir.length === 0 || !isAbsolute(dir)) return false
  try {
    return exists(dir) && statSync(dir).isDirectory()
  } catch {
    return false
  }
}

export interface OpenDeps {
  /** Override the host platform (default: the real one). Injectable for tests. */
  platform?: NodeJS.Platform
  /** Path-existence check for the dir + macOS .app probe (default: real fs). */
  exists?: (p: string) => boolean
}

/** Open the project directory `dir` in the editor identified by `editorId`. */
export function openProjectInEditor(editorId: string, dir: string, deps: OpenDeps = {}): OpenResult {
  const platform = deps.platform ?? process.platform
  const exists = deps.exists ?? existsSync
  const editor = editorById(editorId)
  if (!editor) return { ok: false, error: `Unknown editor: ${editorId}` }
  if (!isOpenableDir(dir, exists)) return { ok: false, error: 'No project folder to open.' }

  const binPath = resolveBinaryPath(editor.bin)
  const appPresent = platform === 'darwin' && macAppPresent(editor.macAppName, exists)
  const plan = planEditorLaunch(editor, dir, platform, binPath, appPresent)
  if (!plan) return { ok: false, error: `${editor.label} isn't installed.` }

  try {
    const child = spawn(plan.cmd, plan.args, { detached: true, stdio: 'ignore' })
    // ENOENT and the like surface asynchronously on a detached spawn; log, don't crash.
    child.on('error', (err) => log.warn(`Open in ${editor.id} failed: ${err.message}`))
    child.unref()
    return { ok: true }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    log.warn(`Open in ${editor.id} failed: ${msg}`)
    return { ok: false, error: `Couldn't launch ${editor.label}.` }
  }
}

/** Reveal `dir` in the OS file manager (Finder / Explorer / default). */
export function revealInFileManager(target: string): OpenResult {
  if (!isOpenableDir(target, existsSync)) return { ok: false, error: 'No folder to reveal.' }
  shell.showItemInFolder(target)
  return { ok: true }
}
