import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
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
  // Real paths: opens go to a file's real path, and macOS's tmpdir is behind /var -> /private/var.
  home = realpathSync(mkdtempSync(join(tmpdir(), 'houston-cushome-')))
  ws = realpathSync(mkdtempSync(join(tmpdir(), 'houston-cusws-')))
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
    put(ws, '.houston/commands/lint.md', '---\ndescription: Lint\ndisabled: true\n---\nGo')
    put(ws, '.houston/commands/review.md', '---\ndescription: Review\n---\nGo')
    put(home, '.houston/commands/review.md', 'Mine')
    put(home, '.houston/agents/explainer.md', '# Explains code\nYou explain.')
    put(home, '.houston/commands/bad name.md', 'skipped')
    const o = await customizeOverview(deps())
    expect(o.items).toEqual([
      { id: 'skill:project:deploy', kind: 'skill', scope: 'project', name: 'deploy', description: 'Ship it', file: '.houston/skills/deploy/SKILL.md', enabled: true },
      { id: 'command:project:lint', kind: 'command', scope: 'project', name: 'lint', description: 'Lint', file: '.houston/commands/lint.md', enabled: false },
      { id: 'command:project:review', kind: 'command', scope: 'project', name: 'review', description: 'Review', file: '.houston/commands/review.md', enabled: true },
      { id: 'command:user:review', kind: 'command', scope: 'user', name: 'review', description: 'Mine', file: '~/.houston/commands/review.md', enabled: true, shadowed: true },
      { id: 'agent:user:explainer', kind: 'agent', scope: 'user', name: 'explainer', description: 'Explains code', file: '~/.houston/agents/explainer.md', enabled: true }
    ])
  })

  it("doesn't flag an item hidden only by one the loader skips: switched off, or an .agents skill that breaks the format", async () => {
    put(ws, '.houston/commands/review.md', '---\ndescription: Review\ndisabled: true\n---\nGo')
    put(home, '.houston/commands/review.md', 'Mine')
    put(ws, '.houston/agents/explainer.md', '---\ndisabled: true\n---\nOurs.')
    put(home, '.houston/agents/explainer.md', 'Mine.')
    put(ws, '.houston/skills/deploy/SKILL.md', '---\nname: deploy\ndescription: Ship it\ndisabled: true\n---\nSteps')
    put(home, '.houston/skills/deploy/SKILL.md', '---\nname: deploy\ndescription: Mine\n---\nSteps')
    // No description: .agents/skills holds it to the format, so it never loads.
    put(ws, '.agents/skills/pdf/SKILL.md', '---\nname: pdf\n---\nSteps')
    put(home, '.agents/skills/pdf/SKILL.md', '---\nname: pdf\ndescription: Mine\n---\nSteps')
    const o = await customizeOverview(deps())
    const byId = Object.fromEntries(o.items.map((i) => [i.id, i]))
    for (const id of ['command:user:review', 'agent:user:explainer', 'skill:user:deploy', 'skill-agents:user:pdf']) {
      expect(byId[id], id).toBeDefined()
      expect(byId[id].shadowed, id).toBeUndefined()
    }
    // What the loaders really offer: the user's own, every one.
    expect((await loadCommands(ws, home)).find((c) => c.name === 'review')?.source).toBe('user')
    expect((await loadAgents(ws, home)).find((a) => a.name === 'explainer')?.systemPrompt).toBe('Mine.')
    const skills = await loadSkills(ws, home)
    expect(skills.find((s) => s.name === 'deploy')?.description).toBe('Mine')
    expect(skills.find((s) => s.name === 'pdf')?.description).toBe('Mine')
  })

  it('lists only the user folder with no project open', async () => {
    put(home, '.houston/agents/a.md', 'A')
    const o = await customizeOverview(deps({ workspace: null }))
    expect(o.items.map((i) => i.id)).toEqual(['agent:user:a'])
  })

  it('lists .agents/skills too, with format details, problems, and which one wins a clash', async () => {
    put(ws, '.houston/skills/deploy/SKILL.md', '---\nname: deploy\ndescription: Ship it\n---\nSteps')
    put(ws, '.agents/skills/deploy/SKILL.md', '---\nname: deploy\ndescription: Other\n---\nSteps')
    put(
      ws,
      '.agents/skills/pdf/SKILL.md',
      '---\nname: pdf\ndescription: PDFs\nlicense: MIT\nallowed-tools: Read Grep\npaths: "*.pdf"\n---\nSteps'
    )
    put(ws, '.agents/skills/Bad/SKILL.md', '---\nname: Bad\n---\nSteps')
    put(home, '.agents/skills/pdf/SKILL.md', '---\nname: pdf\ndescription: Mine\n---\nSteps')
    const o = await customizeOverview(deps())
    const byId = Object.fromEntries(o.items.map((i) => [i.id, i]))
    expect(byId['skill:project:deploy'].shadowed).toBeUndefined()
    expect(byId['skill-agents:project:deploy']).toMatchObject({ source: 'agents', shadowed: true, file: '.agents/skills/deploy/SKILL.md' })
    expect(byId['skill-agents:project:pdf']).toMatchObject({
      kind: 'skill',
      details: ['Tools: Read Grep', 'Paths: *.pdf', 'License: MIT']
    })
    expect(byId['skill-agents:project:pdf'].problems).toBeUndefined()
    expect(byId['skill-agents:project:Bad'].problems?.length).toBe(2)
    expect(byId['skill-agents:user:pdf']).toMatchObject({ shadowed: true, file: '~/.agents/skills/pdf/SKILL.md' })
  })

  it('switches off, opens and trashes an .agents skill by its id', async () => {
    const file = put(ws, '.agents/skills/pdf/SKILL.md', '---\nname: pdf\ndescription: PDFs\n---\nSteps')
    expect(await setItemEnabled('skill-agents:project:pdf', false, deps())).toEqual({ ok: true })
    expect(readFileSync(file, 'utf8')).toContain('disabled: true')
    expect((await loadSkills(ws, home)).map((s) => s.name)).toEqual([])
    expect(await openItem('skill-agents:project:pdf', deps())).toEqual({ ok: true })
    expect(open).toHaveBeenCalledWith(file)
    expect(await deleteItem('skill-agents:project:pdf', deps())).toEqual({ ok: true })
    expect(existsSync(dirname(file))).toBe(false)
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

  it('keeps CRLF endings, nested disabled keys and blank lines', () => {
    const on = '---\r\nname: s\r\ndescription: |\r\n  one\r\n\r\n  two\r\nmetadata:\r\n  disabled: false\r\n---\r\nBody\r\n'
    const off = withDisabledFlag(on, true)
    expect(off).toBe('---\r\nname: s\r\ndescription: |\r\n  one\r\n\r\n  two\r\nmetadata:\r\n  disabled: false\r\ndisabled: true\r\n---\r\nBody\r\n')
    expect(withDisabledFlag(off, false)).toBe(on)
    expect(withDisabledFlag(on, false)).toBe(on)
    expect(withDisabledFlag('Body\r\nmore', true)).toBe('---\r\ndisabled: true\r\n---\r\n\r\nBody\r\nmore')
    expect(withDisabledFlag(withDisabledFlag('Body\r\nmore', true), false)).toBe('Body\r\nmore')
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

  it('round-trips a CRLF file byte for byte', async () => {
    const text = '---\r\nname: s\r\ndescription: d\r\n---\r\nSteps\r\n'
    const file = put(ws, '.houston/skills/s/SKILL.md', text)
    await setItemEnabled('skill:project:s', false, deps())
    expect(await loadSkills(ws, home)).toEqual([])
    await setItemEnabled('skill:project:s', true, deps())
    expect(readFileSync(file, 'utf8')).toBe(text)
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

  it('lists, switches off and trashes a namespaced command, and never one behind a linked folder', async () => {
    put(ws, '.houston/commands/git/commit.md', '---\ndescription: Commit\n---\nCommit it')
    const outsideDir = join(home, 'outside')
    put(home, 'outside/leak.md', 'secret')
    symlinkSync(outsideDir, join(ws, '.houston/commands/linked'), 'dir')
    const items = (await customizeOverview(deps())).items.filter((i) => i.kind === 'command' && i.scope === 'project')
    expect(items.map((i) => [i.id, i.file])).toEqual([['command:project:git:commit', '.houston/commands/git/commit.md']])
    expect(await setItemEnabled('command:project:git:commit', false, deps())).toEqual({ ok: true })
    expect(await loadCommands(ws, home)).toEqual([])
    // A namespace part that isn't a plain word, or a link out of the project, is refused.
    expect((await setItemEnabled('command:project:git:../x', false, deps())).ok).toBe(false)
    expect((await setItemEnabled('command:project:linked:leak', false, deps())).ok).toBe(false)
    expect(readFileSync(join(outsideDir, 'leak.md'), 'utf8')).toBe('secret')
    expect(await deleteItem('command:project:git:commit', deps())).toEqual({ ok: true })
    expect(existsSync(join(ws, '.houston/commands/git/commit.md'))).toBe(false)
  })
})

describe('createItem', () => {
  it('writes each template where its loader looks, then opens it', async () => {
    expect(await createItem('skill', 'project', 'deploy', deps())).toEqual({ ok: true, id: 'skill:project:deploy' })
    expect(await createItem('command', 'user', 'triage', deps())).toEqual({ ok: true, id: 'command:user:triage' })
    expect(await createItem('agent', 'user', 'helper', deps())).toEqual({ ok: true, id: 'agent:user:helper' })
    expect(readFileSync(join(ws, '.houston/skills/deploy/SKILL.md'), 'utf8')).toBe(templateFor('skill', 'deploy'))
    expect(open).toHaveBeenCalledWith(join(home, '.houston/commands/triage.md'))
    expect((await loadSkills(ws, home)).map((s) => s.name)).toEqual(['deploy'])
    expect((await loadCommands(ws, home)).map((c) => c.name)).toEqual(['triage'])
    expect((await loadAgents(ws, home)).map((a) => a.name)).toEqual(['helper'])
  })

  it('never overwrites, and refuses bad names, kinds and a missing project', async () => {
    put(ws, '.houston/commands/triage.md', 'mine')
    expect(await createItem('command', 'project', 'triage', deps())).toEqual({ ok: false, error: 'There is already one named triage.' })
    expect(readFileSync(join(ws, '.houston/commands/triage.md'), 'utf8')).toBe('mine')
    expect((await createItem('command', 'project', '../x', deps())).ok).toBe(false)
    expect((await createItem('hook', 'project', 'x', deps())).ok).toBe(false)
    expect((await createItem('command', 'project', 'x', deps({ workspace: null }))).error).toBe('Open a project first.')
  })

  it('refuses a name a built-in command or skill holds, writing nothing', async () => {
    for (const n of ['review', 'model', 'q', 'Help']) {
      const res = await createItem('command', 'user', n, deps())
      expect(res).toEqual({ ok: false, error: expect.stringContaining('is a built-in command') })
    }
    expect(existsSync(join(home, '.houston/commands/review.md'))).toBe(false)
    expect(await createItem('skill', 'project', 'houston-guide', deps())).toEqual({
      ok: false,
      error: expect.stringContaining('is a built-in skill')
    })
    expect(existsSync(join(ws, '.houston/skills/houston-guide'))).toBe(false)
    // A name a custom command may take over is still fine.
    expect((await createItem('command', 'user', 'commit', deps())).ok).toBe(true)
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

/**
 * macOS picks the app for a symlink by its target's type, so a committed Markdown name
 * that links to a `.command` script would launch Terminal and run it on Open. Every
 * Customize open must refuse it without ever calling the opener.
 */
describe('opening a link to a launchable file', () => {
  const posixOnly = process.platform === 'win32' ? it.skip : it

  posixOnly('refuses a skill, command or agent file that links to a .command', async () => {
    put(ws, 'run.command', '#!/bin/sh\necho pwned\n')
    mkdirSync(join(ws, '.houston/skills/x'), { recursive: true })
    mkdirSync(join(ws, '.houston/commands'), { recursive: true })
    mkdirSync(join(ws, '.houston/agents'), { recursive: true })
    symlinkSync(join(ws, 'run.command'), join(ws, '.houston/skills/x/SKILL.md'))
    symlinkSync(join(ws, 'run.command'), join(ws, '.houston/commands/x.md'))
    symlinkSync(join(ws, 'run.command'), join(ws, '.houston/agents/x.md'))
    for (const id of ['skill:project:x', 'command:project:x', 'agent:project:x']) {
      expect(await openItem(id, deps())).toEqual({ ok: false, error: expect.stringMatching(/different kind/) })
    }
    expect(open).not.toHaveBeenCalled()
  })

  posixOnly('refuses the same link in the user folder', async () => {
    put(home, 'run.command', '#!/bin/sh\n')
    mkdirSync(join(home, '.houston/commands'), { recursive: true })
    symlinkSync(join(home, 'run.command'), join(home, '.houston/commands/x.md'))
    expect((await openItem('command:user:x', deps())).ok).toBe(false)
    expect(open).not.toHaveBeenCalled()
  })

  posixOnly('opens a same-type link by its real path', async () => {
    const real = put(ws, 'docs/deploy.md', 'Steps')
    mkdirSync(join(ws, '.houston/commands'), { recursive: true })
    symlinkSync(real, join(ws, '.houston/commands/deploy.md'))
    expect(await openItem('command:project:deploy', deps())).toEqual({ ok: true })
    expect(open).toHaveBeenCalledWith(real)
  })

  posixOnly('refuses an instruction file that links to a .command, or one marked executable', async () => {
    put(ws, 'run.command', '#!/bin/sh\n')
    symlinkSync(join(ws, 'run.command'), join(ws, 'AGENTS.md'))
    put(ws, 'pkg/AGENTS.md', 'Nested')
    chmodSync(join(ws, 'pkg/AGENTS.md'), 0o755)
    expect(await openInstructionFile('AGENTS.md', deps())).toEqual({ ok: false, error: expect.stringMatching(/different kind/) })
    expect(await openInstructionFile(join('pkg', 'AGENTS.md'), deps())).toEqual({ ok: false, error: expect.stringMatching(/program/) })
    expect(open).not.toHaveBeenCalled()
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
