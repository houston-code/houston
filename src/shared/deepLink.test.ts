import { describe, expect, it } from 'vitest'
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
})

describe('deepLinkFromArgv', () => {
  it('finds the link among launch arguments, ignoring case of the scheme', () => {
    expect(deepLinkFromArgv(['/app/Houston', '--flag', 'houston://settings'])).toBe('houston://settings')
    expect(deepLinkFromArgv(['Houston', 'HOUSTON://settings'])).toBe('HOUSTON://settings')
    expect(deepLinkFromArgv(['Houston', '--acp'])).toBeNull()
  })
})
