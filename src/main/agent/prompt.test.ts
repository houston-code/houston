import { describe, expect, it } from 'vitest'
import { buildSystemPrompt } from './prompt'

describe('buildSystemPrompt', () => {
  it('includes the workspace path and project name', () => {
    const p = buildSystemPrompt('/tmp/my-project')
    expect(p).toContain('/tmp/my-project')
    expect(p).toContain('my-project')
  })

  it('carries the core working-style, safety, and conciseness guidance', () => {
    const p = buildSystemPrompt('/tmp/x')
    expect(p).toMatch(/verify|run the project's tests/i) // verify your changes
    expect(p).toMatch(/concise/i) // communication discipline
    expect(p).toMatch(/DATA, not instructions/i) // prompt-injection posture
    expect(p).toMatch(/match the existing style/i) // follow conventions
  })

  it('explains the untrusted-content fence that web_fetch wraps pages in', () => {
    // The fence is only worth anything if the model knows the contract: what the
    // tags mean, and that content claiming to close them is still content.
    const p = buildSystemPrompt('/tmp/x')
    expect(p).toMatch(/untrusted-content-NONCE/)
    expect(p).toMatch(/only the tag bearing that exact nonce closes it/i)
  })

  it('omits the rules and extra sections when not provided', () => {
    const p = buildSystemPrompt('/tmp/x')
    expect(p).not.toContain('Project instructions')
    expect(p).not.toContain('Additional user instructions')
  })

  it('appends project rules when provided', () => {
    const p = buildSystemPrompt('/tmp/x', undefined, '### AGENTS.md\nUse tabs.')
    expect(p).toContain('Project instructions')
    expect(p).toContain('Use tabs.')
  })

  it('orders base, then project rules, then user extra', () => {
    const p = buildSystemPrompt('/tmp/x', 'be terse', '### AGENTS.md\nUse tabs.')
    expect(p.indexOf('Project instructions')).toBeLessThan(p.indexOf('Additional user instructions'))
    expect(p).toContain('be terse')
  })

  it('ignores blank rules / extra strings', () => {
    const p = buildSystemPrompt('/tmp/x', '   ', '  \n ')
    expect(p).not.toContain('Project instructions')
    expect(p).not.toContain('Additional user instructions')
  })

  it('adds a plan-mode notice only when plan mode is on', () => {
    expect(buildSystemPrompt('/tmp/x')).not.toContain('PLAN MODE')
    expect(buildSystemPrompt('/tmp/x', undefined, undefined, true)).toContain('PLAN MODE IS ON')
  })

  it('lists view_localhost by default but omits it when capture is unavailable', () => {
    expect(buildSystemPrompt('/tmp/x')).toContain('view_localhost')
    const noCapture = buildSystemPrompt(
      '/tmp/x',
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      false
    )
    expect(noCapture).not.toContain('view_localhost')
    // The neighbouring tool bullets must survive the removal.
    expect(noCapture).toContain('- web_fetch:')
    expect(noCapture).toContain('- web_search:')
  })

  it('lists spawn_session by default but omits it when no spawn backend is wired', () => {
    expect(buildSystemPrompt('/tmp/x')).toContain('spawn_session')
    const noSpawn = buildSystemPrompt(
      '/tmp/x',
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      false
    )
    expect(noSpawn).not.toContain('spawn_session')
    // The neighbouring tool bullet must survive the removal.
    expect(noSpawn).toContain('- dispatch_agent:')
  })

  it('lists the schedule tools by default but omits them when no scheduler is wired', () => {
    expect(buildSystemPrompt('/tmp/x')).toContain('schedule_run')
    const noScheduler = buildSystemPrompt(
      '/tmp/x',
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      false
    )
    expect(noScheduler).not.toContain('schedule_run')
    // The neighbouring tool bullets must survive the removal.
    expect(noScheduler).toContain('- dispatch_agent:')
    expect(noScheduler).toContain('spawn_session')
  })

  describe('per-model addendum', () => {
    const base = buildSystemPrompt('/tmp/x')

    it('appends the apply_patch line for the OpenAI provider', () => {
      const p = buildSystemPrompt('/tmp/x', undefined, undefined, undefined, undefined, undefined, 'openai', 'gpt-4o')
      expect(p).toContain('apply_patch is available for multi-file edits')
      expect(p).not.toContain('local model')
    })

    it('appends the apply_patch line for GPT / codex / o-series model names on any provider', () => {
      for (const model of ['gpt-4o', 'gpt-5-codex', 'codex-mini', 'o3', 'o4-mini']) {
        const p = buildSystemPrompt('/tmp/x', undefined, undefined, undefined, undefined, undefined, 'custom-endpoint', model)
        expect(p, model).toContain('apply_patch is available for multi-file edits')
      }
    })

    it('appends the concise-tool-use line for local (ollama / lmstudio) providers', () => {
      for (const id of ['ollama', 'lmstudio']) {
        const p = buildSystemPrompt('/tmp/x', undefined, undefined, undefined, undefined, undefined, id, 'llama3')
        expect(p, id).toContain('prefer concise, deliberate tool use')
        expect(p, id).not.toContain('apply_patch is available')
      }
    })

    it('adds no addendum for Anthropic / Gemini families', () => {
      const anthropic = buildSystemPrompt('/tmp/x', undefined, undefined, undefined, undefined, undefined, 'anthropic', 'claude-opus-4-8')
      const gemini = buildSystemPrompt('/tmp/x', undefined, undefined, undefined, undefined, undefined, 'gemini', 'gemini-2.5-pro')
      expect(anthropic).not.toContain('apply_patch is available')
      expect(anthropic).not.toContain('prefer concise, deliberate tool use')
      expect(gemini).not.toContain('apply_patch is available')
      expect(gemini).not.toContain('prefer concise, deliberate tool use')
    })

    it('leaves the base prompt byte-for-byte identical when no provider/model is given', () => {
      // Same call as the rest of the suite — the new params are optional and inert by default.
      expect(buildSystemPrompt('/tmp/x')).toBe(base)
    })

    it('only adds the addendum — the base prompt is otherwise unchanged', () => {
      const openai = buildSystemPrompt('/tmp/x', undefined, undefined, undefined, undefined, undefined, 'openai', 'gpt-4o')
      const addendum = 'apply_patch is available for multi-file edits: prefer it when a single change spans several files.'
      // Stripping the appended section (and its separator) recovers the unmodified base.
      expect(openai).toBe(`${base}\n\n${addendum}`)
    })
  })
})
