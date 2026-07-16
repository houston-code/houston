import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * Read an image out of the system clipboard, for the terminal's `/image` with no
 * path.
 *
 * The desktop app has had this forever via Electron's `clipboard.readImage()`.
 * The terminal cannot: the standalone CLI has no Electron at all, and the whole
 * vision path (`/image <path>` → attachment → provider) already works — the only
 * missing piece was getting the bytes out of the clipboard. So this shells out to
 * whatever the platform already ships, rather than adding a native dependency for
 * one feature.
 *
 * Everything here is best-effort and reports "no image" rather than throwing: a
 * clipboard with text in it, a missing helper, and a headless box are all just
 * "there is no image to paste".
 */

/** How the clipboard image is fetched on this platform. */
export interface ClipboardImageProbe {
  /** Command + args to run. */
  cmd: string
  args: string[]
  /**
   * True when the tool writes PNG bytes to stdout; false when it writes the file
   * named in `outFile` (AppleScript cannot pipe binary to stdout).
   */
  stdout: boolean
  /** A human-readable name for the "install this" hint. */
  tool: string
}

/** AppleScript: pull PNG data off the clipboard and write it to `file`. */
function appleScript(file: string): string {
  // `«class PNGf»` is the clipboard's PNG flavor. The try/error path is what makes
  // "the clipboard holds text" a non-event rather than a failure.
  return [
    'try',
    '  set png to (the clipboard as «class PNGf»)',
    `  set fh to (open for access POSIX file ${JSON.stringify(file)} with write permission)`,
    '  set eof fh to 0',
    '  write png to fh',
    '  close access fh',
    'on error',
    '  try',
    '    close access fh',
    '  end try',
    '  return "none"',
    'end try',
    'return "ok"'
  ].join('\n')
}

/**
 * The probe for this platform, or null when we have no way in. Pure, so the
 * per-platform choice is testable without the platform.
 *
 * Wayland is checked before X11: a Wayland session usually has xclip present but
 * unable to see the real clipboard, so preferring it by presence alone would
 * silently read the wrong (empty) one.
 */
export function clipboardImageProbe(
  platform: NodeJS.Platform,
  file: string,
  env: NodeJS.ProcessEnv = process.env
): ClipboardImageProbe | null {
  if (platform === 'darwin') {
    return { cmd: 'osascript', args: ['-e', appleScript(file)], stdout: false, tool: 'osascript' }
  }
  if (platform === 'linux') {
    if (env.WAYLAND_DISPLAY) {
      return { cmd: 'wl-paste', args: ['--type', 'image/png'], stdout: true, tool: 'wl-paste' }
    }
    return {
      cmd: 'xclip',
      args: ['-selection', 'clipboard', '-t', 'image/png', '-o'],
      stdout: true,
      tool: 'xclip'
    }
  }
  if (platform === 'win32') {
    // -sta is required: the clipboard API is single-threaded-apartment only, and
    // without it Get-Clipboard silently returns nothing.
    const ps = [
      'Add-Type -AssemblyName System.Windows.Forms;',
      '$img = [Windows.Forms.Clipboard]::GetImage();',
      'if ($img -eq $null) { exit 1 };',
      `$img.Save(${JSON.stringify(file)}, [System.Drawing.Imaging.ImageFormat]::Png)`
    ].join(' ')
    return {
      cmd: 'powershell',
      args: ['-sta', '-NoProfile', '-Command', ps],
      stdout: false,
      tool: 'PowerShell'
    }
  }
  return null
}

/** What to tell the user when there is no way to read the clipboard here. */
export function noClipboardHint(platform: NodeJS.Platform, env: NodeJS.ProcessEnv = process.env): string {
  if (platform === 'linux') {
    const tool = env.WAYLAND_DISPLAY ? 'wl-clipboard' : 'xclip'
    return `install ${tool} to paste images, or use /image <path>`
  }
  return 'use /image <path> instead'
}

export interface ClipboardImage {
  mediaType: string
  /** Base64 PNG. */
  data: string
}

/**
 * The clipboard's image as base64 PNG, or null when there isn't one (or we can't
 * reach it). Never throws.
 */
export function readClipboardImage(platform: NodeJS.Platform = process.platform): ClipboardImage | null {
  const dir = mkdtempSync(join(tmpdir(), 'houston-clip-'))
  const file = join(dir, 'clipboard.png')
  try {
    const probe = clipboardImageProbe(platform, file)
    if (!probe) return null
    const res = spawnSync(probe.cmd, probe.args, {
      // Binary on stdout, so no encoding: a utf8 decode would corrupt the PNG.
      maxBuffer: 32 * 1024 * 1024,
      timeout: 5000
    })
    if (res.error || res.status !== 0) return null
    const bytes = probe.stdout ? res.stdout : safeReadFile(file)
    // A clipboard holding text yields an empty (or absent) result, not an error.
    if (!bytes || bytes.length === 0) return null
    if (!isPng(bytes)) return null
    return { mediaType: 'image/png', data: bytes.toString('base64') }
  } catch {
    return null
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

function safeReadFile(file: string): Buffer | null {
  try {
    return readFileSync(file)
  } catch {
    return null
  }
}

/**
 * The PNG magic number. Checked because a helper that "succeeded" with a text
 * payload would otherwise be base64'd and sent to the model as an image, which
 * fails deep in the provider with a confusing error instead of here with a clear one.
 */
export function isPng(buf: Buffer): boolean {
  const magic = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
  return buf.length > magic.length && magic.every((b, i) => buf[i] === b)
}
