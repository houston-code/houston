import { spawnSync } from 'node:child_process'

/**
 * Put text on the system clipboard, for the terminal's `/copy`, by handing it to
 * the helper the platform ships (pbcopy, wl-copy, xclip, clip.exe) on stdin.
 *
 * The terminal also sends OSC 52, which works over SSH but only where the terminal
 * allows it; this is the local path that works whatever the terminal is. Like
 * `clipboard-image.ts` it is best-effort: a missing helper or a headless box just
 * reports false. The helper is spawned with an argv array, never a shell, and the
 * text travels on stdin, so nothing in it is ever parsed as a command.
 */

/** How text reaches the clipboard on this platform. */
export interface ClipboardTextWriter {
  cmd: string
  args: string[]
}

/**
 * The writer for this platform, or null when there is none to use. Pure, so the
 * per-platform choice is testable without the platform.
 *
 * Over SSH a local helper would fill the remote machine's clipboard (or fail with
 * no display), not the user's, so none is used there: OSC 52 is the way through.
 * Wayland is checked before X11 for the same reason as the image reader: a Wayland
 * session often has xclip installed but unable to reach the real clipboard.
 */
export function clipboardTextWriter(
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv = process.env
): ClipboardTextWriter | null {
  if (env.SSH_CONNECTION || env.SSH_TTY || env.SSH_CLIENT) return null
  if (platform === 'darwin') return { cmd: 'pbcopy', args: [] }
  if (platform === 'win32') return { cmd: 'clip.exe', args: [] }
  if (platform === 'linux') {
    if (env.WAYLAND_DISPLAY) return { cmd: 'wl-copy', args: [] }
    if (env.DISPLAY) return { cmd: 'xclip', args: ['-selection', 'clipboard', '-in'] }
    return null
  }
  return null
}

/** Copy `text` to the system clipboard. True when the helper took it; never throws. */
export function writeClipboardText(
  text: string,
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env
): boolean {
  const writer = clipboardTextWriter(platform, env)
  if (!writer) return false
  try {
    // clip.exe reads its input in the console's code page unless it starts with a
    // byte order mark; UTF-16LE with a BOM keeps non-ASCII text intact.
    const input = platform === 'win32' ? Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')]) : text
    const res = spawnSync(writer.cmd, writer.args, {
      input,
      // xclip forks to keep serving the selection; ignoring its output lets it go.
      stdio: ['pipe', 'ignore', 'ignore'],
      timeout: 5000,
      windowsHide: true
    })
    return !res.error && res.status === 0
  } catch {
    return false
  }
}
