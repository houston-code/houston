import { spawn } from 'node:child_process'
import { realpathSync, statSync } from 'node:fs'
import { basename, resolve } from 'node:path'
import { chatDeepLink, folderDeepLink, isConversationId } from '@shared/deepLink'

/**
 * `houston open [dir]`: hand a folder to the desktop app as a new chat, and
 * `houston open --chat <id>`: hand it a saved chat (a `houston://chat/<id>` link; the
 * app says so when the chat no longer exists). The folder
 * travels as a `houston://open?path=…` link, opened through the OS's own URL handler
 * so it reaches whichever Houston install registered the scheme (and the running app,
 * through its single-instance lock). The app asks before opening a folder it has never
 * seen, the same as for any other link.
 *
 * Every launcher is called with an argv array, never a shell string: the link holds a
 * user path, which may contain shell metacharacters.
 */

export const OPEN_USAGE =
  'Usage: houston open [dir]         open a folder in the Houston desktop app (default: the current folder)\n' +
  '       houston open --chat <id>   open a saved chat in the Houston desktop app'

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
  if (args[0] === '--chat' || args[0]?.startsWith('--chat=')) {
    const id = args[0] === '--chat' ? args[1] : args[0].slice('--chat='.length)
    const extra = args[0] === '--chat' ? args.slice(2) : args.slice(1)
    if (!id || extra.length > 0) {
      deps.err(`${OPEN_USAGE}\n`)
      return 2
    }
    if (!isConversationId(id)) {
      deps.err('Not a chat id. Chat ids look like 1b4e28ba-2fa1-11d2-883f-0016d3cca427 (houston prints one when you leave a chat).\n')
      return 2
    }
    return launchLink(chatDeepLink(id.toLowerCase()), 'Opening the chat in Houston.', deps)
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
  return launchLink(folderDeepLink(dir), `Opening ${dir} in Houston.`, deps)
}

async function launchLink(link: string, done: string, deps: OpenInAppDeps): Promise<number> {
  const { cmd, args: argv } = urlOpener(deps.platform, link)
  try {
    await deps.launch(cmd, argv)
  } catch (e) {
    deps.err(`Could not open the Houston app: ${(e as Error).message}\nIs the desktop app installed?\n`)
    return 1
  }
  deps.out(`${done}\n`)
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

/** How long to wait for an opener's exit status before taking a running one as success. */
const OPENER_EXIT_WAIT_MS = 5_000

/**
 * Run the opener detached. Resolves once it handed the link on, and rejects when it
 * can't start or exits non-zero (`open` and `xdg-open` fail that way when nothing
 * handles the link). `rundll32` always exits 0, so it counts as done once started; an
 * opener still running after a few seconds is taken as having opened the link.
 *
 * The child and the wait stay referenced until one of those settles the promise: with
 * nothing else pending, an unreferenced pair let Node exit with the command still
 * waiting, so it printed nothing and exited 0 even when the opener failed. Only an
 * opener still running once the promise settles is let go, so this process can exit
 * without waiting for it.
 */
export function launchDetached(cmd: string, args: string[], waitMs = OPENER_EXIT_WAIT_MS): Promise<void> {
  const spawnOnly = /^rundll32(\.exe)?$/i.test(basename(cmd))
  return new Promise((done, fail) => {
    const child = spawn(cmd, args, { stdio: 'ignore', detached: true, shell: false })
    let timer: NodeJS.Timeout | undefined
    const release = (): void => {
      if (timer) clearTimeout(timer)
      child.unref()
    }
    child.once('error', (e) => {
      release()
      fail(e)
    })
    child.once('spawn', () => {
      if (spawnOnly) {
        release()
        return done()
      }
      timer = setTimeout(() => {
        release()
        done()
      }, waitMs)
    })
    child.once('exit', (code, signal) => {
      release()
      if (spawnOnly) return
      if (code === 0) done()
      else fail(new Error(`${basename(cmd)} ${signal ? `was stopped by ${signal}` : `exited with code ${code}`}`))
    })
  })
}
