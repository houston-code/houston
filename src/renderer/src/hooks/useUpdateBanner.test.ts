import { act, renderHook } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { DOWNLOAD_URL } from '@shared/update'
import type {
  UpdateCheckResult,
  UpdateDownloaded,
  UpdateDownloadProgress,
  UpdateInstallFailed
} from '@shared/update'
import { useUpdateBanner } from './useUpdateBanner'

type Available = Extract<UpdateCheckResult, { status: 'available' }>

const available: Available = {
  status: 'available',
  currentVersion: '1.0.0',
  latestVersion: '1.1.0',
  releaseUrl: DOWNLOAD_URL,
  autoInstall: true
}

function progress(percent: number): UpdateDownloadProgress {
  return { percent, bytesPerSecond: 1000, transferred: percent, total: 100 }
}

/** Install a fake `window.api` exposing the four updater subscriptions and the download
 *  cancel; returns emitters. */
function installApi() {
  const handlers: {
    available?: (u: Available) => void
    progress?: (p: UpdateDownloadProgress) => void
    downloaded?: (d: UpdateDownloaded) => void
    failed?: (f: UpdateInstallFailed) => void
  } = {}
  const unsubscribe = vi.fn()
  const cancelUpdateDownload = vi.fn(async () => true)
  const sub =
    <K extends keyof typeof handlers>(key: K) =>
    (cb: NonNullable<(typeof handlers)[K]>) => {
      handlers[key] = cb
      return unsubscribe
    }
  window.api = {
    onUpdateAvailable: vi.fn(sub('available')),
    onUpdateDownloadProgress: vi.fn(sub('progress')),
    onUpdateDownloaded: vi.fn(sub('downloaded')),
    onUpdateInstallFailed: vi.fn(sub('failed')),
    cancelUpdateDownload
  } as unknown as typeof window.api
  return {
    unsubscribe,
    cancelUpdateDownload,
    available: (u: Available) => act(() => handlers.available!(u)),
    progress: (p: UpdateDownloadProgress) => act(() => handlers.progress!(p)),
    downloaded: (d: UpdateDownloaded) => act(() => handlers.downloaded!(d)),
    failed: (f: UpdateInstallFailed) => act(() => handlers.failed!(f))
  }
}

describe('useUpdateBanner', () => {
  it('tracks the download through to ready-to-install', () => {
    const emit = installApi()
    const { result } = renderHook(() => useUpdateBanner())

    emit.available(available)
    emit.progress(progress(40))
    expect(result.current.update).toEqual(available)
    expect(result.current.progress?.percent).toBe(40)

    emit.downloaded({ version: '1.1.0' })
    expect(result.current.progress).toBeNull()
    expect(result.current.downloaded).toEqual({ version: '1.1.0' })
  })

  it('stays dismissed while the download keeps reporting progress', () => {
    const emit = installApi()
    const { result } = renderHook(() => useUpdateBanner())
    emit.available(available)
    emit.progress(progress(83))

    act(() => result.current.dismiss())
    emit.progress(progress(84))
    emit.progress(progress(90))

    expect(result.current.update).toBeNull()
    expect(result.current.progress).toBeNull()
  })

  it('cancels the download when dismissed', () => {
    const emit = installApi()
    const { result } = renderHook(() => useUpdateBanner())
    emit.available(available)
    emit.progress(progress(30))

    act(() => result.current.dismiss())

    expect(emit.cancelUpdateDownload).toHaveBeenCalledOnce()
  })

  it('still dismisses when the cancel request fails', async () => {
    const emit = installApi()
    emit.cancelUpdateDownload.mockRejectedValueOnce(new Error('ipc gone'))
    const { result } = renderHook(() => useUpdateBanner())
    emit.available(available)

    await act(async () => result.current.dismiss())

    expect(result.current.update).toBeNull()
  })

  it('resurfaces on the next check', () => {
    const emit = installApi()
    const { result } = renderHook(() => useUpdateBanner())
    emit.available(available)
    act(() => result.current.dismiss())

    emit.available(available)
    emit.progress(progress(10))

    expect(result.current.update).toEqual(available)
    expect(result.current.progress?.percent).toBe(10)
  })

  it('resurfaces when a dismissed download finishes or is refused', () => {
    const emit = installApi()
    const { result } = renderHook(() => useUpdateBanner())
    emit.progress(progress(50))
    act(() => result.current.dismiss())

    emit.downloaded({ version: '1.1.0' })
    expect(result.current.downloaded).toEqual({ version: '1.1.0' })

    act(() => result.current.dismiss())
    emit.failed({ version: '1.1.0', releaseUrl: DOWNLOAD_URL })
    expect(result.current.failed).toEqual({ version: '1.1.0', releaseUrl: DOWNLOAD_URL })
  })

  it('keeps a refused version across re-checks of it, and drops it for a newer one', () => {
    const emit = installApi()
    const { result } = renderHook(() => useUpdateBanner())
    emit.failed({ version: '1.1.0', releaseUrl: DOWNLOAD_URL })

    emit.available(available)
    expect(result.current.failed?.version).toBe('1.1.0')

    emit.available({ ...available, latestVersion: '1.2.0' })
    expect(result.current.failed).toBeNull()
  })

  it('unsubscribes on unmount', () => {
    const emit = installApi()
    const { unmount } = renderHook(() => useUpdateBanner())
    unmount()
    expect(emit.unsubscribe).toHaveBeenCalledTimes(4)
  })
})
