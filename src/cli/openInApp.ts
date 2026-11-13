import { spawn } from 'node:child_process'
import { realpathSync, statSync } from 'node:fs'
import { resolve } from 'node:path'
import { folderDeepLink } from '@shared/deepLink'

/**
 * `houston open [dir]`: hand a folder to the desktop app as a new chat. The folder
 * travels as a `houston://open?path=…` link, opened through the OS's own URL handler
 * so it reaches whichever Houston install registered the scheme (and the running app,
 * through its single-instance lock). The app asks before opening a folder it has never
 * seen, the same as for any other link.
 *
 * Every launcher is called with an argv array, never a shell string: the link holds a
 * user path, which may contain shell metacharacters.
 */

export const OPEN_USAGE = 'Usage: houston open [dir]   open a folder in the Houston desktop app (default: the current folder)'

/** The OS command that opens a URL in its registered handler. */
export function urlOpener(platform: NodeJS.Platform, url: string): { cmd: string; args: string[] } {
  if (platform === 'darwin') return { cmd: 'open', args: [url] }
  // `start` is a cmd.exe builtin that would re-parse the URL as shell text; the URL
  // protocol handler DLL takes it as a single argument instead.
  if (platform === 'win32') return { cmd: 'rundll32.exe', args: ['url.dll,FileProtocolHandler', url] }
  return { cmd: 'xdg-open', args: [url] }
}

export interface OpenInAppDeps {
  cwd: string
  platform: NodeJS.Platform
  /** The folder's canonical path when it is an existing directory, else null. */
  resolveDirectory: (path: string) => string | null
  launch: (cmd: string, args: string[]) => Promise<void>
  out: (s: string) => void
  err: (s: string) => void
}

export async function runOpenCommand(args: string[], deps: OpenInAppDeps): Promise<number> {
  const positional = args.filter((a) => !a.startsWith('-'))
  if (args.some((a) => a === '-h' || a === '--help')) {
    deps.out(`${OPEN_USAGE}\n`)
    return 0
  }
  if (positional.length > 1 || args.some((a) => a.startsWith('-'))) {
    deps.err(`${OPEN_USAGE}\n`)
    return 2
  }
  const target = resolve(deps.cwd, positional[0] ?? '.')
  const dir = deps.resolveDirectory(target)
  if (!dir) {
    deps.err(`Not a folder: ${target}\n`)
    return 1
  }
  const { cmd, args: argv } = urlOpener(deps.platform, folderDeepLink(dir))
  try {
    await deps.launch(cmd, argv)
  } catch (e) {
    deps.err(`Could not open the Houston app: ${(e as Error).message}\nIs the desktop app installed?\n`)
    return 1
  }
  deps.out(`Opening ${dir} in Houston.\n`)
  return 0
}

export function resolveDirectory(path: string): string | null {
  try {
    const real = realpathSync(path)
    return statSync(real).isDirectory() ? real : null
  } catch {
    return null
  }
}

/** Run the opener detached; resolves once it started (or rejects when it can't). */
export function launchDetached(cmd: string, args: string[]): Promise<void> {
  return new Promise((done, fail) => {
    const child = spawn(cmd, args, { stdio: 'ignore', detached: true, shell: false })
    child.once('error', fail)
    child.once('spawn', () => {
      child.unref()
      done()
    })
  })
}
