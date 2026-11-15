import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expandMessageMentions, findMessageMentions, type MessageMentionOptions } from './messageMentions'

let ws: string
let outside: string
beforeEach(() => {
  ws = realpathSync(mkdtempSync(join(tmpdir(), 'houston-mention-')))
  outside = realpathSync(mkdtempSync(join(tmpdir(), 'houston-mention-out-')))
  mkdirSync(join(ws, 'src'))
  writeFileSync(join(ws, 'src/a.ts'), 'one\ntwo\nthree\nfour\n')
  writeFileSync(join(ws, '.env'), 'TOKEN=hunter2\nOTHER=x\n')
  writeFileSync(join(outside, 'secret.txt'), 'outside\n')
})
afterEach(() => {
  rmSync(ws, { recursive: true, force: true })
  rmSync(outside, { recursive: true, force: true })
})

const opts = (over: Partial<MessageMentionOptions> = {}): MessageMentionOptions => ({
  workspace: ws,
  roots: [ws],
  agents: ['reviewer'],
  mcpServers: ['github'],
  ...over
})

describe('findMessageMentions', () => {
  it('finds agents, line ranges and resources that name something real, and nothing else', () => {
    const found = findMessageMentions(
      'Ask @agent-reviewer about @src/a.ts#2-3, @github:repo://o/r/issues/1 and @plain.ts, mail me@host:1, @agent-nobody, @other:x',
      { agents: ['reviewer'], mcpServers: ['github'] }
    )
    expect(found).toEqual([
      { kind: 'agent', name: 'reviewer', token: '@agent-reviewer' },
      { kind: 'range', path: 'src/a.ts', lines: { start: 2, end: 3 }, token: '@src/a.ts#2-3' },
      { kind: 'resource', server: 'github', uri: 'repo://o/r/issues/1', token: '@github:repo://o/r/issues/1' }
    ])
  })
})

describe('expandMessageMentions', () => {
  it('leaves a message with none of the richer mentions alone', async () => {
    expect(await expandMessageMentions('fix @src/a.ts please', opts())).toEqual({ ok: true, turn: null })
    // A range on a path that names no file stays text too.
    expect(await expandMessageMentions('see @src/missing.ts#3', opts())).toEqual({ ok: true, turn: null })
  })

  it('includes only the lines named, under a header naming the range', async () => {
    const r = await expandMessageMentions('why is @src/a.ts#2-3 slow?', opts())
    expect(r.ok && r.turn).toBeTruthy()
    if (!r.ok || !r.turn) return
    expect(r.turn.text).toBe('why is @src/a.ts#2-3 slow?\n\nLines 2-3 of `src/a.ts`:\n```\ntwo\nthree\n```')
    expect(r.turn.invokedAs).toEqual({
      kind: 'command',
      label: 'why is @src/a.ts#2-3 slow?',
      detail: 'src/a.ts lines 2-3',
      typed: 'why is @src/a.ts#2-3 slow?'
    })
    expect(r.notes).toEqual(['adds src/a.ts lines 2-3'])
  })

  it('takes one line, clamps a range past the end, and refuses one that starts past it', async () => {
    const one = await expandMessageMentions('@src/a.ts#4', opts())
    expect(one.ok && one.turn?.text).toContain('Line 4 of `src/a.ts`:\n```\nfour\n```')
    const past = await expandMessageMentions('@src/a.ts#3-99', opts())
    expect(past.ok && past.turn?.text).toContain('Lines 3-4 of `src/a.ts` (the file ends at line 4):\n```\nthree\nfour\n```')
    expect(await expandMessageMentions('@src/a.ts#9-12', opts())).toEqual({
      ok: false,
      error: '@src/a.ts#9-12: src/a.ts has only 4 lines'
    })
    expect(await expandMessageMentions('@src/a.ts#3-2', opts())).toEqual({
      ok: false,
      error: '@src/a.ts#3-2: the range ends before it starts'
    })
  })

  it('refuses a range outside the workspace, directly or through a symlink', async () => {
    expect(await expandMessageMentions(`@${join(outside, 'secret.txt')}#1`, opts())).toEqual({
      ok: false,
      error: `@${join(outside, 'secret.txt')}#1 is outside this project`
    })
    symlinkSync(join(outside, 'secret.txt'), join(ws, 'link.txt'))
    const r = await expandMessageMentions('@link.txt#1', opts())
    expect(r.ok).toBe(false)
  })

  it('asks before a credential file, and refuses with no one to ask or on a no', async () => {
    expect(await expandMessageMentions('@.env#1', opts())).toEqual({
      ok: false,
      error: 'it reads a credential file, and there is no one here to approve that'
    })
    const asked: string[][] = []
    const no = await expandMessageMentions('@.env#1', opts({ confirm: async (c) => (asked.push(c.sensitiveFiles), false) }))
    expect(no.ok).toBe(false)
    expect(asked).toEqual([['.env']])
    const yes = await expandMessageMentions('@.env#2', opts({ confirm: async () => true }))
    expect(yes.ok && yes.turn?.text).toContain('Line 2 of `.env`:\n```\nOTHER=x\n```')
  })

  it('refuses a binary file', async () => {
    writeFileSync(join(ws, 'bin.dat'), Buffer.from([1, 0, 2, 10, 3]))
    const r = await expandMessageMentions('@bin.dat#1', opts())
    expect(r).toEqual({ ok: false, error: '@bin.dat#1: bin.dat is not a text file' })
  })

  it('names MCP resources for the agent to read through mcp_read_resource', async () => {
    const r = await expandMessageMentions('summarize @github:repo://o/r/issues/1 and @github:repo://o/r/issues/1', opts())
    if (!r.ok || !r.turn) throw new Error('expected a turn')
    expect(r.turn.text).toBe(
      'summarize @github:repo://o/r/issues/1 and @github:repo://o/r/issues/1\n\nThe message mentions an MCP resource. Read it with mcp_read_resource before answering:\n- server "github", uri "repo://o/r/issues/1"'
    )
    expect(r.notes).toEqual(['asks the agent to read the MCP resources it names (approval rules apply)'])
  })

  it('hands the message to a named agent with the /agent dispatch, the mention left out of the task', async () => {
    const r = await expandMessageMentions('@agent-reviewer check @src/a.ts#1 for bugs', opts())
    if (!r.ok || !r.turn) throw new Error('expected a turn')
    expect(r.turn.text).toBe(
      'Use the `reviewer` subagent for this task. Dispatch it with everything it needs to work on its own, then report what it found.\n\ncheck @src/a.ts#1 for bugs\n\nLine 1 of `src/a.ts`:\n```\none\n```'
    )
    expect(r.turn.invokedAs).toMatchObject({ kind: 'command', label: '@agent-reviewer', typed: '@agent-reviewer check @src/a.ts#1 for bugs' })
    expect(r.notes[0]).toBe('hands this message to the reviewer subagent')
  })

  it('refuses two different agents in one message', async () => {
    const r = await expandMessageMentions('@agent-reviewer and @agent-writer', opts({ agents: ['reviewer', 'writer'] }))
    expect(r).toEqual({ ok: false, error: 'the message names 2 agents (@agent-reviewer, @agent-writer); hand it to one' })
  })
})
