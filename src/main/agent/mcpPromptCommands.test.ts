import { describe, expect, it, vi } from 'vitest'
import { MCP_PROMPT_COMMAND_GROUP, commandGroup, commandHasRunOptions, groupCommands, mergeCommands, type Command } from '@shared/commands'
import {
  isMcpPromptLine,
  mcpPromptCommandName,
  mcpPromptCommands,
  mcpPromptUsage,
  parseMcpPromptArgs,
  prepareMcpPromptRun
} from './mcpPromptCommands'

const docs = mcpPromptCommands([
  {
    server: 'docs',
    prompts: [
      {
        name: 'summarize',
        description: 'Summarize a topic',
        arguments: [
          { name: 'topic', required: true },
          { name: 'tone', description: 'how it reads' }
        ]
      },
      { name: 'release notes!', description: 'Draft\u001b[31m notes' },
      { name: 'none' }
    ]
  }
])

describe('mcpPromptCommandName', () => {
  it('spells a prompt like a tool, cleaning what the server wrote', () => {
    expect(mcpPromptCommandName('docs', 'summarize')).toBe('mcp__docs__summarize')
    expect(mcpPromptCommandName('proj-db', 'run query.sql')).toBe('mcp__proj-db__run_query_sql')
    expect(mcpPromptCommandName('a', '__x__')).toBe('mcp__a__x')
    expect(mcpPromptCommandName('a', '???')).toBeNull()
    // A server id that could blur the `__` boundary is refused outright.
    expect(mcpPromptCommandName('a__b', 'x')).toBeNull()
    expect(mcpPromptCommandName('a b', 'x')).toBeNull()
  })
})

describe('mcpPromptCommands', () => {
  it('builds one command per prompt, with an argument hint and the server ref', () => {
    expect(docs.map((c) => c.name)).toEqual(['mcp__docs__summarize', 'mcp__docs__release_notes', 'mcp__docs__none'])
    expect(docs[0]).toMatchObject({
      description: 'Summarize a topic',
      args: '<topic> [tone]',
      mcpPrompt: { server: 'docs', prompt: 'summarize', arguments: [{ name: 'topic', required: true }, { name: 'tone', description: 'how it reads' }] }
    })
    // The server's own name goes back on prompts/get, not the cleaned one.
    expect(docs[1].mcpPrompt?.prompt).toBe('release notes!')
    // Control characters a server put in a description never reach a menu.
    expect(docs[1].description).toBe('Draft [31m notes')
    expect(docs[2]).toMatchObject({ description: 'none prompt from docs' })
    expect(docs[2].args).toBeUndefined()
  })

  it('keeps the first of two prompts that clean to one name, and drops odd argument names', () => {
    const cmds = mcpPromptCommands([
      { server: 's', prompts: [{ name: 'a b' }, { name: 'a_b' }, { name: 'c', arguments: [{ name: 'ok' }, { name: 'bad name' }, { name: 'ok' }] }] }
    ])
    expect(cmds.map((c) => c.mcpPrompt?.prompt)).toEqual(['a b', 'c'])
    expect(cmds[1].mcpPrompt?.arguments.map((a) => a.name)).toEqual(['ok'])
  })

  it('lists under MCP prompts, after the built-ins, custom commands and skills, which win a clash', () => {
    expect(commandGroup(docs[0])).toBe(MCP_PROMPT_COMMAND_GROUP)
    const custom: Command = { name: 'mine', description: 'x', template: 'y', source: 'project' }
    const skill: Command = { name: 'sk', description: 'x', template: 'y', skill: true }
    expect(groupCommands([docs[0], skill, custom]).map((c) => c.name)).toEqual(['mine', 'sk', 'mcp__docs__summarize'])
    const shadow: Command = { name: 'mcp__docs__summarize', description: 'mine', template: 't', source: 'user' }
    expect(mergeCommands([shadow], docs).filter((c) => c.name === 'mcp__docs__summarize')).toEqual([shadow])
    expect(commandHasRunOptions(docs[0])).toBe(true)
  })
})

describe('parseMcpPromptArgs', () => {
  const spec = docs[0].mcpPrompt!.arguments
  const usage = mcpPromptUsage(docs[0])

  it('fills arguments in order, the last taking the rest', () => {
    expect(parseMcpPromptArgs('release', spec, usage)).toEqual({ ok: true, values: { topic: 'release' } })
    expect(parseMcpPromptArgs('release formal and short', spec, usage)).toEqual({
      ok: true,
      values: { topic: 'release', tone: 'formal and short' }
    })
  })

  it('takes name=value, quoted values, and positionals around them', () => {
    expect(parseMcpPromptArgs('tone="very formal" the release', spec, usage)).toEqual({
      ok: true,
      values: { tone: 'very formal', topic: 'the release' }
    })
    expect(parseMcpPromptArgs("'two words' tone=dry", spec, usage)).toEqual({ ok: true, values: { topic: 'two words', tone: 'dry' } })
    // An undeclared name is just a word.
    expect(parseMcpPromptArgs('x=1', spec, usage)).toEqual({ ok: true, values: { topic: 'x=1' } })
  })

  it('says what is missing, or that a prompt takes nothing', () => {
    expect(parseMcpPromptArgs('', spec, usage)).toEqual({ ok: false, error: 'Missing topic. Usage: /mcp__docs__summarize <topic> [tone]' })
    expect(parseMcpPromptArgs('tone=dry', spec, usage)).toMatchObject({ ok: false })
    expect(parseMcpPromptArgs('', [], '/mcp__docs__none')).toEqual({ ok: true, values: {} })
    expect(parseMcpPromptArgs('stray', [], '/mcp__docs__none')).toEqual({ ok: false, error: '/mcp__docs__none takes no arguments.' })
    expect(parseMcpPromptArgs('topic=a tone=b extra', spec, usage)).toMatchObject({ ok: false })
  })
})

describe('isMcpPromptLine', () => {
  it('matches only a full /mcp__server__prompt command', () => {
    expect(isMcpPromptLine('/mcp__docs__summarize x')).toBe(true)
    expect(isMcpPromptLine('/mcp list')).toBe(false)
    expect(isMcpPromptLine('/mcp__docs__')).toBe(false)
    expect(isMcpPromptLine('hi /mcp__docs__x')).toBe(false)
  })
})

describe('prepareMcpPromptRun', () => {
  it('fetches the prompt with the parsed arguments and labels the turn', async () => {
    const fetch = vi.fn(async () => '  user: Summarize the release.  ')
    const r = await prepareMcpPromptRun(docs[0], 'release', '/mcp__docs__summarize release', fetch)
    expect(fetch).toHaveBeenCalledWith('docs', 'summarize', { topic: 'release' })
    expect(r).toEqual({
      ok: true,
      taintSource: 'mcp__docs__summarize',
      turn: {
        text: 'user: Summarize the release.',
        invokedAs: {
          kind: 'command',
          label: '/mcp__docs__summarize',
          detail: 'MCP prompt from docs: Summarize a topic',
          typed: '/mcp__docs__summarize release'
        }
      }
    })
  })

  it('never fetches when the arguments are wrong, and reports a failed or empty fetch', async () => {
    const fetch = vi.fn(async () => 'x')
    expect(await prepareMcpPromptRun(docs[0], '', '/mcp__docs__summarize', fetch)).toMatchObject({ ok: false })
    expect(fetch).not.toHaveBeenCalled()
    expect(
      await prepareMcpPromptRun(docs[2], '', '/mcp__docs__none', async () => {
        throw new Error('MCP server "docs" is not connected.\u001b]0;x\u0007')
      })
    ).toEqual({ ok: false, error: '/mcp__docs__none failed: MCP server "docs" is not connected. ]0;x' })
    expect(await prepareMcpPromptRun(docs[2], '', '/mcp__docs__none', async () => '  ')).toEqual({
      ok: false,
      error: '/mcp__docs__none: the server returned an empty prompt.'
    })
  })
})
