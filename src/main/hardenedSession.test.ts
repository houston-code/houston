import { describe, expect, it } from 'vitest'
import { hardenUntrustedSession, type LockableSession } from './hardenedSession'

/** A fake Session that records the handlers hardenUntrustedSession installs. */
function fakeSession(): {
  ses: LockableSession
  beforeRequest: (url: string) => boolean
  hasDownloadBlock: () => boolean
  permissionGranted: (permission: string) => boolean
} {
  let onBeforeRequest:
    | ((details: { url: string }, cb: (r: { cancel: boolean }) => void) => void)
    | null = null
  let willDownload: ((event: { preventDefault: () => void }) => void) | null = null
  let permissionHandler:
    | ((wc: unknown, permission: string, cb: (granted: boolean) => void) => void)
    | null = null

  const ses: LockableSession = {
    webRequest: {
      onBeforeRequest: (listener) => {
        onBeforeRequest = listener
      }
    },
    on: (_event, listener) => {
      willDownload = listener
    },
    setPermissionRequestHandler: (handler) => {
      permissionHandler = handler
    }
  }

  return {
    ses,
    // Returns whether the subresource request to `url` was cancelled.
    beforeRequest: (url) => {
      let cancelled = false
      onBeforeRequest?.({ url }, (r) => {
        cancelled = r.cancel
      })
      return cancelled
    },
    hasDownloadBlock: () => {
      if (!willDownload) return false
      let prevented = false
      willDownload({ preventDefault: () => (prevented = true) })
      return prevented
    },
    permissionGranted: (permission) => {
      let granted = true
      permissionHandler?.(null, permission, (g) => {
        granted = g
      })
      return granted
    }
  }
}

describe('hardenUntrustedSession', () => {
  it('cancels subresource requests to private, LAN, and metadata hosts', () => {
    const f = fakeSession()
    hardenUntrustedSession(f.ses)
    expect(f.beforeRequest('http://169.254.169.254/latest/meta-data/')).toBe(true) // cloud metadata
    expect(f.beforeRequest('http://10.0.0.5/')).toBe(true) // private
    expect(f.beforeRequest('http://192.168.1.1/')).toBe(true) // LAN
    expect(f.beforeRequest('http://[fd00::1]/')).toBe(true) // unique-local IPv6
  })

  it('allows subresource requests to loopback and public hosts', () => {
    const f = fakeSession()
    hardenUntrustedSession(f.ses)
    expect(f.beforeRequest('http://127.0.0.1:5173/app.js')).toBe(false) // the dev server
    expect(f.beforeRequest('http://localhost:3000/main.css')).toBe(false)
    expect(f.beforeRequest('https://cdn.jsdelivr.net/x.js')).toBe(false) // public CDN
    expect(f.beforeRequest('data:text/plain,hi')).toBe(false) // no network egress
  })

  it('blocks downloads from an untrusted page', () => {
    const f = fakeSession()
    hardenUntrustedSession(f.ses)
    expect(f.hasDownloadBlock()).toBe(true)
  })

  it('denies every device/notification permission an untrusted page requests', () => {
    const f = fakeSession()
    hardenUntrustedSession(f.ses)
    for (const permission of ['media', 'geolocation', 'notifications', 'clipboard-read', 'midi']) {
      expect(f.permissionGranted(permission)).toBe(false)
    }
  })
})
