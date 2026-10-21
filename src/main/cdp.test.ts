import { afterEach, describe, expect, it, vi } from 'vitest'
import type { WebContents } from 'electron'
import { CDP_TIMEOUT_MS, attachCdp, cdpFullPage, emulateViewport } from './cdp'

/** A fake WebContents debugger recording commands; `answer` decides each reply. */
function fakeWc(answer: (method: string, params?: object) => Promise<unknown> = async () => ({})) {
  let attached = false
  const sent: [string, object | undefined][] = []
  const listeners: ((e: unknown, method: string, params: unknown) => void)[] = []
  const debuggerFake = {
    isAttached: () => attached,
    attach: vi.fn(() => {
      attached = true
    }),
    detach: vi.fn(() => {
      if (!attached) throw new Error('not attached')
      attached = false
    }),
    sendCommand: (method: string, params?: object) => {
      sent.push([method, params])
      return answer(method, params)
    },
    on: (_event: string, l: (e: unknown, method: string, params: unknown) => void) => listeners.push(l)
  }
  return { wc: { debugger: debuggerFake } as unknown as WebContents, sent, debuggerFake, emit: (m: string, p: unknown) => listeners.forEach((l) => l({}, m, p)) }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('attachCdp', () => {
  it('attaches once and detaches safely, even twice', () => {
    const { wc, debuggerFake } = fakeWc()
    const cdp = attachCdp(wc)
    attachCdp(wc)
    expect(debuggerFake.attach).toHaveBeenCalledTimes(1)
    cdp.detach()
    cdp.detach()
    expect(debuggerFake.detach).toHaveBeenCalledTimes(1)
  })

  it('fails a command the page never answers instead of hanging', async () => {
    vi.useFakeTimers()
    const { wc } = fakeWc(() => new Promise(() => {}))
    const pending = attachCdp(wc).send('Page.enable')
    const assertion = expect(pending).rejects.toThrow(`did not answer Page.enable within ${CDP_TIMEOUT_MS}ms`)
    await vi.advanceTimersByTimeAsync(CDP_TIMEOUT_MS)
    await assertion
  })

  it('passes protocol events to listeners', () => {
    const { wc, emit } = fakeWc()
    const seen: string[] = []
    attachCdp(wc).on((method, params) => seen.push(`${method} ${String(params.type)}`))
    emit('Page.javascriptDialogOpening', { type: 'alert' })
    expect(seen).toEqual(['Page.javascriptDialogOpening alert'])
  })
})

describe('emulation and capture commands', () => {
  it('emulates the viewport size, device type, and color scheme', async () => {
    const { wc, sent } = fakeWc()
    await emulateViewport(attachCdp(wc), { width: 390, height: 844, mobile: true, colorScheme: 'dark' })
    expect(sent).toEqual([
      ['Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true }],
      ['Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'dark' }] }]
    ])
  })

  it('captures the full page up to the cap and says when it cut', async () => {
    const { wc, sent } = fakeWc(async (method) =>
      method === 'Page.getLayoutMetrics' ? { cssContentSize: { height: 7200.4 } } : { data: Buffer.from('png').toString('base64') }
    )
    const full = await cdpFullPage(attachCdp(wc), 1280, 800, 6000)
    expect(full).toEqual({ png: Buffer.from('png'), height: 6000, truncated: true })
    expect(sent[1]).toEqual([
      'Page.captureScreenshot',
      { format: 'png', captureBeyondViewport: true, clip: { x: 0, y: 0, width: 1280, height: 6000, scale: 1 } }
    ])
  })

  it('never captures shorter than the viewport', async () => {
    const { wc } = fakeWc(async (method) =>
      method === 'Page.getLayoutMetrics' ? { cssContentSize: { height: 300 } } : { data: '' }
    )
    expect(await cdpFullPage(attachCdp(wc), 1280, 800, 6000)).toMatchObject({ height: 800, truncated: false })
  })
})
