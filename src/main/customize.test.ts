import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  createItem,
  customizeOverview,
  deleteItem,
  listInstructionFiles,
  openInstructionFile,
  openItem,
  setItemEnabled,
  templateFor,
  withDisabledFlag,
  type CustomizeDeps
} from './customize'
import { loadCommands } from './agent/commands'
import { loadSkills } from './agent/skills'
import { loadAgents } from './agent/agents'

let home: string
let ws: string
let trash: ReturnType<typeof vi.fn<(path: string) => Promise<void>>>
let open: ReturnType<typeof vi.fn<(path: string) => Promise<string>>>
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'houston-cushome-'))
  ws = mkdtempSync(join(tmpdir(), 'houston-cusws-'))
  trash = vi.fn(async (p: string) => {
    rmSync(p, { recursive: true, force: true })
  })
  open = vi.fn(async (_p: string) => '')
})
afterEach(() => {
  rmSync(home, { recursive: true, force: true })
  rmSync(ws, { recursive: true, force: true })
})

const deps = (over: Partial<CustomizeDeps> = {}): CustomizeDeps => ({ workspace: ws, home, trash, open, ...over })

function put(root: string, rel: string, text: string): string {
  const abs = join(root, rel)
  mkdirSync(dirname(abs), { recursive: true })
  writeFileSync(abs, text)
  return abs
}

describe('customizeOverview', () => {
  it('lists both places, marks switched-off items, and flags a user item a project one hides', async () => {
    put(ws, '.houston/skills/deploy/SKILL.md', '---\nname: deploy\ndescription: Ship it\n---\nSteps')
    put(ws, '.houston/commands/review.md', '---\ndescription: Review\ndisabled: true\n---\nGo')
    put(home, '.houston/commands/review.md', 'Mine')
    put(home, '.houston/agents/explainer.md', '# Explains code\nYou explain.')
    put(home, '.houston/commands/bad name.md', 'skipped')
    const o = await customizeOverview(deps())
    expect(o.items).toEqual([
      { id: 'skill:project:deploy', kind: 'skill', scope: 'project', name: 'deploy', description: 'Ship it', file: '.houston/skills/deploy/SKILL.md', enabled: true },
      { id: 'command:project:review', kind: 'command', scope: 'project', name: 'review', description: 'Review', file: '.houston/commands/review.md', enabled: false },
      { id: 'command:user:review', kind: 'command', scope: 'user', name: 'review', description: 'Mine', file: '~/.houston/commands/review.md', enabled: true, shadowed: true },
      { id: 'agent:user:explainer', kind: 'agent', scope: 'user', name: 'explainer', description: 'Explains code', file: '~/.houston/agents/explainer.md', enabled: true }
    ])
  })

  it('lists only the user folder with no project open', async () => {
    put(home, '.houston/agents/a.md', 'A')
    const o = await customizeOverview(deps({ workspace: null }))
    expect(o.items.map((i) => i.id)).toEqual(['agent:user:a'])
  })
})

describe('withDisabledFlag', () => {
  it('adds the flag to existing front matter and removes it again', () => {
    const on = '---\ndescription: d\n---\nBody'
    const off = withDisabledFlag(on, true)
    expect(off).toBe('---\ndescription: d\ndisabled: true\n---\nBody')
    expect(withDisabledFlag(off, false)).toBe(on)
  })

  it('round-trips a file with no front matter', () => {
    const off = withDisabledFlag('Body\nmore', true)
    expect(off).toBe('---\ndisabled: true\n---\n\nBody\nmore')
    expect(withDisabledFlag(off, false)).toBe('Body\nmore')
    expect(withDisabledFlag('Body', false)).toBe('Body')
  })

  it('replaces any spelling of an existing flag', () => {
    expect(withDisabledFlag('---\nDisabled: yes\nname: x\n---\nB', true)).toBe('---\nname: x\ndisabled: true\n---\nB')
  })
})

describe('setItemEnabled', () => {
  it('switches a command off so the loader skips it, and back on', async () => {
    put(ws, '.houston/commands/review.md', 'Review it')
    expect(await setItemEnabled('command:project:review', false, deps())).toEqual({ ok: true })
    expect(await loadCommands(ws, home)).toEqual([])
    expect(await setItemEnabled('command:project:review', true, deps())).toEqual({ ok: true })
    expect((await loadCommands(ws, home)).map((c) => c.name)).toEqual(['review'])
    expect(readFileSync(join(ws, '.houston/commands/review.md'), 'utf8')).toBe('Review it')
  })

  it('switches skills and user agents off for the loaders', async () => {
    put(ws, '.houston/skills/s/SKILL.md', '---\nname: s\n---\nB')
    put(home, '.houston/agents/a.md', 'A')
    await setItemEnabled('skill:project:s', false, deps())
    await setItemEnabled('agent:user:a', false, deps())
    expect(await loadSkills(ws, home)).toEqual([])
    expect(await loadAgents(ws, home)).toEqual([])
  })

  it('refuses malformed ids, missing files and a project file that links out', async () => {
    expect((await setItemEnabled('command:project:../../etc/passwd', false, deps())).ok).toBe(false)
    expect((await setItemEnabled('nope', false, deps())).ok).toBe(false)
    expect((await setItemEnabled('command:project:missing', false, deps())).ok).toBe(false)
    expect((await setItemEnabled('command:project:x', 'yes', deps())).ok).toBe(false)
    const outside = put(home, 'elsewhere.md', 'secret')
    mkdirSync(join(ws, '.houston/commands'), { recursive: true })
    symlinkSync(outside, join(ws, '.houston/commands/link.md'))
    expect(await setItemEnabled('command:project:link', false, deps())).toEqual({
      ok: false,
      error: 'That file is missing or outside its folder.'
    })
    expect(readFileSync(outside, 'utf8')).toBe('secret')
  })
})

describe('createItem', () => {
  it('writes each template where its loader looks, then opens it', async () => {
    expect(await createItem('skill', 'project', 'deploy', deps())).toEqual({ ok: true, id: 'skill:project:deploy' })
    expect(await createItem('command', 'user', 'review', deps())).toEqual({ ok: true, id: 'command:user:review' })
    expect(await createItem('agent', 'user', 'helper', deps())).toEqual({ ok: true, id: 'agent:user:helper' })
    expect(readFileSync(join(ws, '.houston/skills/deploy/SKILL.md'), 'utf8')).toBe(templateFor('skill', 'deploy'))
    expect(open).toHaveBeenCalledWith(join(home, '.houston/commands/review.md'))
    expect((await loadSkills(ws, home)).map((s) => s.name)).toEqual(['deploy'])
    expect((await loadCommands(ws, home)).map((c) => c.name)).toEqual(['review'])
    expect((await loadAgents(ws, home)).map((a) => a.name)).toEqual(['helper'])
  })

  it('never overwrites, and refuses bad names, kinds and a missing project', async () => {
    put(ws, '.houston/commands/review.md', 'mine')
    expect(await createItem('command', 'project', 'review', deps())).toEqual({ ok: false, error: 'There is already one named review.' })
    expect(readFileSync(join(ws, '.houston/commands/review.md'), 'utf8')).toBe('mine')
    expect((await createItem('command', 'project', '../x', deps())).ok).toBe(false)
    expect((await createItem('hook', 'project', 'x', deps())).ok).toBe(false)
    expect((await createItem('command', 'project', 'x', deps({ workspace: null }))).error).toBe('Open a project first.')
  })

  it('refuses to create inside a project .houston that links out of the project', async () => {
    const elsewhere = mkdtempSync(join(tmpdir(), 'houston-cusout-'))
    try {
      symlinkSync(elsewhere, join(ws, '.houston'))
      const res = await createItem('command', 'project', 'x', deps())
      expect(res.ok).toBe(false)
      expect(existsSync(join(elsewhere, 'commands', 'x.md'))).toBe(false)
    } finally {
      rmSync(elsewhere, { recursive: true, force: true })
    }
  })
})

describe('openItem and deleteItem', () => {
  it('opens the file and trashes a skill as a whole folder', async () => {
    put(ws, '.houston/skills/s/SKILL.md', 'B')
    put(ws, '.houston/skills/s/ref.md', 'R')
    expect(await openItem('skill:project:s', deps())).toEqual({ ok: true })
    expect(open).toHaveBeenCalledWith(join(ws, '.houston/skills/s/SKILL.md'))
    expect(await deleteItem('skill:project:s', deps())).toEqual({ ok: true })
    expect(trash).toHaveBeenCalledWith(join(ws, '.houston/skills/s'))
    expect(existsSync(join(ws, '.houston/skills/s'))).toBe(false)
  })

  it('reports an open failure and a missing item', async () => {
    put(home, '.houston/agents/a.md', 'A')
    open.mockResolvedValueOnce('No app')
    expect(await openItem('agent:user:a', deps())).toEqual({ ok: false, error: 'No app' })
    expect(await deleteItem('agent:user:gone', deps())).toEqual({ ok: false, error: 'That item no longer exists.' })
    expect(trash).not.toHaveBeenCalled()
  })

  it('refuses to delete inside a project folder that links out', async () => {
    const elsewhere = mkdtempSync(join(tmpdir(), 'houston-cusout-'))
    try {
      put(elsewhere, 'commands/x.md', 'keep')
      symlinkSync(elsewhere, join(ws, '.houston'))
      expect((await deleteItem('command:project:x', deps())).ok).toBe(false)
      expect(trash).not.toHaveBeenCalled()
    } finally {
      rmSync(elsewhere, { recursive: true, force: true })
    }
  })
})

describe('instruction files', () => {
  it('lists the global, root and nested files the loader takes in, and opens only those', async () => {
    put(home, '.houston/AGENTS.md', 'Global')
    put(ws, 'AGENTS.md', 'Root')
    put(ws, 'pkg/AGENTS.md', 'Nested')
    const files = await listInstructionFiles(ws, home)
    expect(files).toEqual([
      { label: '~/.houston/AGENTS.md (global)', scope: 'global' },
      { label: 'AGENTS.md', scope: 'project' },
      { label: join('pkg', 'AGENTS.md'), scope: 'nested' }
    ])
    expect(await openInstructionFile(join('pkg', 'AGENTS.md'), deps())).toEqual({ ok: true })
    expect(open).toHaveBeenCalledWith(join(ws, 'pkg', 'AGENTS.md'))
    expect(await openInstructionFile('~/.houston/AGENTS.md (global)', deps())).toEqual({ ok: true })
    expect(open).toHaveBeenLastCalledWith(join(home, '.houston', 'AGENTS.md'))
    expect((await openInstructionFile('/etc/passwd', deps())).ok).toBe(false)
  })

  it('lists only the global file with no project open', async () => {
    expect(await listInstructionFiles(null, home)).toEqual([])
    put(home, '.houston/AGENTS.md', 'Global')
    expect(await listInstructionFiles(null, home)).toEqual([{ label: '~/.houston/AGENTS.md (global)', scope: 'global' }])
  })
})
