import { lstatSync, realpathSync, statSync } from 'node:fs'
import { basename, extname, isAbsolute, relative, sep } from 'node:path'

/**
 * The one gate in front of every `shell.openPath` call in the main process.
 *
 * `shell.openPath` hands a path to the OS "open" verb (LaunchServices on macOS,
 * ShellExecute on Windows, xdg-open on Linux), which picks a handler by what the
 * file IS, not by what it is called. A containment check alone ("does it resolve
 * inside the project?") is therefore not enough:
 *
 * - macOS follows a symlink and chooses the app by the TARGET's type. A committed
 *   `notes.md -> run.command` (git clones carry no quarantine flag) launches
 *   Terminal and runs the script, unsandboxed, when the user clicks Open on what
 *   the UI shows as a Markdown file.
 * - A launchable file opened directly (`.command`, `.app`, `.exe`, `.desktop`, an
 *   extensionless file with the exec bit, which macOS runs in Terminal) runs code,
 *   which is never what "open this file" in a code viewer means.
 * - A directory can be a bundle (`x.app`), which the open verb launches.
 *
 * So the target is read with lstat + realpath, the REAL path is what gets opened
 * (never the link), a link whose target has a different extension is refused (the
 * name the user saw is not the type the OS would act on), and anything that can
 * launch a program is shown in its folder instead of opened. Callers that only
 * ever mean a Markdown file (Settings > Customize, instruction files) also require
 * a regular `.md` file. Everything here is synchronous and pure except for the
 * filesystem reads, and the open/reveal side effects are injected, so the policy
 * is unit-testable without Electron.
 */

/** Launch types per platform: opening one runs code rather than showing a document. */
const LAUNCH_EXTENSIONS: Record<'darwin' | 'win32' | 'linux', ReadonlySet<string>> = {
  darwin: new Set([
    '.app', '.command', '.tool', '.terminal', '.pkg', '.mpkg', '.scpt', '.scptd', '.applescript',
    '.workflow', '.action', '.webloc', '.inetloc', '.fileloc', '.jar', '.sh', '.bash', '.zsh', '.csh',
    '.ksh', '.tcsh', '.fish', '.prefpane', '.saver', '.wdgt', '.osax', '.kext', '.plugin', '.service'
  ]),
  win32: new Set([
    '.exe', '.bat', '.cmd', '.com', '.lnk', '.url', '.ps1', '.psm1', '.psd1', '.ps1xml', '.vbs', '.vbe',
    '.js', '.jse', '.wsf', '.wsh', '.ws', '.hta', '.msi', '.msp', '.msc', '.scr', '.cpl', '.pif', '.reg',
    '.jar', '.inf', '.sct', '.scf', '.chm', '.application', '.appref-ms', '.gadget', '.settingcontent-ms',
    '.library-ms', '.search-ms', '.diagcab', '.appx', '.appxbundle', '.msix', '.msixbundle', '.xbap'
  ]),
  linux: new Set(['.desktop', '.sh', '.bash', '.zsh', '.run', '.appimage', '.jar'])
}

function launchSet(platform: NodeJS.Platform): ReadonlySet<string> {
  if (platform === 'darwin' || platform === 'win32') return LAUNCH_EXTENSIONS[platform]
  return LAUNCH_EXTENSIONS.linux
}

/**
 * A file name's extension as the OS reads it, lowercased. Windows ignores trailing
 * dots and spaces (`run.exe.` and `run.exe ` are `run.exe`), so they are dropped first.
 */
export function osExtension(name: string, platform: NodeJS.Platform): string {
  const base = basename(name)
  return extname(platform === 'win32' ? base.replace(/[. ]+$/, '') : base).toLowerCase()
}

/** Whether opening a file with this name would launch a program on `platform`. */
export function isLaunchType(name: string, platform: NodeJS.Platform): boolean {
  return launchSet(platform).has(osExtension(name, platform))
}

export interface OpenCheckOptions {
  /** The host platform (default: the real one). */
  platform?: NodeJS.Platform
  /** Only a regular `.md` file may be opened (Customize items, instruction files). */
  markdownOnly?: boolean
  /** The real path must sit inside this folder (symlinks followed on both sides). */
  within?: string
  /** The target is a folder to show in the file manager, not a file. */
  folder?: boolean
}

/** What to do with a path the renderer or a caller asked to open. */
export type OpenCheck =
  | { action: 'open'; path: string }
  | { action: 'reveal'; path: string; error: string }
  | { action: 'refuse'; error: string }

function inside(root: string, abs: string): boolean {
  const rel = relative(root, abs)
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
}

/** Decide whether `path` may be handed to the OS open verb, and which path to hand it. */
export function checkOpenTarget(path: string, opts: OpenCheckOptions = {}): OpenCheck {
  const platform = opts.platform ?? process.platform
  const missing: OpenCheck = { action: 'refuse', error: opts.folder ? 'That folder no longer exists.' : 'That file no longer exists.' }
  if (typeof path !== 'string' || !path || !isAbsolute(path)) return missing
  let real: string
  let st
  try {
    lstatSync(path) // a dangling link fails here as missing, like a missing file
    real = realpathSync(path)
    st = statSync(real)
  } catch {
    return missing
  }
  if (opts.within !== undefined) {
    let root: string
    try {
      root = realpathSync(opts.within)
    } catch {
      return { action: 'refuse', error: 'That file is outside its folder.' }
    }
    if (!inside(root, real)) return { action: 'refuse', error: 'That file is outside its folder.' }
  }
  // An NTFS alternate data stream (`a.md:evil.exe`) or any other colon in the name.
  if (platform === 'win32' && basename(real).includes(':')) {
    return { action: 'refuse', error: "Houston can't open that file." }
  }
  const name = basename(path)
  const shownIn = (what: string): OpenCheck => ({
    action: 'reveal',
    path: real,
    error: `${name} ${what}, so Houston showed it in its folder instead of opening it.`
  })

  if (opts.folder) {
    if (!st.isDirectory()) return { action: 'refuse', error: 'That is not a folder.' }
    // A folder with a launch extension is an app or package bundle: opening runs it.
    if (isLaunchType(real, platform) || isLaunchType(path, platform)) return shownIn('is an app or package')
    return { action: 'open', path: real }
  }

  if (st.isDirectory()) return { action: 'refuse', error: `${name} is a folder, not a file.` }
  if (!st.isFile()) return { action: 'refuse', error: `${name} is not a regular file.` }
  // The name the user saw must be the type the OS acts on. A symlink anywhere on the
  // way (the file itself or a linked folder holding it) is judged by its real name.
  if (osExtension(path, platform) !== osExtension(real, platform)) {
    return {
      action: 'refuse',
      error: `${name} is a link to a different kind of file (${basename(real)}), so Houston didn't open it.`
    }
  }
  if (opts.markdownOnly) {
    if (osExtension(real, platform) !== '.md') return { action: 'refuse', error: 'Only Markdown files open from here.' }
    if (platform !== 'win32' && (st.mode & 0o111) !== 0) {
      return { action: 'refuse', error: `${name} is marked as a program, so Houston didn't open it.` }
    }
    return { action: 'open', path: real }
  }
  if (isLaunchType(real, platform)) return shownIn('can run a program')
  // macOS runs an executable file in Terminal; Linux file managers may run it too.
  if (platform !== 'win32' && (st.mode & 0o111) !== 0) return shownIn('is marked as a program')
  return { action: 'open', path: real }
}

export interface OpenSideEffects {
  /** Open a path in its default app; resolves to an error message, or '' on success. */
  open: (path: string) => Promise<string>
  /** Show a path selected in the file manager. Without it, a reveal is a refusal. */
  reveal?: (path: string) => void
}

export type SafeOpenResult = { ok: true } | { ok: false; error: string }

/**
 * Check `path` with {@link checkOpenTarget}, then open its real path, show it in its
 * folder, or refuse. Never hands the original (possibly linked) path to the opener.
 */
export async function openPathSafely(
  path: string,
  fx: OpenSideEffects,
  opts: OpenCheckOptions = {}
): Promise<SafeOpenResult> {
  const check = checkOpenTarget(path, opts)
  if (check.action === 'refuse') return { ok: false, error: check.error }
  if (check.action === 'reveal') {
    fx.reveal?.(check.path)
    return { ok: false, error: check.error }
  }
  const err = await fx.open(check.path)
  return err ? { ok: false, error: err } : { ok: true }
}
