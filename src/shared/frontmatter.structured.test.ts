import { describe, expect, it } from 'vitest'
import { parseStructuredFrontmatter } from './frontmatter'

describe('parseStructuredFrontmatter', () => {
  it('reads scalars, lists, maps and block scalars', () => {
    const text = [
      '---',
      'name: pdf',
      'Description: "Quoted, with a comma"',
      '# a comment',
      'tags: [a, "b c"]',
      'paths:',
      '  - "*.pdf"',
      '  - docs/**',
      'metadata:',
      '  author: me',
      '  version: "2"',
      'folded: >',
      '  one',
      '  two',
      'literal: |',
      '  line1',
      '  line2',
      'empty:',
      '---',
      'Body here.'
    ].join('\n')
    const { fields, body } = parseStructuredFrontmatter(text)
    expect(fields).toEqual({
      name: 'pdf',
      description: 'Quoted, with a comma',
      tags: ['a', 'b c'],
      paths: ['*.pdf', 'docs/**'],
      metadata: { author: 'me', version: '2' },
      folded: 'one two',
      literal: 'line1\nline2',
      empty: ''
    })
    expect(body).toBe('Body here.')
  })

  it('reads a list written without indentation', () => {
    expect(parseStructuredFrontmatter('---\npaths:\n- a.md\n- b.md\n---\n').fields).toEqual({ paths: ['a.md', 'b.md'] })
  })

  it('returns the text as the body when there is no block', () => {
    expect(parseStructuredFrontmatter('plain')).toEqual({ fields: {}, body: 'plain' })
    expect(parseStructuredFrontmatter('---\nname: x\nno close')).toEqual({ fields: {}, body: '---\nname: x\nno close' })
  })
})
