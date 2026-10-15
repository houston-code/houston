import { describe, expect, it } from 'vitest'
import { SYSTEM_NOTE_PREFIX } from '@shared/agent'
import { buildSystemPrompt, type PromptHost } from './prompt'

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

  it('puts the git snapshot last, after rules and user extra', () => {
    // The snapshot changes between turns; everything before it stays a stable prefix.
    const p = buildSystemPrompt(
      '/tmp/x',
      'be terse',
      '### AGENTS.md\nUse tabs.',
      true,
      'Skills available for this project.',
      'Git: on branch main, 2 files modified.'
    )
    expect(p.endsWith('Git: on branch main, 2 files modified.')).toBe(true)
    expect(p.indexOf('Additional user instructions')).toBeLessThan(p.indexOf('Git: on branch main'))
    expect(p.indexOf('PLAN MODE IS ON')).toBeLessThan(p.indexOf('Skills available'))
  })

  it('tells the model how to recognize Houston\'s own automated notes', () => {
    // Pinned to the constant the loop prefixes its notes with, so the two can't drift.
    expect(buildSystemPrompt('/tmp/x')).toContain(`Messages that begin "${SYSTEM_NOTE_PREFIX}"`)
  })

  it('ignores blank rules / extra strings', () => {
    const p = buildSystemPrompt('/tmp/x', '   ', '  \n ')
    expect(p).not.toContain('Project instructions')
    expect(p).not.toContain('Additional user instructions')
  })

  it('tells the model to fit dependencies to the installed toolchain and current releases', () => {
    const p = buildSystemPrompt('/tmp/x')
    // Seen in practice: a scaffold pinned a stale, vulnerable framework version from
    // memory and a native addon with no prebuild for the installed Node, so
    // `npm install` failed on a compiler error.
    expect(p).toMatch(/check the toolchain that is actually installed/)
    expect(p).toMatch(/Don't pin versions from memory/)
    expect(p).toMatch(/npm view <pkg> version/)
    expect(p).toMatch(/keep the versions it already pins/)
    expect(p).toMatch(/needs no native compile step/)
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
    // The neighbouring verification bullets must survive the removal.
    expect(noCapture).toContain('Never describe unverified work as tested or working.')
    expect(noCapture).toContain('- For a large or security-sensitive change, review_changes')
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
    // The delegation guidance it extends must survive the removal.
    expect(noSpawn).toContain("don't dispatch agents just to double-check your own work.")
    expect(noSpawn).toContain('schedule_run')
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
    expect(noScheduler).toContain('dispatch_agent suits')
    expect(noScheduler).toContain('spawn_session')
    expect(noScheduler).toContain('use web_search or web_fetch rather than guessing.')
  })

  describe('per-model addendum', () => {
    const base = buildSystemPrompt('/tmp/x')
    const OPENAI_ADDENDUM =
      'apply_patch is available for multi-file edits: prefer it when a single change spans several files. When the user asks for a change, carry it through to a verified result in this turn rather than stopping to propose a plan or ask whether to continue.'
    const GEMINI_ADDENDUM =
      'After every tool result, either make the next tool call or reply to the user. Never end a reply with no text and no tool call.'

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

    it('adds no addendum for the Anthropic family', () => {
      const anthropic = buildSystemPrompt('/tmp/x', undefined, undefined, undefined, undefined, undefined, 'anthropic', 'claude-opus-4-8')
      expect(anthropic).toBe(base)
    })

    it('appends the no-empty-reply line for Gemini models on any provider', () => {
      for (const [id, model] of [
        ['gemini', 'gemini-2.5-pro'],
        ['vertex', 'gemini-2.5-flash'],
        ['openrouter', 'google/gemini-2.5-pro']
      ]) {
        const p = buildSystemPrompt('/tmp/x', undefined, undefined, undefined, undefined, undefined, id, model)
        expect(p, `${id}/${model}`).toBe(`${base}\n\n${GEMINI_ADDENDUM}`)
      }
    })

    it('leaves the base prompt byte-for-byte identical when no provider/model is given', () => {
      // Same call as the rest of the suite — the new params are optional and inert by default.
      expect(buildSystemPrompt('/tmp/x')).toBe(base)
    })

    it('only adds the addendum — the base prompt is otherwise unchanged', () => {
      const openai = buildSystemPrompt('/tmp/x', undefined, undefined, undefined, undefined, undefined, 'openai', 'gpt-4o')
      // Stripping the appended section (and its separator) recovers the unmodified base.
      expect(openai).toBe(`${base}\n\n${OPENAI_ADDENDUM}`)
    })
  })

  describe('host awareness', () => {
    const withHost = (host: PromptHost): string =>
      buildSystemPrompt(
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
        undefined,
        host
      )
    const CONFINED = 'Shell commands run inside an OS sandbox confined to the project'
    const UNCONFINED = 'This host has no OS sandbox, so run_shell commands run unconfined'
    const EGRESS = 'Granted network is limited to an allowlist'

    it('defaults to a sandboxed macOS host', () => {
      expect(buildSystemPrompt('/tmp/x')).toBe(withHost({ platform: 'darwin', sandboxBackend: 'seatbelt' }))
    })

    it('describes a Seatbelt host as sandboxed macOS, with the egress allowlist', () => {
      const p = withHost({ platform: 'darwin', sandboxBackend: 'seatbelt' })
      expect(p).toContain("working on the user's macOS machine")
      expect(p).toContain(CONFINED)
      expect(p).toContain(EGRESS)
      expect(p).toContain('BSD variants')
      expect(p).not.toContain(UNCONFINED)
    })

    it('describes a bubblewrap host as sandboxed Linux, without macOS tool notes', () => {
      const p = withHost({ platform: 'linux', sandboxBackend: 'bubblewrap' })
      expect(p).toContain("working on the user's Linux machine")
      expect(p).toContain(CONFINED)
      expect(p).toContain(EGRESS)
      expect(p).not.toContain('macOS')
    })

    it('never claims a sandbox or an egress allowlist on Windows', () => {
      // Regression: the prompt once said "macOS sandbox" on every host, telling the
      // model its commands were confined on hosts where they run with full privileges.
      const p = withHost({ platform: 'win32', sandboxBackend: 'windows' })
      expect(p).toContain("working on the user's Windows machine")
      expect(p).toContain(UNCONFINED)
      expect(p).toContain('cmd.exe')
      expect(p).not.toContain(CONFINED)
      expect(p).not.toContain(EGRESS)
      expect(p).not.toContain('macOS')
    })

    it('names the OS from the platform when no sandbox backend is available', () => {
      // Linux without a usable bubblewrap falls back to the unconfined backend.
      const p = withHost({ platform: 'linux', sandboxBackend: 'none' })
      expect(p).toContain("working on the user's Linux machine")
      expect(p).toContain(UNCONFINED)
      expect(p).not.toContain(CONFINED)
      expect(p).not.toContain(EGRESS)
      const mac = withHost({ platform: 'darwin', sandboxBackend: 'none' })
      expect(mac).toContain("working on the user's macOS machine")
      expect(mac).toContain(UNCONFINED)
    })
  })
})
