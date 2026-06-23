import { describe, it, expect } from 'vitest'
import { parseFrontmatter } from './frontmatter'

describe('parseFrontmatter', () => {
  it('parses a key/value block and body', () => {
    const { data, body } = parseFrontmatter('---\nname: Reviewer\ndescription: Reviews code\n---\nYou are a reviewer.')
    expect(data).toEqual({ name: 'Reviewer', description: 'Reviews code' })
    expect(body).toBe('You are a reviewer.')
  })

  it('strips surrounding quotes from values', () => {
    const { data } = parseFrontmatter('---\ndescription: "Finds bugs, fast"\n---\nbody')
    expect(data.description).toBe('Finds bugs, fast')
  })

  it('returns the whole text as body when there is no front-matter', () => {
    const { data, body } = parseFrontmatter('Just a prompt, no front-matter.')
    expect(data).toEqual({})
    expect(body).toBe('Just a prompt, no front-matter.')
  })

  it('handles CRLF line endings', () => {
    const { data, body } = parseFrontmatter('---\r\nname: X\r\n---\r\nhello')
    expect(data.name).toBe('X')
    expect(body).toBe('hello')
  })

  it('treats an unterminated front-matter as plain body', () => {
    const { data, body } = parseFrontmatter('---\nname: X\nno closing fence')
    expect(data).toEqual({})
    expect(body).toContain('no closing fence')
  })
})
