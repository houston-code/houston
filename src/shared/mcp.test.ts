import { describe, it, expect } from 'vitest'
import {
  mcpToolName,
  parseMcpToolName,
  isMcpToolName,
  sanitizeServerId,
  flattenMcpContent,
  parseHeaderLines
} from './mcp'

describe('mcp tool naming', () => {
  it('round-trips server id + tool name', () => {
    const full = mcpToolName('fs', 'read_file')
    expect(full).toBe('mcp__fs__read_file')
    expect(parseMcpToolName(full)).toEqual({ serverId: 'fs', toolName: 'read_file' })
  })

  it('keeps the full tool name even when it contains __', () => {
    expect(parseMcpToolName('mcp__git__do__thing')).toEqual({ serverId: 'git', toolName: 'do__thing' })
  })

  it('rejects non-mcp names', () => {
    expect(parseMcpToolName('read_file')).toBeNull()
    expect(isMcpToolName('read_file')).toBe(false)
    expect(isMcpToolName('mcp__fs__x')).toBe(true)
  })

  it('sanitizes server ids to the safe charset', () => {
    expect(sanitizeServerId('My Server!')).toBe('My-Server')
    expect(sanitizeServerId('  a.b/c  ')).toBe('a-b-c')
  })
})

describe('flattenMcpContent', () => {
  it('joins text blocks', () => {
    expect(flattenMcpContent([{ type: 'text', text: 'hello' }, { type: 'text', text: 'world' }])).toBe(
      'hello\nworld'
    )
  })

  it('notes non-text blocks by type', () => {
    expect(flattenMcpContent([{ type: 'image', data: '...' }])).toBe('[image content]')
  })

  it('handles strings and junk gracefully', () => {
    expect(flattenMcpContent('raw')).toBe('raw')
    expect(flattenMcpContent(undefined)).toBe('')
    expect(flattenMcpContent(42)).toBe('')
  })
})

describe('parseHeaderLines', () => {
  it('parses "Name: value" lines into a map', () => {
    expect(parseHeaderLines('Authorization: Bearer t\nX-Env: prod')).toEqual({
      Authorization: 'Bearer t',
      'X-Env': 'prod'
    })
  })

  it('keeps colons in the value and trims whitespace', () => {
    expect(parseHeaderLines('  X-Url :  https://a/b:8080 ')).toEqual({ 'X-Url': 'https://a/b:8080' })
  })

  it('skips blank and malformed lines', () => {
    expect(parseHeaderLines('\nnotaheader\n: noKey\nA: 1')).toEqual({ A: '1' })
  })
})
