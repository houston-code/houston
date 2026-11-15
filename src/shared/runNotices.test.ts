import { describe, expect, it } from 'vitest'
import { compactionNoticeText, modelFallbackText, retryNoticeText, verificationNoticeText } from './runNotices'
import { runtimeMissingLine, runtimeMissingText } from './runtimes'

describe('run notices', () => {
  it('words a retry, naming the attempt and the error', () => {
    expect(retryNoticeText({ attempt: 2, max: 5, message: 'socket hang up' })).toBe(
      'Connection issue, retrying (2/5): socket hang up'
    )
  })

  it('words a throttled retry by its wait instead of as a connection issue', () => {
    const text = retryNoticeText({ attempt: 1, max: 6, message: '429', throttle: { waitMs: 20_000 } })
    expect(text).not.toContain('Connection issue')
    expect(text).toContain('1/6')
  })

  it('words a fallback, a compaction and a verification', () => {
    expect(modelFallbackText({ from: 'big', to: 'small', reason: 'overloaded' })).toBe(
      'big was unavailable, so this reply came from small. overloaded'
    )
    expect(modelFallbackText({ from: 'big', to: 'small', reason: '' })).toBe('big was unavailable, so this reply came from small.')
    expect(compactionNoticeText(1)).toBe('Compacted 1 earlier message to stay within the context window.')
    expect(compactionNoticeText(4)).toBe('Compacted 4 earlier messages to stay within the context window.')
    expect(verificationNoticeText(true)).toBe('Verification passed.')
    expect(verificationNoticeText(false)).toBe('Verification failed, attempting to self-correct.')
  })

  it('words a missing runtime the same in the terminal line', () => {
    expect(runtimeMissingText('Node.js')).toBe("Node.js isn't installed, or isn't on the PATH Houston sees.")
    expect(runtimeMissingLine({ label: 'Node.js', url: 'https://nodejs.org' })).toBe(
      "! Node.js isn't installed, or isn't on the PATH Houston sees. Download it from https://nodejs.org"
    )
  })
})
