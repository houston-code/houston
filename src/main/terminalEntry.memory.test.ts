import { describe, it, expect } from 'vitest'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// The `#` capture writes to the rules file Houston ALREADY loads on every run, so
// these check the file it produces is one the loader will read back sensibly.
describe('saveMemory (via the exported entry wiring)', () => {
  it('creates a rules file with the note when none exists', async () => {
    const ws = mkdtempSync(join(tmpdir(), 'houston-mem-'))
    const { saveMemoryTo } = await import('./memory')
    const file = await saveMemoryTo(ws, 'always run the linter')
    expect(file).toBe(join(ws, 'AGENTS.md'))
    const text = readFileSync(file, 'utf8')
    expect(text).toContain('## Notes')
    expect(text).toContain('- always run the linter')
  })

  it('appends into an existing Notes section, keeping related notes together', async () => {
    const ws = mkdtempSync(join(tmpdir(), 'houston-mem-'))
    writeFileSync(join(ws, 'AGENTS.md'), '# Rules\n\n## Notes\n\n- first note\n\n## Style\n\n- tabs\n')
    const { saveMemoryTo } = await import('./memory')
    await saveMemoryTo(ws, 'second note')
    const text = readFileSync(join(ws, 'AGENTS.md'), 'utf8')
    expect(text.indexOf('- second note')).toBeGreaterThan(text.indexOf('- first note'))
    // It must land in Notes, not after the Style section.
    expect(text.indexOf('- second note')).toBeLessThan(text.indexOf('## Style'))
    expect(text).toContain('- tabs') // the rest of the file is untouched
  })

  it('adds a Notes section to a file that has none, without eating the existing rules', async () => {
    const ws = mkdtempSync(join(tmpdir(), 'houston-mem-'))
    writeFileSync(join(ws, 'AGENTS.md'), '# Rules\n\nAlways be careful.\n')
    const { saveMemoryTo } = await import('./memory')
    await saveMemoryTo(ws, 'a note')
    const text = readFileSync(join(ws, 'AGENTS.md'), 'utf8')
    expect(text).toContain('Always be careful.')
    expect(text).toContain('## Notes')
    expect(text).toContain('- a note')
  })
})
