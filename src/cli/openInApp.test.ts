import { describe, expect, it, vi } from 'vitest'
import { parseDeepLink } from '@shared/deepLink'
import { runOpenCommand, urlOpener, type OpenInAppDeps } from './openInApp'

function deps(over: Partial<OpenInAppDeps> = {}): OpenInAppDeps & { out: ReturnType<typeof vi.fn>; err: ReturnType<typeof vi.fn> } {
  return {
    cwd: '/work',
    platform: 'darwin',
    resolveDirectory: (p) => (p.startsWith('/work') ? p : null),
    launch: vi.fn(async () => {}),
    out: vi.fn(),
    err: vi.fn(),
    ...over
  } as OpenInAppDeps & { out: ReturnType<typeof vi.fn>; err: ReturnType<typeof vi.fn> }
}

describe('houston open', () => {
  it('opens the current folder by default through the OS URL handler', async () => {
    const d = deps()
    expect(await runOpenCommand([], d)).toBe(0)
    const [cmd, args] = (d.launch as ReturnType<typeof vi.fn>).mock.calls[0] as [string, string[]]
    expect(cmd).toBe('open')
    expect(parseDeepLink(args[0])).toEqual({ type: 'open-folder', path: '/work' })
  })

  it('resolves a relative folder against the working directory', async () => {
    const d = deps()
    expect(await runOpenCommand(['sub dir'], d)).toBe(0)
    const [, args] = (d.launch as ReturnType<typeof vi.fn>).mock.calls[0] as [string, string[]]
    expect(parseDeepLink(args[args.length - 1])).toEqual({ type: 'open-folder', path: '/work/sub dir' })
  })

  it('refuses a path that is not a folder, extra arguments, and unknown flags', async () => {
    expect(await runOpenCommand(['/elsewhere'], deps())).toBe(1)
    expect(await runOpenCommand(['a', 'b'], deps())).toBe(2)
    expect(await runOpenCommand(['--force'], deps())).toBe(2)
  })

  it('reports a launcher failure', async () => {
    const d = deps({ launch: async () => Promise.reject(new Error('spawn xdg-open ENOENT')) })
    expect(await runOpenCommand([], d)).toBe(1)
    expect(d.err.mock.calls.flat().join('')).toMatch(/Could not open the Houston app/)
  })

  it('passes the link as one argument on every platform, never through a shell', () => {
    const url = 'houston://open?path=%2Fa%26b'
    expect(urlOpener('darwin', url)).toEqual({ cmd: 'open', args: [url] })
    expect(urlOpener('linux', url)).toEqual({ cmd: 'xdg-open', args: [url] })
    expect(urlOpener('win32', url)).toEqual({ cmd: 'rundll32.exe', args: ['url.dll,FileProtocolHandler', url] })
  })
})
