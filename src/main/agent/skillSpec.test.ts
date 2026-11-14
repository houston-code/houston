import { describe, expect, it } from 'vitest'
import { join } from 'node:path'
import { parseStructuredFrontmatter } from '@shared/frontmatter'
import {
  SKILL_DESCRIPTION_MAX,
  blockingRestriction,
  isSpecSkillName,
  notedSkillNames,
  parseSkillFields,
  pathGlob,
  skillMatchesPath,
  skillPathNote,
  skillRestrictionRefusal,
  toolMatchesAllowed,
  workspaceRelative
} from './skillSpec'

const fields = (fm: string): ReturnType<typeof parseStructuredFrontmatter>['fields'] =>
  parseStructuredFrontmatter(`---\n${fm}\n---\nbody`).fields

describe('isSpecSkillName', () => {
  it('accepts lowercase letters, digits and single inner hyphens up to 64', () => {
    for (const ok of ['pdf', 'pdf-processing', 'a1-b2-c3', 'x'.repeat(64)]) expect(isSpecSkillName(ok)).toBe(true)
  })

  it('refuses capitals, underscores, edge or doubled hyphens, and long names', () => {
    for (const bad of ['', 'PDF', 'pdf_tool', '-pdf', 'pdf-', 'pdf--x', 'x'.repeat(65), 'a b']) {
      expect(isSpecSkillName(bad)).toBe(false)
    }
  })
})

describe('parseSkillFields', () => {
  it('reads every format field', () => {
    const parsed = parseSkillFields(
      fields(
        [
          'name: pdf-tools',
          'description: Work with PDF files.',
          'license: Apache-2.0',
          'compatibility: Needs poppler installed',
          'metadata:',
          '  author: example-org',
          '  version: "1.0"',
          'allowed-tools: Read Bash(pdftotext:*)',
          'paths:',
          '  - "**/*.pdf"',
          '  - docs/*.md'
        ].join('\n')
      ),
      'pdf-tools',
      true
    )
    expect(parsed).toEqual({
      name: 'pdf-tools',
      description: 'Work with PDF files.',
      problems: [],
      license: 'Apache-2.0',
      compatibility: 'Needs poppler installed',
      metadata: { author: 'example-org', version: '1.0' },
      allowedTools: ['Read', 'Bash(pdftotext:*)'],
      paths: ['**/*.pdf', 'docs/*.md']
    })
  })

  it('reads paths as a comma-separated string or an inline list too', () => {
    expect(parseSkillFields(fields('description: d\npaths: src/**/*.ts, *.md'), 'x', true)?.paths).toEqual([
      'src/**/*.ts',
      '*.md'
    ])
    expect(parseSkillFields(fields('description: d\nallowed-tools: [read_file, glob]'), 'x', true)?.allowedTools).toEqual([
      'read_file',
      'glob'
    ])
  })

  it('refuses a strict skill with a bad name, a name that differs from its folder, or no description', () => {
    expect(parseSkillFields(fields('name: Bad_Name\ndescription: d'), 'Bad_Name', true)).toBeNull()
    expect(parseSkillFields(fields('name: other\ndescription: d'), 'folder', true)).toBeNull()
    expect(parseSkillFields(fields('name: folder'), 'folder', true)).toBeNull()
  })

  it('keeps loading a lenient skill and reports what breaks the format', () => {
    const parsed = parseSkillFields(fields('name: My Skill'), 'my_skill', false)
    expect(parsed?.name).toBe('My Skill')
    expect(parsed?.description).toBe('No description.')
    expect(parsed?.problems).toHaveLength(2)
    // The folder name stands in for a missing name, as before.
    expect(parseSkillFields(fields('description: d'), 'legacy', false)?.name).toBe('legacy')
  })

  it('cuts an over-long description and compatibility note without refusing the skill', () => {
    const long = 'x'.repeat(SKILL_DESCRIPTION_MAX + 10)
    const parsed = parseSkillFields(fields(`description: ${long}\ncompatibility: ${'y'.repeat(600)}`), 'x', true)
    expect(parsed?.description).toHaveLength(SKILL_DESCRIPTION_MAX)
    expect(parsed?.compatibility).toHaveLength(500)
    expect(parsed?.problems).toHaveLength(2)
  })

  it('reports a metadata value that is not a map, and drops it', () => {
    const parsed = parseSkillFields(fields('description: d\nmetadata: oops'), 'x', true)
    expect(parsed?.metadata).toBeUndefined()
    expect(parsed?.problems[0]).toMatch(/metadata/)
  })
})

describe('allowed-tools', () => {
  it('matches Houston tool names, the format examples, and wildcards', () => {
    expect(toolMatchesAllowed(['read_file'], 'read_file')).toBe(true)
    expect(toolMatchesAllowed(['Read'], 'read_file')).toBe(true)
    expect(toolMatchesAllowed(['Bash(git:*)'], 'run_shell')).toBe(true)
    expect(toolMatchesAllowed(['mcp__github__*'], 'mcp__github__get_issue')).toBe(true)
    expect(toolMatchesAllowed(['Read'], 'write_file')).toBe(false)
    expect(toolMatchesAllowed(['mcp__github__*'], 'mcp__slack__post')).toBe(false)
  })

  it('never stops the tools that only steer the turn', () => {
    for (const t of ['skill', 'ask_user', 'todo_write', 'present_plan']) expect(toolMatchesAllowed(['Read'], t)).toBe(true)
  })

  it('only narrows: with two skills active a tool must be allowed by both', () => {
    const a = { skill: 'a', allowedTools: ['read_file', 'run_shell'] }
    const b = { skill: 'b', allowedTools: ['read_file'] }
    expect(blockingRestriction([], 'write_file')).toBeNull()
    expect(blockingRestriction([a, b], 'read_file')).toBeNull()
    expect(blockingRestriction([a, b], 'run_shell')).toBe(b)
    expect(blockingRestriction([a], 'write_file')).toBe(a)
    expect(skillRestrictionRefusal(a, 'write_file')).toContain('"a" skill')
  })
})

describe('paths globs', () => {
  it('matches file names at any depth, folder globs, ** and braces', () => {
    expect(skillMatchesPath(['*.pdf'], 'docs/a/b.pdf')).toBe(true)
    expect(skillMatchesPath(['src/**/*.ts'], 'src/main/x.ts')).toBe(true)
    expect(skillMatchesPath(['src/**/*.ts'], 'src/x.ts')).toBe(true)
    expect(skillMatchesPath(['src/*.ts'], 'src/a/x.ts')).toBe(false)
    expect(skillMatchesPath(['**/*.{yml,yaml}'], '.github/workflows/ci.yaml')).toBe(true)
    expect(skillMatchesPath(['./migrations/**'], 'migrations/001.sql')).toBe(true)
    expect(skillMatchesPath(['docs/?.md'], 'docs/a.md')).toBe(true)
    expect(skillMatchesPath(['*.pdf'], 'a.pdfx')).toBe(false)
    expect(pathGlob('a.b').test('aXb')).toBe(false)
  })

  it('reads a path relative to the workspace, and nothing outside it', () => {
    const ws = join('/', 'w')
    expect(workspaceRelative(ws, join(ws, 'src', 'a.ts'))).toBe('src/a.ts')
    expect(workspaceRelative(ws, 'src/a.ts')).toBe('src/a.ts')
    expect(workspaceRelative(ws, './src/a.ts')).toBe('src/a.ts')
    expect(workspaceRelative(ws, join('/', 'etc', 'passwd'))).toBeNull()
    expect(workspaceRelative(ws, '../x')).toBeNull()
  })
})

describe('the path note', () => {
  it('names each matched skill once and can be read back', () => {
    expect(skillPathNote([])).toBeNull()
    const note = skillPathNote([{ name: 'pdf-tools', description: 'PDFs.', file: 'a.pdf' }])!
    expect(note).toContain('- pdf-tools (a.pdf): PDFs.')
    expect([...notedSkillNames([note, 'unrelated'])]).toEqual(['pdf-tools'])
  })
})
