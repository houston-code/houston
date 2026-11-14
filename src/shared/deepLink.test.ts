import { describe, expect, it } from 'vitest'
import { win32 } from 'node:path'
import {
  DEEP_LINK_SETTINGS_PAGES,
  MAX_DEEP_LINK_LENGTH,
  deepLinkFromArgv,
  folderDeepLink,
  isAbsoluteLocalPath,
  parseDeepLink
} from './deepLink'
import { PAGE_LABELS } from '../renderer/src/components/settings/pageIds'

const ID = '0f8fad5b-d9cb-469f-a165-70867728950e'

describe('parseDeepLink', () => {
  it('parses a folder link and round-trips paths with spaces and URL syntax', () => {
    const path = '/home/someone/My Projects/a&b?c#d'
    expect(parseDeepLink(folderDeepLink(path))).toEqual({ type: 'open-folder', path })
    expect(parseDeepLink(folderDeepLink('C:\\code\\app'))).toEqual({ type: 'open-folder', path: 'C:\\code\\app' })
  })

  it('refuses relative, network, empty, repeated, and control-character folder paths', () => {
    for (const bad of [
      'houston://open',
      'houston://open?path=',
      'houston://open?path=relative/dir',
      `houston://open?path=${encodeURIComponent('\\\\evil-host\\share')}`,
      `houston://open?path=${encodeURIComponent('//evil-host/share')}`,
      `houston://open?path=${encodeURIComponent('/tmp/a\u0000b')}`,
      `houston://open?path=${encodeURIComponent('/tmp/a\nb')}`,
      'houston://open?path=/a&path=/b',
      'houston://open/extra?path=/a'
    ]) {
      expect(parseDeepLink(bad), bad).toBeNull()
    }
  })

  it('parses a chat link only for a well-formed conversation id', () => {
    expect(parseDeepLink(`houston://chat/${ID}`)).toEqual({ type: 'open-chat', conversationId: ID })
    expect(parseDeepLink(`houston://chat/${ID.toUpperCase()}`)).toEqual({ type: 'open-chat', conversationId: ID })
    expect(parseDeepLink('houston://chat/..%2F..%2Fetc%2Fpasswd')).toBeNull()
    expect(parseDeepLink('houston://chat/not-an-id')).toBeNull()
    expect(parseDeepLink(`houston://chat/${ID}/more`)).toBeNull()
    expect(parseDeepLink(`houston://chat/${ID}?prompt=rm%20-rf`)).toBeNull()
  })

  it('parses Settings links, with or without a known page', () => {
    expect(parseDeepLink('houston://settings')).toEqual({ type: 'open-settings' })
    expect(parseDeepLink('houston://settings/')).toEqual({ type: 'open-settings' })
    expect(parseDeepLink('houston://settings/Permissions')).toEqual({ type: 'open-settings', page: 'permissions' })
    expect(parseDeepLink('houston://settings/nope')).toBeNull()
    expect(parseDeepLink('houston://settings/tools?x=1')).toBeNull()
  })

  it('refuses other schemes, actions, credentials, ports, oversized and non-string input', () => {
    for (const bad of [
      'https://open?path=/tmp',
      'houston://run?prompt=hi',
      'houston://prompt/hello',
      'houston://user:pw@settings',
      'houston://settings:99',
      `houston://open?path=/${'a'.repeat(MAX_DEEP_LINK_LENGTH)}`,
      'not a url',
      '',
      42,
      null,
      undefined
    ]) {
      expect(parseDeepLink(bad), String(bad)).toBeNull()
    }
  })

  it('covers exactly the Settings pages the renderer has', () => {
    expect([...DEEP_LINK_SETTINGS_PAGES].sort()).toEqual(Object.keys(PAGE_LABELS).sort())
  })
})

describe('isAbsoluteLocalPath', () => {
  it('accepts POSIX and drive paths, refuses UNC and relative ones', () => {
    expect(isAbsoluteLocalPath('/a')).toBe(true)
    expect(isAbsoluteLocalPath('D:/a')).toBe(true)
    expect(isAbsoluteLocalPath('D:a')).toBe(false)
    expect(isAbsoluteLocalPath('\\\\host\\s')).toBe(false)
    expect(isAbsoluteLocalPath('a/b')).toBe(false)
  })

  // Windows reads `/` and `\` alike, so a path that starts with two separators in any
  // mix is a share or a device once resolved. Touching one before the confirm dialog
  // (realpath, stat) would send the user's NTLM hash to the host it names.
  const NETWORK_AND_DEVICE = [
    '\\\\host\\share',
    '//host/share',
    '/\\attacker\\share\\x',
    '\\/attacker/share',
    '/\\?\\UNC\\h\\s',
    '/\\.\\pipe\\x',
    '\\\\?\\UNC\\h\\s',
    '\\\\?\\C:\\x',
    '\\\\.\\pipe\\x',
    '//?/UNC/h/s',
    '//./pipe/x',
    '\\\\'
  ]

  it('refuses every share and device spelling, separators in any mix', () => {
    for (const p of NETWORK_AND_DEVICE) expect(isAbsoluteLocalPath(p), p).toBe(false)
  })

  it('refuses them inside a link too', () => {
    for (const p of NETWORK_AND_DEVICE) {
      expect(parseDeepLink(`houston://open?path=${encodeURIComponent(p)}`), p).toBeNull()
    }
  })

  it('accepts only paths that resolve to a local root on Windows', () => {
    const corpus = [
      ...NETWORK_AND_DEVICE,
      '/a',
      '/a\\\\b',
      '/..\\..\\\\host\\share',
      'C:\\x',
      'C:/x',
      'C:\\\\host\\share',
      'C:/\\host',
      'D:\\x\\..\\..\\\\?\\UNC\\h',
      '\\x'
    ]
    for (const p of corpus) {
      if (!isAbsoluteLocalPath(p)) continue
      // From a drive-letter current directory (the network-cwd case is refused in main).
      const root = win32.parse(win32.resolve('C:\\Users\\me', p)).root
      expect(root.startsWith('\\\\'), `${p} -> ${root}`).toBe(false)
    }
  })

  it('still accepts ordinary POSIX and drive paths', () => {
    for (const p of ['/home/dev/repo', '/', 'C:\\Users\\me\\repo', 'c:/repo']) expect(isAbsoluteLocalPath(p), p).toBe(true)
  })
})

describe('deepLinkFromArgv', () => {
  it('finds the link among launch arguments, ignoring case of the scheme', () => {
    expect(deepLinkFromArgv(['/app/Houston', '--flag', 'houston://settings'])).toBe('houston://settings')
    expect(deepLinkFromArgv(['Houston', 'HOUSTON://settings'])).toBe('HOUSTON://settings')
    expect(deepLinkFromArgv(['Houston', '--acp'])).toBeNull()
  })
})
