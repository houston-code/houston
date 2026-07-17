import { describe, it, expect } from 'vitest'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AppSettings, Hook, McpServerConfig, ProviderConfig } from '@shared/types'
import { catalogForPlatform } from '@shared/provider-catalog'
import type { AgentEvent, ChatMessage, ElicitationResult, PlanDecision } from '@shared/agent'
import { LEGAL_VERSION } from '@shared/legal'
import { BUILTIN_TEMPLATE_COMMANDS, REVIEW_TEMPLATE, type Command } from '@shared/commands'
import {
  parseTuiArgs,
  makePainter,
  isThemeName,
  renderToolStart,
  toolArgHint,
  renderApprovalPrompt,
  parseApprovalAnswer,
  renderQuestion,
  resolveQuestionAnswer,
  parseSlashCommand,
  resolveModelArg,
  keyableProviders,
  renderProviderMenu,
  summarizeModels,
  otherHostExamples,
  parseProviderMenuChoice,
  renderCatalogMenu,
  parseCatalogChoice,
  renderNoModelStatus,
  composerPrompt,
  extractDiff,
  renderPreviewDiff,
  colorizeDiff,
  renderToolResult,
  renderReasoningStatus,
  renderMcpTools,
  resolveTheme,
  THEMES,
  parseMemoryCapture,
  nextPolicy,
  addModelUsage,
  renderCostReport,
  renderRecoveredOutput,
  toolResultsFrom,
  FAILURE_LINES,
  VERBOSE_LINES,
  OUTPUT_LINES,
  parseShellEscape,
  renderShellEscapeRecord,
  renderBackgroundSessions,
  parseSessionSelection,
  type BackgroundSession,
  formatSessionCost,
  parseResumeSelection,
  formatRelativeTime,
  renderConversationList,
  subagentGlyph,
  shortCwd,
  renderStatusLine,
  spinnerFrame,
  renderCapabilityList,
  mediaTypeForImagePath,
  runTui,
  HOOK_EVENTS,
  promptFolderTrust,
  summarizeElevated,
  parseSettingsAction,
  resolveHookEventInput,
  buildHook,
  buildStdioMcpServer,
  renderHookList,
  renderMcpList,
  type TuiDeps,
  type TuiIo,
  type TuiPersist,
  type ResumeEntry
} from './tui'

/** A full ProviderConfig from a partial — fills kind/label/builtIn for /login tests. */
const prov = (over: Partial<ProviderConfig>): ProviderConfig =>
  ({
    id: 'x',
    kind: 'openai-compatible',
    label: over.id ?? 'x',
    requiresKey: true,
    hasKey: false,
    models: [],
    builtIn: false,
    ...over
  }) as ProviderConfig

const settings = (over: Partial<AppSettings> = {}): AppSettings =>
  ({
    schemaVersion: 1,
    providers: [
      { id: 'anthropic', requiresKey: true, hasKey: true, models: [{ id: 'claude' }], defaultModel: 'claude' },
      { id: 'ollama', requiresKey: false, hasKey: false, models: [{ id: 'llama' }] }
    ],
    selected: null,
    approvalPolicy: 'ask',
    recentWorkspaces: [],
    ...over
  }) as unknown as AppSettings

describe('parseTuiArgs', () => {
  it('returns null without an interactive flag', () => {
    expect(parseTuiArgs(['node', 'app'], '/cwd')).toBeNull()
    expect(parseTuiArgs(['node', 'app', '-p', 'do it'], '/cwd')).toBeNull()
  })

  it('enables on -i / --interactive / --tui', () => {
    expect(parseTuiArgs(['-i'], '/d')).not.toBeNull()
    expect(parseTuiArgs(['--interactive'], '/d')).not.toBeNull()
    expect(parseTuiArgs(['--tui'], '/d')).not.toBeNull()
  })

  it('defaults cwd, approval=ask, and no acceptTerms', () => {
    const o = parseTuiArgs(['-i'], '/here')
    expect(o).toMatchObject({ cwd: '/here', approvalPolicy: 'ask', acceptTerms: false, color: true })
  })

  it('parses cwd / provider / model / approval / accept-terms', () => {
    const o = parseTuiArgs(
      ['-i', '--cwd', '/proj', '--provider', 'openai', '--model=gpt', '--approval', 'auto-edit', '--accept-terms'],
      '/d'
    )
    expect(o).toMatchObject({
      cwd: '/proj',
      providerId: 'openai',
      model: 'gpt',
      approvalPolicy: 'auto-edit',
      acceptTerms: true
    })
  })

  it('--full-auto sets the policy, invalid --approval is ignored', () => {
    expect(parseTuiArgs(['-i', '--full-auto'], '/d')?.approvalPolicy).toBe('full-auto')
    expect(parseTuiArgs(['-i', '--approval', 'bogus'], '/d')?.approvalPolicy).toBe('ask')
  })

  it('defaultInteractive treats a bare invocation as interactive', () => {
    // Absent the flag, still null by default (desktop binary falls through to GUI)...
    expect(parseTuiArgs(['node', 'app'], '/d')).toBeNull()
    expect(parseTuiArgs(['node', 'app'], '/d', false)).toBeNull()
    // ...but non-null when the caller opts in (bare `houston` at a TTY).
    expect(parseTuiArgs(['node', 'app'], '/d', true)).not.toBeNull()
  })

  it('defaultInteractive still parses the other flags', () => {
    const o = parseTuiArgs(['--cwd', '/proj', '--model=gpt', '--full-auto'], '/d', true)
    expect(o).toMatchObject({ cwd: '/proj', model: 'gpt', approvalPolicy: 'full-auto' })
  })
})

describe('makePainter', () => {
  it('emits no escape codes when color is off', () => {
    const paint = makePainter(false)
    expect(paint('hi', 'red', 'bold')).toBe('hi')
  })

  it('wraps with reset when color is on', () => {
    const paint = makePainter(true)
    const s = paint('hi', 'red')
    expect(s).toContain('hi')
    expect(s).toContain('\x1b[31m')
    expect(s.endsWith('\x1b[0m')).toBe(true)
  })

  it('applies the dark theme (high-intensity foregrounds)', () => {
    expect(makePainter(true, 'dark')('x', 'cyan')).toContain('\x1b[96m')
  })

  it('mono theme drops color but keeps bold structure', () => {
    const paint = makePainter(true, 'mono')
    expect(paint('x', 'cyan')).toBe('x') // no color code emitted
    expect(paint('x', 'bold')).toContain('\x1b[1m') // structure preserved
  })

  it('isThemeName guards known themes', () => {
    expect(isThemeName('dark')).toBe(true)
    expect(isThemeName('nope')).toBe(false)
    // `bright` was renamed to `dark`; it is an alias now, not a palette of its own.
    expect(isThemeName('bright')).toBe(false)
    expect(resolveTheme('bright')).toBe('dark')
  })
})

describe('tool rendering', () => {
  it('summarizes a tool start with its salient arg', () => {
    const line = renderToolStart('read_file', { path: 'src/x.ts' }, makePainter(false))
    expect(line).toContain('read_file')
    expect(line).toContain('src/x.ts')
  })

  it('picks a hint from known arg keys and collapses whitespace', () => {
    expect(toolArgHint({ command: 'ls  -la\n/tmp' })).toBe('ls -la /tmp')
    expect(toolArgHint({})).toBe('')
  })

  it('truncates long hints', () => {
    const long = 'a'.repeat(200)
    expect(toolArgHint({ query: long }).length).toBeLessThanOrEqual(80)
  })
})

describe('approval prompt', () => {
  const ev = (over: Partial<Extract<AgentEvent, { type: 'tool_approval' }>> = {}) =>
    ({
      runId: 'r',
      type: 'tool_approval',
      callId: 'c',
      name: 'run_shell',
      summary: 'rm -rf build',
      kind: 'shell',
      ...over
    }) as Extract<AgentEvent, { type: 'tool_approval' }>

  it('shows name, kind, and summary', () => {
    const p = renderApprovalPrompt(ev(), makePainter(false))
    expect(p).toContain('run_shell')
    expect(p).toContain('[shell]')
    expect(p).toContain('rm -rf build')
  })

  it('warns when a shell command runs unsandboxed', () => {
    expect(renderApprovalPrompt(ev({ sandboxed: false }), makePainter(false))).toContain('UNSANDBOXED')
    expect(renderApprovalPrompt(ev({ sandboxed: true }), makePainter(false))).not.toContain('UNSANDBOXED')
    // Non-shell kinds never carry the shell warning.
    expect(renderApprovalPrompt(ev({ kind: 'write', sandboxed: false }), makePainter(false))).not.toContain(
      'UNSANDBOXED'
    )
  })

  it('frames the shell-network consent as a network grant, not a command gate', () => {
    const p = renderApprovalPrompt(ev({ shellNetwork: true }), makePainter(false))
    expect(p).toContain('network')
    expect(p).toContain('offline')
    // It replaces the generic command-approval prompt (no "always allow this kind").
    expect(p).not.toContain('always allow this kind')
    // And it never doubles as the unsandboxed warning.
    expect(p).not.toContain('UNSANDBOXED')
  })

  it('parses answers, defaulting to deny', () => {
    expect(parseApprovalAnswer('y')).toEqual({ decision: 'allow' })
    expect(parseApprovalAnswer('YES')).toEqual({ decision: 'allow' })
    expect(parseApprovalAnswer('allow')).toEqual({ decision: 'allow' })
    expect(parseApprovalAnswer('a')).toEqual({ decision: 'always' })
    expect(parseApprovalAnswer('always')).toEqual({ decision: 'always' })
    expect(parseApprovalAnswer('n')).toEqual({ decision: 'deny' })
    expect(parseApprovalAnswer('')).toEqual({ decision: 'deny' })
  })

  it('exposes the rule-persisting decisions the core supports', () => {
    // These existed in the core all along; the terminal used to type them away.
    expect(parseApprovalAnswer('!')).toEqual({ decision: 'rule-allow' })
    expect(parseApprovalAnswer('x')).toEqual({ decision: 'rule-deny' })
  })

  // The gap this closes: a typed explanation used to be silently converted to a
  // bare deny, so the user thought they had given direction and the agent saw only
  // a refusal.
  it('keeps a typed explanation as the reason for the denial', () => {
    expect(parseApprovalAnswer('use the staging bucket, not prod')).toEqual({
      decision: 'deny',
      note: 'use the staging bucket, not prod'
    })
  })
})

describe('question rendering + answer resolution', () => {
  const opts = [
    { label: 'Yes', description: 'do it' },
    { label: 'No' },
    { label: 'Maybe' }
  ]

  it('renders the question with numbered options', () => {
    const q = renderQuestion('Proceed?', opts, false, makePainter(false))
    expect(q).toContain('Proceed?')
    expect(q).toContain('1. Yes')
    expect(q).toContain('do it')
    expect(q).toContain('2. No')
  })

  it('maps a number to its option label', () => {
    expect(resolveQuestionAnswer('2', opts, false)).toBe('No')
  })

  it('maps comma-separated numbers when multiSelect', () => {
    expect(resolveQuestionAnswer('1, 3', opts, true)).toBe('Yes, Maybe')
  })

  it('passes custom free text through verbatim', () => {
    expect(resolveQuestionAnswer('something else', opts, false)).toBe('something else')
  })

  it('passes an out-of-range number through as text', () => {
    expect(resolveQuestionAnswer('9', opts, false)).toBe('9')
  })

  it('returns empty for empty input', () => {
    expect(resolveQuestionAnswer('   ', opts, false)).toBe('')
  })
})

describe('parseSlashCommand', () => {
  const s = settings()

  it('treats non-slash lines as prompt text', () => {
    expect(parseSlashCommand('hello world', s)).toEqual({ kind: 'not-a-command' })
  })

  it('recognizes exit aliases', () => {
    for (const c of ['/exit', '/quit', '/q']) expect(parseSlashCommand(c, s)).toEqual({ kind: 'exit' })
  })

  it('recognizes clear/new', () => {
    expect(parseSlashCommand('/clear', s)).toEqual({ kind: 'clear' })
    expect(parseSlashCommand('/new', s)).toEqual({ kind: 'clear' })
  })

  it('recognizes resume (with optional query), sessions alias, and fork', () => {
    expect(parseSlashCommand('/resume', s)).toEqual({ kind: 'resume', query: '' })
    expect(parseSlashCommand('/resume auth bug', s)).toEqual({ kind: 'resume', query: 'auth bug' })
    expect(parseSlashCommand('/sessions', s)).toEqual({ kind: 'resume', query: '' })
    expect(parseSlashCommand('/fork', s)).toEqual({ kind: 'fork' })
  })

  it('recognizes the file-backed capability commands (skills / agents)', () => {
    expect(parseSlashCommand('/skills', s)).toEqual({ kind: 'capability', which: 'skills' })
    expect(parseSlashCommand('/agents', s)).toEqual({ kind: 'capability', which: 'agents' })
  })

  it('routes /settings, /hooks and /mcp to the settings surface', () => {
    expect(parseSlashCommand('/settings', s)).toEqual({ kind: 'settings' })
    expect(parseSlashCommand('/hooks', s)).toEqual({ kind: 'hooks', action: { op: 'list' } })
    expect(parseSlashCommand('/hooks add', s)).toEqual({ kind: 'hooks', action: { op: 'add' } })
    expect(parseSlashCommand('/hooks remove 2', s)).toEqual({ kind: 'hooks', action: { op: 'remove', index: 2 } })
    expect(parseSlashCommand('/mcp', s)).toEqual({ kind: 'mcp', action: { op: 'list' } })
    expect(parseSlashCommand('/mcp add', s)).toEqual({ kind: 'mcp', action: { op: 'add' } })
    expect(parseSlashCommand('/mcp remove 1', s)).toEqual({ kind: 'mcp', action: { op: 'remove', index: 1 } })
  })

  it('sets a valid theme, else stays informational', () => {
    // `bright` resolves to its new name rather than erroring.
    expect(parseSlashCommand('/theme bright', s)).toEqual({ kind: 'set-theme', theme: 'dark' })
    expect(parseSlashCommand('/theme light', s)).toEqual({ kind: 'set-theme', theme: 'light' })
    expect(parseSlashCommand('/theme mono', s)).toEqual({ kind: 'set-theme', theme: 'mono' })
    expect(parseSlashCommand('/theme bogus', s)).toEqual({ kind: 'handled' })
    expect(parseSlashCommand('/theme', s)).toEqual({ kind: 'handled' })
  })

  it('recognizes /image with a path, and bare /image as a paste', () => {
    expect(parseSlashCommand('/image shot.png', s)).toEqual({ kind: 'image', path: 'shot.png' })
    // A bare /image means "attach what I just copied" — the common case. It used
    // to print usage, which helped nobody who had already copied a screenshot.
    expect(parseSlashCommand('/image', s)).toEqual({ kind: 'paste-image' })
    expect(parseSlashCommand('/paste', s)).toEqual({ kind: 'paste-image' })
  })

  it('sets a valid approval policy, else stays informational', () => {
    expect(parseSlashCommand('/approval auto-edit', s)).toEqual({ kind: 'set-approval', policy: 'auto-edit' })
    expect(parseSlashCommand('/approval bogus', s)).toEqual({ kind: 'handled' })
    expect(parseSlashCommand('/approval', s)).toEqual({ kind: 'handled' })
  })

  it('sets a model when the arg resolves', () => {
    expect(parseSlashCommand('/model ollama', s)).toEqual({
      kind: 'set-model',
      providerId: 'ollama',
      model: 'llama'
    })
    expect(parseSlashCommand('/model', s)).toEqual({ kind: 'handled' })
    expect(parseSlashCommand('/model nope', s)).toEqual({ kind: 'handled' })
  })

  it('maps /plan to plan mode and /compact to compact', () => {
    expect(parseSlashCommand('/plan', s)).toEqual({ kind: 'set-approval', policy: 'plan' })
    expect(parseSlashCommand('/compact', s)).toEqual({ kind: 'compact' })
  })

  it('resolves first-party template commands (/review) to a prompt turn', () => {
    expect(parseSlashCommand('/review', s, BUILTIN_TEMPLATE_COMMANDS)).toEqual({
      kind: 'prompt',
      text: REVIEW_TEMPLATE
    })
  })

  it('resolves a custom command to its expanded prompt, appending args', () => {
    const custom: Command[] = [{ name: 'ship', description: 'Ship it', template: 'Do the release' }]
    expect(parseSlashCommand('/ship', s, custom)).toEqual({ kind: 'prompt', text: 'Do the release' })
    expect(parseSlashCommand('/ship v2 now', s, custom)).toEqual({
      kind: 'prompt',
      text: 'Do the release\n\nv2 now'
    })
  })

  it('substitutes $ARGUMENTS in a custom template', () => {
    const custom: Command[] = [{ name: 'fix', description: 'Fix', template: 'Fix the $ARGUMENTS bug' }]
    expect(parseSlashCommand('/fix login', s, custom)).toEqual({ kind: 'prompt', text: 'Fix the login bug' })
  })

  it('marks unknown commands', () => {
    expect(parseSlashCommand('/frobnicate', s)).toEqual({ kind: 'unknown', name: 'frobnicate' })
    // A name not among the passed commands is still unknown, not a prompt.
    expect(parseSlashCommand('/frobnicate', s, BUILTIN_TEMPLATE_COMMANDS)).toEqual({
      kind: 'unknown',
      name: 'frobnicate'
    })
  })
})

describe('settings editing helpers', () => {
  it('parseSettingsAction: bare → list, add, remove <n>, else usage', () => {
    expect(parseSettingsAction('')).toEqual({ op: 'list' })
    expect(parseSettingsAction('   ')).toEqual({ op: 'list' })
    expect(parseSettingsAction('add')).toEqual({ op: 'add' })
    expect(parseSettingsAction('remove 3')).toEqual({ op: 'remove', index: 3 })
    expect(parseSettingsAction('rm 1')).toEqual({ op: 'remove', index: 1 })
    expect(parseSettingsAction('remove')).toEqual({ op: 'usage' }) // no index
    expect(parseSettingsAction('remove 0')).toEqual({ op: 'usage' }) // 1-based
    expect(parseSettingsAction('remove x')).toEqual({ op: 'usage' })
    expect(parseSettingsAction('bogus')).toEqual({ op: 'usage' })
  })

  it('resolveHookEventInput maps a number or passes a name through', () => {
    expect(resolveHookEventInput('1')).toBe('PreToolUse')
    expect(resolveHookEventInput('2')).toBe('PostToolUse')
    expect(resolveHookEventInput(String(HOOK_EVENTS.length))).toBe(HOOK_EVENTS[HOOK_EVENTS.length - 1])
    expect(resolveHookEventInput('99')).toBe('99') // out of range → left as-is (rejected downstream)
    expect(resolveHookEventInput('Stop')).toBe('Stop')
  })

  it('buildHook validates the event and requires a command', () => {
    expect(buildHook('PostToolUse', 'edit_file', 'npm test')).toEqual({
      event: 'PostToolUse',
      matcher: 'edit_file',
      command: 'npm test'
    })
    // Blank matcher becomes "any".
    expect(buildHook('Stop', '', 'echo done')).toEqual({ event: 'Stop', matcher: '*', command: 'echo done' })
    expect(buildHook('Nope', '*', 'x')).toEqual({ error: expect.stringContaining('unknown event') })
    expect(buildHook('PostToolUse', '*', '   ')).toEqual({ error: expect.stringContaining('command') })
  })

  it('buildStdioMcpServer builds a header-free stdio config and validates input', () => {
    expect(buildStdioMcpServer([], 'files', 'npx', '-y @scope/server .')).toEqual({
      id: 'files',
      name: 'files',
      transport: 'stdio',
      command: 'npx',
      args: ['-y', '@scope/server', '.'],
      enabled: true
    })
    // No args → args omitted (not an empty array).
    expect(buildStdioMcpServer([], 'plain', 'my-server', '')).toEqual({
      id: 'plain',
      name: 'plain',
      transport: 'stdio',
      command: 'my-server',
      enabled: true
    })
    // Never produces a url or headers — it's a local process, no auth path.
    const built = buildStdioMcpServer([], 'x', 'cmd', '')
    expect('error' in built ? {} : built).not.toHaveProperty('url')
    expect('error' in built ? {} : built).not.toHaveProperty('headers')

    expect(buildStdioMcpServer([], 'bad name', 'cmd', '')).toEqual({ error: expect.stringContaining('name') })
    expect(buildStdioMcpServer(['dup'], 'dup', 'cmd', '')).toEqual({ error: expect.stringContaining('already exists') })
    expect(buildStdioMcpServer([], 'ok', '', '')).toEqual({ error: expect.stringContaining('command') })
  })

  it('renderMcpList never prints a header value (secret) — only the transport summary', () => {
    const withSecret: McpServerConfig = {
      id: 'remote',
      name: 'remote',
      transport: 'http',
      command: '',
      url: 'https://example.com/mcp',
      headers: { Authorization: 'super-secret-token' },
      enabled: true
    }
    const out = renderMcpList([withSecret], makePainter(false))
    expect(out).toContain('remote')
    expect(out).toContain('https://example.com/mcp')
    expect(out).not.toContain('super-secret-token')
    expect(out).not.toContain('Authorization')
  })

  it('renderHookList / renderMcpList show a "none" note when empty', () => {
    expect(renderHookList([], makePainter(false))).toContain('No hooks')
    expect(renderMcpList([], makePainter(false))).toContain('No MCP servers')
  })
})

describe('resolveModelArg', () => {
  const s = settings()
  it('resolves a provider id to its default model', () => {
    expect(resolveModelArg('anthropic', s)).toEqual({ providerId: 'anthropic', model: 'claude' })
  })
  it('resolves providerId/model', () => {
    expect(resolveModelArg('anthropic/opus', s)).toEqual({ providerId: 'anthropic', model: 'opus' })
  })
  it('resolves a bare model id its provider offers', () => {
    expect(resolveModelArg('llama', s)).toEqual({ providerId: 'ollama', model: 'llama' })
  })
  it('returns null for an unknown arg', () => {
    expect(resolveModelArg('mystery', s)).toBeNull()
    expect(resolveModelArg('anthropic/', s)).toBeNull()
  })
})

describe('composerPrompt', () => {
  it('reflects the live policy', () => {
    expect(composerPrompt('auto-edit', makePainter(false))).toContain('auto-edit')
  })
})

describe('renderPreviewDiff', () => {
  it('renders an overwrite as the lines that changed, not as a whole new file', () => {
    // What extractDiff cannot do: it has only the args, so it must show every line
    // of a write_file as added. The preview knows what the file held.
    const d = renderPreviewDiff([
      {
        path: 'a.ts',
        diff: [
          { type: 'ctx', text: 'keep' },
          { type: 'del', text: 'was here' },
          { type: 'add', text: 'now here' }
        ]
      }
    ])
    expect(d).toContain('--- a.ts')
    expect(d).toContain('+++ a.ts')
    expect(d).toContain(' keep')
    expect(d).toContain('-was here')
    expect(d).toContain('+now here')
    expect(d).not.toContain('(new file)')
  })

  it('renders every file of a multi-file patch, tagging new and deleted ones', () => {
    const d = renderPreviewDiff([
      { path: 'new.ts', created: true, diff: [{ type: 'add', text: 'x' }] },
      { path: 'gone.ts', deleted: true, diff: [{ type: 'del', text: 'y' }] }
    ])
    expect(d).toContain('+++ new.ts (new file)')
    expect(d).toContain('+++ gone.ts (deleted)')
    expect(d).toContain('+x')
    expect(d).toContain('-y')
  })

  it('shows a rename as the old path on the left and the new one on the right', () => {
    const d = renderPreviewDiff([{ path: 'new.ts', renamedFrom: 'old.ts', diff: [{ type: 'add', text: 'x' }] }])
    expect(d).toContain('--- old.ts')
    expect(d).toContain('+++ new.ts')
  })

  it('says when the diff was cut short, and returns null with nothing to render', () => {
    expect(renderPreviewDiff([{ path: 'a.ts', truncated: true, diff: [{ type: 'add', text: 'x' }] }])).toContain(
      'diff shortened'
    )
    expect(renderPreviewDiff([])).toBeNull()
  })

  it('produces headers colorizeDiff recognizes', () => {
    const paint = (s: string, c: string): string => `<${c}>${s}</${c}>`
    const out = colorizeDiff(
      renderPreviewDiff([{ path: 'a.ts', diff: [{ type: 'add', text: 'x' }] }]) as string,
      paint
    )
    expect(out).toContain('<cyan>--- a.ts</cyan>')
    expect(out).toContain('<green>+x</green>')
  })
})

describe('extractDiff', () => {
  it('returns a ready patch envelope as-is', () => {
    expect(extractDiff({ patch: '*** Update File: a.ts\n+x' })).toBe('*** Update File: a.ts\n+x')
  })

  it('synthesizes a diff from edit_file old/new strings', () => {
    const d = extractDiff({ path: 'a.ts', old_string: 'foo', new_string: 'bar' })
    expect(d).toContain('--- a.ts')
    expect(d).toContain('-foo')
    expect(d).toContain('+bar')
  })

  it('renders a whole-file write as an all-added diff', () => {
    const d = extractDiff({ path: 'new.ts', content: 'line1\nline2' })
    expect(d).toContain('new.ts (new file)')
    expect(d).toContain('+line1')
    expect(d).toContain('+line2')
  })

  it('returns null when nothing is derivable', () => {
    expect(extractDiff({ path: 'a.ts' })).toBeNull()
    expect(extractDiff({ patch: '  ' })).toBeNull()
  })
})

describe('colorizeDiff', () => {
  it('prefixes each line and truncates past the cap', () => {
    const diff = Array.from({ length: 50 }, (_, i) => `+line ${i}`).join('\n')
    const out = colorizeDiff(diff, makePainter(false), 10)
    expect(out).toContain('+line 0')
    expect(out).toContain('40 more lines')
  })

  it('classifies header lines before +/- so +++/--- are not mistaken for adds', () => {
    // With color off we can only assert content survives; classification is exercised
    // with color on below.
    const paint = makePainter(true)
    const out = colorizeDiff('+++ a.ts\n+added\n-removed\n context', paint)
    expect(out).toContain('+++ a.ts')
    expect(out).toContain('added')
    expect(out).toContain('removed')
  })
})

describe('renderToolResult', () => {
  const paint = makePainter(false)
  it('marks failures', () => {
    expect(renderToolResult('run_shell', false, '', paint)).toContain('failed')
  })
  it('shows the first non-empty output line as a snippet', () => {
    expect(renderToolResult('read_file', true, '\n\nhello world\nmore', paint)).toContain('hello world')
  })
  it('is empty for successful no-output results', () => {
    expect(renderToolResult('x', true, '   \n  ', paint)).toBe('')
  })

  // A failure used to render as "✗ run_shell failed" and throw the error away —
  // the one case where the output IS the point.
  it('shows why a tool failed, not just that it did', () => {
    const out = renderToolResult('run_shell', false, "error: cannot find module 'x'\n  at foo.js:3", paint)
    expect(out).toContain('failed')
    expect(out).toContain("cannot find module 'x'")
    expect(out).toContain('at foo.js:3')
  })

  it('caps a long failure and says where the rest is', () => {
    const body = Array.from({ length: 40 }, (_, i) => `line ${i}`).join('\n')
    const out = renderToolResult('run_shell', false, body, paint)
    expect(out).toContain('line 0')
    expect(out).not.toContain('line 39')
    expect(out).toContain(`${40 - FAILURE_LINES} more lines`)
    expect(out).toContain('/output')
  })

  it('still just marks a failure that produced no output', () => {
    expect(renderToolResult('run_shell', false, '  \n ', paint)).toBe('  ✗ run_shell failed')
  })

  it('verbose opens up a successful result', () => {
    const out = renderToolResult('read_file', true, 'a\nb\nc', paint, { verbose: true })
    expect(out).toContain('a')
    expect(out).toContain('c')
  })

  it('verbose caps a huge result rather than flooding the transcript', () => {
    const body = Array.from({ length: 100 }, (_, i) => `l${i}`).join('\n')
    const out = renderToolResult('run_shell', true, body, paint, { verbose: true })
    expect(out).toContain('l0')
    expect(out).not.toContain('l99')
    expect(out).toContain(`${100 - VERBOSE_LINES} more lines`)
  })
})

describe('recovering tool output', () => {
  const paint = makePainter(false)
  const messages: ChatMessage[] = [
    { role: 'user', content: 'go' },
    { role: 'tool', content: 'first result', toolName: 'read_file', toolCallId: 'c1' },
    { role: 'assistant', content: 'thinking' },
    { role: 'tool', content: 'second result', toolName: 'run_shell', toolCallId: 'c2' }
  ]

  it('reads results back out of the persisted log, oldest first', () => {
    expect(toolResultsFrom(messages)).toEqual([
      { name: 'read_file', output: 'first result' },
      { name: 'run_shell', output: 'second result' }
    ])
  })

  it('defaults to the most recent — "what just happened"', () => {
    const out = renderRecoveredOutput(toolResultsFrom(messages), 1, paint)
    expect(out).toContain('run_shell')
    expect(out).toContain('second result')
  })

  it('counts back from the most recent', () => {
    const out = renderRecoveredOutput(toolResultsFrom(messages), 2, paint)
    expect(out).toContain('read_file')
    expect(out).toContain('first result')
  })

  it('says so when there is nothing to show, or the index is out of range', () => {
    expect(renderRecoveredOutput([], 1, paint)).toContain('no tool output')
    expect(renderRecoveredOutput(toolResultsFrom(messages), 9, paint)).toContain('no tool call #9')
  })

  it('caps a gigantic result', () => {
    const huge = [{ name: 'run_shell', output: Array.from({ length: 900 }, (_, i) => `l${i}`).join('\n') }]
    const out = renderRecoveredOutput(huge, 1, paint)
    expect(out).toContain('l0')
    expect(out).not.toContain('l899')
    expect(out).toContain(`${900 - OUTPUT_LINES} more lines not shown`)
  })
})

describe('formatSessionCost', () => {
  it('formats tokens with grouping and cost to 4 dp', () => {
    expect(formatSessionCost({ inputTokens: 1234, outputTokens: 567, cost: 0.0123 })).toBe(
      '1,234+567 tok · $0.0123'
    )
  })
})

describe('formatRelativeTime', () => {
  const now = 10_000_000_000
  it('buckets by magnitude', () => {
    expect(formatRelativeTime(now - 10_000, now)).toBe('just now')
    expect(formatRelativeTime(now - 5 * 60_000, now)).toBe('5m ago')
    expect(formatRelativeTime(now - 3 * 3_600_000, now)).toBe('3h ago')
    expect(formatRelativeTime(now - 2 * 86_400_000, now)).toBe('2d ago')
  })
  it('never goes negative', () => {
    expect(formatRelativeTime(now + 5000, now)).toBe('just now')
  })
})

describe('status line & progress', () => {
  const paint = makePainter(false)

  it('subagentGlyph maps status', () => {
    expect(subagentGlyph('running')).toBe('·')
    expect(subagentGlyph('done')).toBe('✓')
    expect(subagentGlyph('error')).toBe('✗')
  })

  it('shortCwd abbreviates home and deep paths', () => {
    expect(shortCwd('/Users/x/proj', '/Users/x')).toBe('~/proj')
    expect(shortCwd('/a/b/c/d/e', '/nope')).toBe('…/d/e')
    expect(shortCwd('/a/b', '/nope')).toBe('/a/b')
  })

  it('renders model, policy, cost, and a context bar', () => {
    const line = renderStatusLine(
      { providerId: 'anthropic', model: 'claude-opus-4-8', policy: 'ask', cwd: '/p', cost: { inputTokens: 0, outputTokens: 0, cost: 0.5 }, contextTokens: 500_000 },
      120,
      paint
    )
    expect(line).toContain('anthropic/claude-opus-4-8')
    expect(line).toContain('ask')
    expect(line).toContain('$0.5000')
    expect(line).toContain('50%') // 500k of a 1M window
    expect(line).toMatch(/[▓░]/)
  })

  it('omits the context bar until a turn has run', () => {
    const line = renderStatusLine(
      { providerId: 'p', model: 'claude-opus-4-8', policy: 'plan', cwd: '/p', cost: { inputTokens: 0, outputTokens: 0, cost: 0 }, contextTokens: 0 },
      120,
      paint
    )
    expect(line).not.toMatch(/%/)
  })

  it('truncates to the given width', () => {
    const line = renderStatusLine(
      { providerId: 'anthropic', model: 'claude-opus-4-8', policy: 'ask', cwd: '/very/long/path/here', cost: { inputTokens: 0, outputTokens: 0, cost: 0 }, contextTokens: 0 },
      20,
      paint
    )
    expect(line.length).toBeLessThanOrEqual(20)
  })

  it('spinnerFrame cycles frames and shows the label + elapsed seconds', () => {
    expect(spinnerFrame(0, 'Thinking', 4, paint)).toBe('⠋ Thinking 4s')
    expect(spinnerFrame(1, 'Thinking', 4, paint)).toContain('⠙')
    // wraps around the frame set
    expect(spinnerFrame(10, 'x', 0, paint)).toContain('⠋')
  })
})

describe('renderCapabilityList', () => {
  const paint = makePainter(false)
  it('renders a labelled list with details', () => {
    const out = renderCapabilityList('Skills', [{ name: 'pdf', detail: 'work with PDFs' }], paint)
    expect(out).toContain('Skills:')
    expect(out).toContain('pdf')
    expect(out).toContain('work with PDFs')
  })
  it('shows a "none" note when empty', () => {
    expect(renderCapabilityList('MCP servers', [], paint)).toContain('No mcp servers active')
  })
})

describe('mediaTypeForImagePath', () => {
  it('maps supported image extensions', () => {
    expect(mediaTypeForImagePath('a.png')).toBe('image/png')
    expect(mediaTypeForImagePath('a.JPG')).toBe('image/jpeg')
    expect(mediaTypeForImagePath('a.jpeg')).toBe('image/jpeg')
    expect(mediaTypeForImagePath('a.gif')).toBe('image/gif')
    expect(mediaTypeForImagePath('a.webp')).toBe('image/webp')
  })
  it('returns null for unsupported / extensionless', () => {
    expect(mediaTypeForImagePath('a.txt')).toBeNull()
    expect(mediaTypeForImagePath('noext')).toBeNull()
  })
})

describe('resume picker', () => {
  const convs: ResumeEntry[] = [
    { id: 'a', title: 'First', updatedAt: 1 },
    { id: 'b', title: 'Second', updatedAt: 2 }
  ]
  it('renders a numbered list, or an empty note', () => {
    const out = renderConversationList(convs, 100, makePainter(false))
    expect(out).toContain('1. First')
    expect(out).toContain('2. Second')
    expect(renderConversationList([], 100, makePainter(false))).toContain('No saved sessions')
  })
  it('maps a valid index to its id, else null', () => {
    expect(parseResumeSelection('2', convs)).toBe('b')
    expect(parseResumeSelection('0', convs)).toBeNull()
    expect(parseResumeSelection('9', convs)).toBeNull()
    expect(parseResumeSelection('cancel', convs)).toBeNull()
  })
})

// --- runTui integration (fully dependency-injected, no real terminal) --------

/** A scripted terminal: readLine drains `inputs` in order, null when exhausted. */
/** A fakeIo input marker meaning "the user pressed Ctrl-C at this read". */
const CTRLC = '\u0003'

function fakeIo(inputs: Array<string | null>) {
  const out: string[] = []
  const interrupts: Array<() => void> = []
  const reads: Array<{ prompt: string; discardPending: boolean }> = []
  const spinner: string[] = [] // 'start:label' | 'label:x' | 'stop'
  let clears = 0
  let idx = 0
  const io: TuiIo = {
    out: (s) => out.push(s),
    clearLine: () => clears++,
    readLine: async (prompt, opts) => {
      reads.push({ prompt, discardPending: Boolean(opts?.discardPending) })
      const next = idx < inputs.length ? inputs[idx++] : null
      // A Ctrl-C at this read fires the interrupt handler(s) and ends the read with
      // null, exactly as cancelRead would settle a pending prompt on a real Ctrl-C.
      if (next === CTRLC) {
        interrupts.forEach((h) => h())
        return null
      }
      return next
    },
    onInterrupt: (h) => interrupts.push(h),
    cancelRead: () => {},
    startSpinner: (l) => spinner.push(`start:${l}`),
    setSpinnerLabel: (l) => spinner.push(`label:${l}`),
    stopSpinner: () => spinner.push('stop')
  }
  return {
    io,
    out,
    reads,
    spinner,
    clears: () => clears,
    text: () => out.join(''),
    fireInterrupt: () => interrupts.forEach((h) => h())
  }
}

interface Recorder {
  runs: Array<{ providerId: string; model: string; policy: string; messages: ChatMessage[] }>
  approvals: Array<[string, string, string]>
  questions: Array<[string, string, string]>
  plans: Array<[string, string, PlanDecision]>
  elicitations: Array<[string, string, ElicitationResult]>
  cancels: string[]
  accepted: () => number
}

/** Build deps whose startRun emits a scripted event list, recording everything. */
function deps(
  events: AgentEvent[],
  over: Partial<AppSettings> = {},
  onMessagesEcho?: (req: { messages: ChatMessage[] }) => ChatMessage[]
): { d: TuiDeps; rec: Recorder } {
  const runs: Recorder['runs'] = []
  const approvals: Recorder['approvals'] = []
  const questions: Recorder['questions'] = []
  const plans: Recorder['plans'] = []
  const elicitations: Recorder['elicitations'] = []
  const cancels: string[] = []
  let accepted = 0
  const d: TuiDeps = {
    getSettings: () =>
      settings({ selected: { providerId: 'anthropic', model: 'claude' }, legalAcceptedVersion: LEGAL_VERSION, ...over }),
    recordLegalAcceptance: () => {
      accepted++
    },
    startRun: async (req, send, onMessages) => {
      runs.push({
        providerId: req.providerId,
        model: req.model,
        policy: req.approvalPolicy,
        messages: req.messages.map((m) => ({ ...m }))
      })
      for (const e of events) send({ ...e, runId: req.runId } as AgentEvent)
      onMessages?.(onMessagesEcho ? onMessagesEcho(req) : req.messages)
    },
    resolveApproval: (r, c, dec) => approvals.push([r, c, dec]),
    resolveQuestion: (r, c, ans) => questions.push([r, c, ans]),
    resolvePlan: (r, c, dec) => plans.push([r, c, dec]),
    resolveElicitation: (r, e, res) => elicitations.push([r, e, res]),
    cancelRun: (r) => cancels.push(r),
    io: undefined as unknown as TuiIo,
    newId: () => `run-${runs.length + 1}`
  }
  return { d, rec: { runs, approvals, questions, plans, elicitations, cancels, accepted: () => accepted } }
}

/** An in-memory conversation store standing in for conversations.ts. */
function fakePersist(
  seed: Array<ResumeEntry & { messages: ChatMessage[]; providerId?: string; model?: string }> = []
) {
  const store = new Map<
    string,
    {
      title: string
      updatedAt: number
      workspace: string
      messages: ChatMessage[]
      providerId?: string
      model?: string
    }
  >()
  for (const s of seed) {
    store.set(s.id, {
      title: s.title,
      updatedAt: s.updatedAt,
      workspace: '/proj',
      messages: s.messages,
      providerId: s.providerId,
      model: s.model
    })
  }
  // Every setModel call, so a test can assert the meta was (or wasn't) rewritten.
  const setModelCalls: Array<{ id: string; providerId: string; model: string }> = []
  let seq = 0
  const persist: TuiPersist = {
    create: ({ workspace, providerId, model }) => {
      const id = `conv-${++seq}`
      store.set(id, { title: 'New chat', updatedAt: 0, workspace, messages: [], providerId, model })
      return { id }
    },
    setMessages: (id, messages) => {
      const c = store.get(id)
      if (c) c.messages = messages
    },
    setModel: (id, providerId, model) => {
      setModelCalls.push({ id, providerId, model })
      const c = store.get(id)
      if (c) {
        c.providerId = providerId
        c.model = model
      }
    },
    list: (workspace) =>
      [...store.entries()]
        .filter(([, c]) => c.workspace === workspace)
        .map(([id, c]) => ({ id, title: c.title, updatedAt: c.updatedAt })),
    search: (workspace, query) =>
      [...store.entries()]
        .filter(([, c]) => c.workspace === workspace && c.title.toLowerCase().includes(query.toLowerCase()))
        .map(([id, c]) => ({ id, title: c.title, updatedAt: c.updatedAt })),
    fork: (id) => {
      const c = store.get(id)
      if (!c) return null
      const fid = `conv-${++seq}`
      store.set(fid, { ...c, title: `${c.title} (fork)`, messages: [...c.messages] })
      return { id: fid }
    },
    get: (id) => {
      const c = store.get(id)
      return c ? { messages: c.messages } : null
    }
  }
  return { persist, store, setModelCalls }
}

const opts = {
  cwd: '/proj',
  approvalPolicy: 'ask' as const,
  acceptTerms: false,
  color: false
}

describe('runTui', () => {
  it('runs one turn, streaming assistant text, then exits on EOF', async () => {
    const { d, rec } = deps([
      { runId: 'x', type: 'text', delta: 'Hello there' },
      { runId: 'x', type: 'done', stopReason: 'end_turn' }
    ])
    const t = fakeIo(['fix the bug', null])
    d.io = t.io
    const code = await runTui(opts, d)
    expect(code).toBe(0)
    expect(rec.runs).toHaveLength(1)
    expect(rec.runs[0].messages).toEqual([{ role: 'user', content: 'fix the bug' }])
    expect(t.text()).toContain('Hello there')
    expect(t.text()).toContain('Bye.')
  })

  it('prints one end-of-turn cost summary, not a line per model round', async () => {
    const { d } = deps([
      { runId: 'x', type: 'text', delta: 'working' },
      { runId: 'x', type: 'usage', inputTokens: 30000, outputTokens: 100, cost: 0.16 },
      { runId: 'x', type: 'usage', inputTokens: 40000, outputTokens: 200, cost: 0.21 },
      { runId: 'x', type: 'done', stopReason: 'end_turn' }
    ])
    const t = fakeIo(['do it', null])
    d.io = t.io
    await runTui(opts, d)
    const out = t.text()
    // One combined summary for the whole turn (30k+40k in, 100+200 out, $0.37),
    // carrying the running session total (same, as it's the only turn).
    expect(out).toContain('· turn 70,000+300 tok · $0.3700')
    expect(out).toContain('(session 70,000+300 tok · $0.3700)')
    // The old per-round lines (raw, unseparated counts) are gone.
    expect(out).not.toContain('30000+100')
    expect(out).not.toContain('40000+200')
  })

  it('assembles a multi-line message (backslash continuation) into one turn', async () => {
    const { d, rec } = deps([{ runId: 'x', type: 'done', stopReason: 'end_turn' }])
    const t = fakeIo(['first line \\', 'second line', null])
    d.io = t.io
    await runTui(opts, d)
    expect(rec.runs).toHaveLength(1)
    expect(rec.runs[0].messages).toEqual([{ role: 'user', content: 'first line \nsecond line' }])
  })

  it('hints how to close an open code fence, and the close submits', async () => {
    const { d, rec } = deps([{ runId: 'x', type: 'done', stopReason: 'end_turn' }])
    const t = fakeIo(['```ts', 'const x = 1', '```', null])
    d.io = t.io
    await runTui(opts, d)
    // While the fence is open the continuation prompt guides the user out.
    expect(t.reads.some((r) => r.prompt.includes('to close and send'))).toBe(true)
    // Typing the closing fence submits the whole block as one turn.
    expect(rec.runs).toHaveLength(1)
    expect(rec.runs[0].messages).toEqual([{ role: 'user', content: '```ts\nconst x = 1\n```' }])
  })

  it('an options-less ask_user falls back to a typed answer (no picker crash)', async () => {
    const { d, rec } = deps([
      { runId: 'x', type: 'tool_question', callId: 'q1', question: 'Name it?', options: [] },
      { runId: 'x', type: 'done', stopReason: 'end_turn' }
    ])
    // io.select is present; the driver must skip it for an empty option list.
    const t = fakeIo(['go', 'my answer', null])
    t.io.select = async () => {
      throw new Error('picker must not be used for an options-less question')
    }
    d.io = t.io
    await runTui(opts, d)
    expect(rec.questions).toEqual([['run-1', 'q1', 'my answer']])
  })

  it('prompts for and records an approval decision', async () => {
    const { d, rec } = deps([
      { runId: 'x', type: 'tool_approval', callId: 'c1', name: 'run_shell', summary: 'ls', kind: 'shell' },
      { runId: 'x', type: 'done', stopReason: 'end_turn' }
    ])
    // inputs: user line, then the approval answer, then EOF
    const t = fakeIo(['run ls', 'y', null])
    d.io = t.io
    await runTui(opts, d)
    expect(rec.approvals).toEqual([['run-1', 'c1', 'allow']])
    // The approval read discards type-ahead; the composer read does not.
    expect(t.reads.find((r) => r.prompt === '> ')?.discardPending).toBe(true)
    expect(t.reads.find((r) => r.prompt !== '> ')?.discardPending).toBe(false)
  })

  it('uses the arrow-key picker for an approval when available', async () => {
    const { d, rec } = deps([
      { runId: 'x', type: 'tool_approval', callId: 'c1', name: 'run_shell', summary: 'ls', kind: 'shell' },
      { runId: 'x', type: 'done', stopReason: 'end_turn' }
    ])
    const t = fakeIo(['run ls', null]) // no typed approval answer needed
    t.io.select = async () => ({ kind: 'commit', value: 'always' })
    d.io = t.io
    await runTui(opts, d)
    expect(rec.approvals).toEqual([['run-1', 'c1', 'always']])
  })

  it('falls back to typing when the picker returns type', async () => {
    const { d, rec } = deps([
      { runId: 'x', type: 'tool_approval', callId: 'c1', name: 'run_shell', summary: 'ls', kind: 'shell' },
      { runId: 'x', type: 'done', stopReason: 'end_turn' }
    ])
    const t = fakeIo(['run ls', 'n', null]) // typed answer used after picker declines
    t.io.select = async () => ({ kind: 'type' })
    d.io = t.io
    await runTui(opts, d)
    expect(rec.approvals).toEqual([['run-1', 'c1', 'deny']])
  })

  it('picker cancel denies an approval (safe default)', async () => {
    const { d, rec } = deps([
      { runId: 'x', type: 'tool_approval', callId: 'c1', name: 'run_shell', summary: 'ls', kind: 'shell' },
      { runId: 'x', type: 'done', stopReason: 'end_turn' }
    ])
    const t = fakeIo(['run ls', null])
    t.io.select = async () => ({ kind: 'cancel' })
    d.io = t.io
    await runTui(opts, d)
    expect(rec.approvals).toEqual([['run-1', 'c1', 'deny']])
  })

  it('uses the picker for an ask_user question', async () => {
    const { d, rec } = deps([
      { runId: 'x', type: 'tool_question', callId: 'q1', question: 'Which?', options: [{ label: 'Alpha' }, { label: 'Beta' }] },
      { runId: 'x', type: 'done', stopReason: 'end_turn' }
    ])
    const t = fakeIo(['choose', null])
    t.io.select = async () => ({ kind: 'commit', value: 'Beta' })
    d.io = t.io
    await runTui(opts, d)
    expect(rec.questions).toEqual([['run-1', 'q1', 'Beta']])
  })

  it('prompts for and resolves an ask_user question by option number', async () => {
    const { d, rec } = deps([
      {
        runId: 'x',
        type: 'tool_question',
        callId: 'q1',
        question: 'Which?',
        options: [{ label: 'Alpha' }, { label: 'Beta' }]
      },
      { runId: 'x', type: 'done', stopReason: 'end_turn' }
    ])
    const t = fakeIo(['choose', '2', null])
    d.io = t.io
    await runTui(opts, d)
    expect(rec.questions).toEqual([['run-1', 'q1', 'Beta']])
  })

  it('/exit ends the session', async () => {
    const { d, rec } = deps([{ runId: 'x', type: 'done', stopReason: 'end_turn' }])
    const t = fakeIo(['/exit', 'should not run'])
    d.io = t.io
    const code = await runTui(opts, d)
    expect(code).toBe(0)
    expect(rec.runs).toHaveLength(0)
  })

  it('/clear resets conversation context', async () => {
    // Echo back an accumulating message list so we can see it grow, then clear.
    const { d, rec } = deps(
      [{ runId: 'x', type: 'done', stopReason: 'end_turn' }],
      {},
      (req) => [...req.messages, { role: 'assistant', content: 'ok' }]
    )
    const t = fakeIo(['first', '/clear', 'second', null])
    d.io = t.io
    await runTui(opts, d)
    expect(rec.runs).toHaveLength(2)
    // Second turn starts fresh: only the new user message, not the prior exchange.
    expect(rec.runs[1].messages).toEqual([{ role: 'user', content: 'second' }])
  })

  it('carries conversation context across turns', async () => {
    const { d, rec } = deps(
      [{ runId: 'x', type: 'done', stopReason: 'end_turn' }],
      {},
      (req) => [...req.messages, { role: 'assistant', content: 'reply' }]
    )
    const t = fakeIo(['one', 'two', null])
    d.io = t.io
    await runTui(opts, d)
    // Second turn includes the first exchange plus the new message.
    expect(rec.runs[1].messages).toEqual([
      { role: 'user', content: 'one' },
      { role: 'assistant', content: 'reply' },
      { role: 'user', content: 'two' }
    ])
  })

  it('/approval switches the policy used by the next run', async () => {
    const { d, rec } = deps([{ runId: 'x', type: 'done', stopReason: 'end_turn' }])
    const t = fakeIo(['/approval full-auto', 'go', null])
    d.io = t.io
    await runTui(opts, d)
    expect(rec.runs[0].policy).toBe('full-auto')
  })

  it('/model switches the provider + model used by the next run', async () => {
    const { d, rec } = deps([{ runId: 'x', type: 'done', stopReason: 'end_turn' }])
    const t = fakeIo(['/model ollama', 'go', null])
    d.io = t.io
    await runTui(opts, d)
    expect(rec.runs[0]).toMatchObject({ providerId: 'ollama', model: 'llama' })
  })

  it('gives feedback on an unresolvable /model, /approval, or /theme arg', async () => {
    const { d, rec } = deps([])
    const t = fakeIo(['/model nope-9', '/approval fullautoo', '/theme bright-nope', null])
    d.io = t.io
    await runTui(opts, d)
    const out = t.text()
    expect(out).toContain('unknown model: nope-9')
    expect(out).toContain('unknown policy: fullautoo')
    expect(out).toContain('unknown theme: bright-nope')
    expect(rec.runs).toHaveLength(0) // none of them started a turn
  })

  it('/model persists the switch as the saved selection (like the GUI picker)', async () => {
    const { d } = deps([{ runId: 'x', type: 'done', stopReason: 'end_turn' }])
    const saved: Array<Partial<AppSettings>> = []
    d.updateSettings = (p) => saved.push(p)
    const t = fakeIo(['/model ollama', null])
    d.io = t.io
    await runTui(opts, d)
    // Without this write the next launch resolves the startup model from the old
    // stored `selected` and the switch silently evaporates on restart.
    expect(saved).toEqual([{ selected: { providerId: 'ollama', model: 'llama' } }])
  })

  it('/model still switches in-memory when no settings writer is wired', async () => {
    const { d, rec } = deps([{ runId: 'x', type: 'done', stopReason: 'end_turn' }])
    // note: no updateSettings seam — the ephemeral-host case
    const t = fakeIo(['/model ollama', 'go', null])
    d.io = t.io
    await runTui(opts, d)
    expect(rec.runs[0]).toMatchObject({ providerId: 'ollama', model: 'llama' })
  })

  it('a /model switch rewrites the existing conversation’s stored provider/model', async () => {
    const { d } = deps([{ runId: 'x', type: 'done', stopReason: 'end_turn' }])
    const fp = fakePersist()
    d.persist = fp.persist
    // Turn 1 creates conv-1 under the session default (anthropic/claude); then a
    // /model switch, and turn 2 runs under ollama/llama in the SAME conversation.
    const t = fakeIo(['first', '/model ollama', 'second', null])
    d.io = t.io
    await runTui(opts, d)
    // The stored meta follows the model actually used, so the scorecard and a GUI
    // re-open don't attribute the chat to the model it was merely created under.
    expect(fp.store.get('conv-1')).toMatchObject({ providerId: 'ollama', model: 'llama' })
    // create() already stored turn 1's model, so setModel fires only once — for the switch.
    expect(fp.setModelCalls).toEqual([{ id: 'conv-1', providerId: 'ollama', model: 'llama' }])
  })

  it('leaves the stored model untouched when it never changes', async () => {
    const { d } = deps([{ runId: 'x', type: 'done', stopReason: 'end_turn' }])
    const fp = fakePersist()
    d.persist = fp.persist
    const t = fakeIo(['first', 'second', null])
    d.io = t.io
    await runTui(opts, d)
    // Two turns under the same model: create() covers it, so the setModel seam is
    // never touched (the guard skips the redundant, updatedAt-bumping write).
    expect(fp.setModelCalls).toEqual([])
    expect(fp.store.get('conv-1')).toMatchObject({ providerId: 'anthropic', model: 'claude' })
  })

  it('re-syncs the stored model on the first turn after /resume', async () => {
    const { d, rec } = deps([{ runId: 'x', type: 'done', stopReason: 'end_turn' }], {}, (req) => req.messages)
    // A saved chat created under a different model than this session's active one.
    const fp = fakePersist([
      { id: 'saved', title: 'Old', updatedAt: 5, messages: [], providerId: 'ollama', model: 'llama' }
    ])
    d.persist = fp.persist
    d.now = () => 1000
    const t = fakeIo(['/resume', '1', 'continue', null])
    d.io = t.io
    await runTui(opts, d)
    // The turn runs under the session's active model (resume doesn't switch it)...
    expect(rec.runs[0]).toMatchObject({ providerId: 'anthropic', model: 'claude' })
    // ...so the resumed chat's stored meta is rewritten to match, in place (no new conv).
    expect(fp.store.size).toBe(1)
    expect(fp.store.get('saved')).toMatchObject({ providerId: 'anthropic', model: 'claude' })
    expect(fp.setModelCalls).toEqual([{ id: 'saved', providerId: 'anthropic', model: 'claude' }])
  })

  it('preflights the key: submitting on a keyless provider skips the run and hints /login', async () => {
    const { d, rec } = deps([{ runId: 'x', type: 'done', stopReason: 'end_turn' }], {
      selected: { providerId: 'openai', model: 'gpt' },
      providers: [{ id: 'openai', requiresKey: true, hasKey: false, models: [{ id: 'gpt' }], defaultModel: 'gpt' }]
    } as Partial<AppSettings>)
    const t = fakeIo(['do something', null])
    d.io = t.io
    await runTui(opts, d)
    // No run started (no phantom turn that fails deep in the adapter), and the user
    // message isn't left dangling; an actionable /login hint is shown instead.
    expect(rec.runs).toHaveLength(0)
    expect(t.text()).toMatch(/no API key/i)
    expect(t.text()).toContain('/login')
  })

  it('survives a persistence failure instead of crashing the REPL', async () => {
    const { d, rec } = deps([{ runId: 'x', type: 'done', stopReason: 'end_turn' }])
    d.persist = {
      create: () => ({ id: 'c1' }),
      setMessages: () => {
        throw new Error('ENOSPC: no space left on device')
      },
      setModel: () => {
        throw new Error('ENOSPC: no space left on device')
      },
      list: () => [],
      search: () => [],
      get: () => null,
      fork: () => null
    }
    const t = fakeIo(['hello', 'again', null])
    d.io = t.io
    const code = await runTui(opts, d)
    expect(code).toBe(0) // clean exit, not a Fatal
    expect(rec.runs).toHaveLength(2) // both turns ran despite the store throwing
    expect(t.text()).toMatch(/couldn't save the conversation/i)
  })

  it('survives a setModel failure on a /model switch instead of crashing the REPL', async () => {
    const { d, rec } = deps([{ runId: 'x', type: 'done', stopReason: 'end_turn' }])
    // create + setMessages succeed; only the meta rewrite (triggered by the switch) throws.
    d.persist = {
      create: () => ({ id: 'c1' }),
      setMessages: () => {},
      setModel: () => {
        throw new Error('EROFS: read-only file system')
      },
      list: () => [],
      search: () => [],
      get: () => null,
      fork: () => null
    }
    const t = fakeIo(['first', '/model ollama', 'second', null])
    d.io = t.io
    const code = await runTui(opts, d)
    expect(code).toBe(0) // the throwing seam is caught, not fatal
    expect(rec.runs).toHaveLength(2) // the post-switch turn still ran
    expect(rec.runs[1]).toMatchObject({ providerId: 'ollama', model: 'llama' })
    expect(t.text()).toMatch(/couldn't save the conversation/i)
  })

  it('reports an unknown slash command without starting a run', async () => {
    const { d, rec } = deps([{ runId: 'x', type: 'done', stopReason: 'end_turn' }])
    const t = fakeIo(['/nope', null])
    d.io = t.io
    await runTui(opts, d)
    expect(rec.runs).toHaveLength(0)
    expect(t.text()).toContain('Unknown command')
  })

  it('an interrupt cancels the active run', async () => {
    // startRun fires the interrupt mid-run, before emitting done.
    const runs: string[] = []
    const { d, rec } = deps([{ runId: 'x', type: 'done', stopReason: 'aborted' }])
    const t = fakeIo(['long task', null])
    d.io = t.io
    const origStart = d.startRun
    d.startRun = async (req, send, onMessages) => {
      t.fireInterrupt() // user hits Ctrl-C
      return origStart(req, send, onMessages)
    }
    await runTui(opts, d)
    expect(rec.cancels).toEqual([`run-1`])
    // The interrupt is acknowledged visibly rather than stopping silently.
    expect(t.text()).toContain('^C interrupted')
    void runs
  })

  it('Ctrl-C at the composer discards the input, hints, and keeps the session', async () => {
    const { d, rec } = deps([])
    // Ctrl-C at the composer, then a real message, then Ctrl-D.
    const t = fakeIo([CTRLC, 'a real message', null])
    d.io = t.io
    await runTui(opts, d)
    expect(t.text()).toContain('Ctrl-C again or Ctrl-D to exit') // hint on first Ctrl-C
    expect(t.clears()).toBeGreaterThanOrEqual(1) // abandoned input line was erased
    // The session survived the Ctrl-C — the later message still ran, nothing extra.
    expect(rec.runs).toHaveLength(1)
    expect(rec.runs[0].messages).toEqual([{ role: 'user', content: 'a real message' }])
  })

  it('a second Ctrl-C at the composer exits the session', async () => {
    const { d, rec } = deps([])
    const t = fakeIo([CTRLC, CTRLC])
    d.io = t.io
    const code = await runTui(opts, d)
    expect(code).toBe(0)
    expect(rec.runs).toHaveLength(0) // nothing was ever submitted
    expect(t.text()).toContain('Bye')
  })

  it('Ctrl-C at a sub-prompt (/resume) cancels it without leaking the composer reset flag', async () => {
    const { persist } = fakePersist([{ id: 'c1', title: 'Old chat', updatedAt: 0, messages: [] }])
    const { d, rec } = deps([])
    d.persist = persist
    // /resume lists sessions → Ctrl-C at the selection prompt cancels resume; the
    // following Ctrl-D at the composer must then EXIT, not be swallowed as a leaked
    // 'reset' (the pre-fix bug). The composer hint must never fire for a sub-prompt.
    const t = fakeIo(['/resume', CTRLC, null])
    d.io = t.io
    const code = await runTui(opts, d)
    expect(code).toBe(0)
    expect(rec.runs).toHaveLength(0)
    expect(t.text()).not.toContain('Ctrl-C again or Ctrl-D to exit') // no composer-reset semantics
    expect(t.text()).toContain('Bye') // the later Ctrl-D exited cleanly
  })

  it('blocks and exits 2 when terms are declined interactively', async () => {
    const { d, rec } = deps([{ runId: 'x', type: 'done', stopReason: 'end_turn' }], {
      legalAcceptedVersion: 0
    })
    const t = fakeIo(['n']) // decline the terms prompt
    d.io = t.io
    const code = await runTui(opts, d)
    expect(code).toBe(2)
    expect(rec.accepted()).toBe(0)
    expect(rec.runs).toHaveLength(0)
  })

  it('records acceptance and proceeds when terms are accepted interactively', async () => {
    const { d, rec } = deps([{ runId: 'x', type: 'done', stopReason: 'end_turn' }], {
      legalAcceptedVersion: 0
    })
    const t = fakeIo(['y', 'hello', null]) // accept, then one turn
    d.io = t.io
    const code = await runTui(opts, d)
    expect(code).toBe(0)
    expect(rec.accepted()).toBe(1)
    expect(rec.runs).toHaveLength(1)
  })

  it('errors when no model can be resolved', async () => {
    const { d } = deps([], { providers: [], selected: null })
    const t = fakeIo([null])
    d.io = t.io
    const code = await runTui(opts, d)
    expect(code).toBe(1)
    expect(t.text()).toContain('No model configured')
  })

  it('previews the diff of a write from the approval event args (real event order)', async () => {
    // The loop emits tool_approval (carrying args) and blocks; tool_start comes only
    // AFTER the decision. So the diff must come from e.args, not a prior tool_start —
    // otherwise the user approves the edit blind.
    const { d } = deps([
      {
        runId: 'x',
        type: 'tool_approval',
        callId: 'c1',
        name: 'edit_file',
        summary: 'edit a.ts',
        kind: 'write',
        args: { path: 'a.ts', old_string: 'foo', new_string: 'bar' }
      },
      { runId: 'x', type: 'done', stopReason: 'end_turn' }
    ])
    const t = fakeIo(['edit it', 'y', null])
    d.io = t.io
    await runTui(opts, d)
    const out = t.text()
    expect(out).toContain('-foo')
    expect(out).toContain('+bar')
  })

  it('falls back to tool_start args for the diff when the approval event omits them', async () => {
    // Defensive path: an event without args still shows a diff if tool_start was seen.
    const { d } = deps([
      {
        runId: 'x',
        type: 'tool_start',
        callId: 'c1',
        name: 'edit_file',
        args: { path: 'a.ts', old_string: 'foo', new_string: 'bar' }
      },
      { runId: 'x', type: 'tool_approval', callId: 'c1', name: 'edit_file', summary: 'edit a.ts', kind: 'write' },
      { runId: 'x', type: 'done', stopReason: 'end_turn' }
    ])
    const t = fakeIo(['edit it', 'y', null])
    d.io = t.io
    await runTui(opts, d)
    expect(t.text()).toContain('-foo')
    expect(t.text()).toContain('+bar')
  })

  it('accumulates session cost across turns and prints it on /cost', async () => {
    const { d } = deps([
      { runId: 'x', type: 'usage', inputTokens: 100, outputTokens: 50, cost: 0.01 },
      { runId: 'x', type: 'done', stopReason: 'end_turn' }
    ])
    const t = fakeIo(['one', 'two', '/cost', null])
    d.io = t.io
    await runTui(opts, d)
    // Two turns each report 100+50 / $0.01 → session total 200+100 / $0.02.
    // The breakdown replaced the single "session:" line; the totals are the point.
    expect(t.text()).toContain('200+100 tok')
    expect(t.text()).toContain('$0.0200')
  })

  it('persists the session as a conversation on the first turn', async () => {
    const { d } = deps([{ runId: 'x', type: 'done', stopReason: 'end_turn' }])
    const fp = fakePersist()
    d.persist = fp.persist
    const t = fakeIo(['hello', null])
    d.io = t.io
    await runTui(opts, d)
    expect(fp.store.size).toBe(1)
    expect([...fp.store.values()][0].messages).toEqual([{ role: 'user', content: 'hello' }])
  })

  it('/clear opens a fresh conversation on the next turn', async () => {
    const { d } = deps([{ runId: 'x', type: 'done', stopReason: 'end_turn' }])
    const fp = fakePersist()
    d.persist = fp.persist
    const t = fakeIo(['first', '/clear', 'second', null])
    d.io = t.io
    await runTui(opts, d)
    expect(fp.store.size).toBe(2) // two distinct persisted conversations
  })

  it('/resume loads a saved session and continues it', async () => {
    const { d, rec } = deps([{ runId: 'x', type: 'done', stopReason: 'end_turn' }], {}, (req) => req.messages)
    const fp = fakePersist([
      {
        id: 'saved',
        title: 'Old',
        updatedAt: 5,
        messages: [
          { role: 'user', content: 'earlier' },
          { role: 'assistant', content: 'reply' }
        ]
      }
    ])
    d.persist = fp.persist
    d.now = () => 1000
    const t = fakeIo(['/resume', '1', 'continue', null])
    d.io = t.io
    await runTui(opts, d)
    // The post-resume turn carries the loaded history plus the new message...
    expect(rec.runs[0].messages).toEqual([
      { role: 'user', content: 'earlier' },
      { role: 'assistant', content: 'reply' },
      { role: 'user', content: 'continue' }
    ])
    // ...in the SAME conversation — no new one is created.
    expect(fp.store.size).toBe(1)
  })

  it('/resume cancels on a non-numeric choice without loading', async () => {
    const { d, rec } = deps([{ runId: 'x', type: 'done', stopReason: 'end_turn' }])
    const fp = fakePersist([{ id: 'saved', title: 'Old', updatedAt: 5, messages: [] }])
    d.persist = fp.persist
    const t = fakeIo(['/resume', 'nah', null])
    d.io = t.io
    await runTui(opts, d)
    expect(rec.runs).toHaveLength(0)
    expect(t.text()).toContain('cancelled')
  })

  it('/resume <query> searches by title', async () => {
    const { d } = deps([{ runId: 'x', type: 'done', stopReason: 'end_turn' }])
    const fp = fakePersist([
      { id: 'a', title: 'Auth refactor', updatedAt: 2, messages: [] },
      { id: 'b', title: 'CSS tweaks', updatedAt: 1, messages: [] }
    ])
    d.persist = fp.persist
    d.now = () => 100
    const t = fakeIo(['/resume auth', 'x', null]) // list is filtered, then cancel
    d.io = t.io
    await runTui(opts, d)
    const out = t.text()
    expect(out).toContain('Auth refactor')
    expect(out).not.toContain('CSS tweaks')
  })

  it('/fork branches the current conversation onto a copy', async () => {
    const { d } = deps([{ runId: 'x', type: 'done', stopReason: 'end_turn' }])
    const fp = fakePersist()
    d.persist = fp.persist
    // First a turn creates conv-1, then /fork copies it to conv-2.
    const t = fakeIo(['start', '/fork', null])
    d.io = t.io
    await runTui(opts, d)
    expect(fp.store.size).toBe(2)
    expect([...fp.store.values()].some((c) => c.title.endsWith('(fork)'))).toBe(true)
  })

  it('/skills and /agents render the capability snapshot', async () => {
    const { d } = deps([{ runId: 'x', type: 'done', stopReason: 'end_turn' }])
    d.capabilities = async () => ({
      skills: [{ name: 'pdf', detail: 'PDFs' }],
      agents: [],
      mcp: [],
      hooks: []
    })
    const t = fakeIo(['/skills', '/agents', null])
    d.io = t.io
    await runTui(opts, d)
    const out = t.text()
    expect(out).toContain('pdf')
    expect(out).toContain('No agents active') // empty list
  })

  it('/image stages an attachment that rides on the next turn', async () => {
    const { d, rec } = deps([{ runId: 'x', type: 'done', stopReason: 'end_turn' }])
    d.loadImage = (p) => ({ image: { mediaType: 'image/png', data: `b64:${p}` } })
    const t = fakeIo(['/image shot.png', 'what is this?', null])
    d.io = t.io
    await runTui(opts, d)
    const msg = rec.runs[0].messages.at(-1)!
    expect(msg.content).toBe('what is this?')
    expect(msg.images).toEqual([{ mediaType: 'image/png', data: 'b64:shot.png' }])
  })

  it('/image surfaces a load error and stages nothing', async () => {
    const { d, rec } = deps([{ runId: 'x', type: 'done', stopReason: 'end_turn' }])
    d.loadImage = () => ({ error: 'unsupported image type' })
    const t = fakeIo(['/image bad.txt', 'go', null])
    d.io = t.io
    await runTui(opts, d)
    expect(t.text()).toContain('unsupported image type')
    expect(rec.runs[0].messages.at(-1)!.images).toBeUndefined()
  })

  it('bare /image pastes, and still names the file form when it cannot', async () => {
    const { d } = deps([{ runId: 'x', type: 'done', stopReason: 'end_turn' }])
    const t = fakeIo(['/image', null])
    d.io = t.io
    // No clipboardImage wired: it must not be a silent no-op, and must say what to
    // do instead — which is what the old usage line was for.
    await runTui(opts, d)
    expect(t.text()).toContain('/image <path>')
  })

  it('/clear drops a staged image so it does not ride into the fresh conversation', async () => {
    const { d, rec } = deps([{ runId: 'x', type: 'done', stopReason: 'end_turn' }])
    d.loadImage = (p) => ({ image: { mediaType: 'image/png', data: `b64:${p}` } })
    const t = fakeIo(['/image shot.png', '/clear', 'a fresh start', null])
    d.io = t.io
    await runTui(opts, d)
    expect(rec.runs).toHaveLength(1)
    expect(rec.runs[0].messages.at(-1)!.images).toBeUndefined() // staged image was dropped
  })

  it('reports capability info unavailable without a provider', async () => {
    const { d } = deps([{ runId: 'x', type: 'done', stopReason: 'end_turn' }])
    const t = fakeIo(['/skills', null])
    d.io = t.io
    await runTui(opts, d)
    expect(t.text()).toContain('capability info is unavailable')
  })

  it('plan mode: a plain assistant answer does not trigger a plan→execute handoff', async () => {
    // Regression: any assistant text delta used to be treated as a runnable "plan",
    // so a plain answer in plan mode spuriously offered to leave plan mode — and
    // accepting injected "Proceed with the plan…" with no plan to proceed on. The
    // handoff now flows only through present_plan (plan_ready), so a plain answer
    // must produce no prompt and keep plan mode.
    const { d, rec } = deps([
      { runId: 'x', type: 'text', delta: 'This function validates the auth token.' },
      { runId: 'x', type: 'done', stopReason: 'end_turn' }
    ])
    const t = fakeIo(['what does this function do?', 'y', null])
    d.io = t.io
    await runTui({ ...opts, approvalPolicy: 'plan' }, d)
    expect(t.text()).not.toContain('Plan ready')
    // The 'y' is an ordinary follow-up message, still under plan mode — not an
    // accepted handoff that flips to auto-edit and injects the proceed message.
    expect(rec.runs).toHaveLength(2)
    expect(rec.runs[1].policy).toBe('plan')
    expect(rec.runs[1].messages.at(-1)!.content).toBe('y')
    expect(
      rec.runs.some((r) => r.messages.at(-1)!.content === 'Proceed with the plan you just described.')
    ).toBe(false)
  })

  it('plan mode: a text-only turn stays in plan mode with no extra prompt', async () => {
    const { d, rec } = deps([
      { runId: 'x', type: 'text', delta: 'Here is what I found.' },
      { runId: 'x', type: 'done', stopReason: 'end_turn' }
    ])
    const t = fakeIo(['look around', null])
    d.io = t.io
    await runTui({ ...opts, approvalPolicy: 'plan' }, d)
    expect(rec.runs).toHaveLength(1)
    expect(rec.runs[0].policy).toBe('plan')
    expect(t.text()).not.toContain('Plan ready')
  })

  it('no plan prompt outside plan mode', async () => {
    const { d, rec } = deps([
      { runId: 'x', type: 'text', delta: 'answer' },
      { runId: 'x', type: 'done', stopReason: 'end_turn' }
    ])
    const t = fakeIo(['hi', null])
    d.io = t.io
    await runTui(opts, d) // default policy 'ask'
    expect(rec.runs).toHaveLength(1)
    expect(t.text()).not.toContain('Plan ready')
  })

  it('/theme switches the palette (with color on)', async () => {
    const { d } = deps([{ runId: 'x', type: 'done', stopReason: 'end_turn' }])
    const t = fakeIo(['/theme bright', null])
    d.io = t.io
    await runTui({ ...opts, color: true }, d)
    // `bright` is an alias, so it lands on (and reports) the theme's real name.
    expect(t.text()).toContain('theme → dark')
  })

  it('/theme with no arg lists the available themes', async () => {
    const { d } = deps([{ runId: 'x', type: 'done', stopReason: 'end_turn' }])
    const t = fakeIo(['/theme', null])
    d.io = t.io
    await runTui(opts, d)
    expect(t.text()).toContain('default, dark, light, colorblind, mono')
  })

  it('/fork with no active conversation is a no-op', async () => {
    const { d } = deps([{ runId: 'x', type: 'done', stopReason: 'end_turn' }])
    const fp = fakePersist()
    d.persist = fp.persist
    const t = fakeIo(['/fork', null])
    d.io = t.io
    await runTui(opts, d)
    expect(fp.store.size).toBe(0)
    expect(t.text()).toContain('nothing to fork')
  })

  it('reports resume as unavailable without a store', async () => {
    const { d } = deps([{ runId: 'x', type: 'done', stopReason: 'end_turn' }])
    const t = fakeIo(['/resume', null])
    d.io = t.io
    await runTui(opts, d)
    expect(t.text()).toContain('resume is unavailable')
  })

  it('prints a status line before the composer prompt', async () => {
    const { d } = deps([{ runId: 'x', type: 'done', stopReason: 'end_turn' }])
    d.now = () => 0
    const t = fakeIo([null]) // EOF immediately
    d.io = t.io
    await runTui(opts, d)
    // Model + policy appear before we ever read input.
    expect(t.text()).toContain('anthropic/claude')
    expect(t.text()).toContain('ask')
  })

  it('renders tool_progress, subagent, and retry events', async () => {
    const { d } = deps([
      { runId: 'x', type: 'retry', attempt: 2, max: 5, message: 'network hiccup' },
      { runId: 'x', type: 'tool_start', callId: 'c1', name: 'review_changes', args: {} },
      { runId: 'x', type: 'tool_progress', callId: 'c1', message: 'reviewing correctness' },
      { runId: 'x', type: 'subagent', parentCallId: 'c1', id: 's1', label: 'Correctness', status: 'running' },
      { runId: 'x', type: 'subagent', parentCallId: 'c1', id: 's1', label: 'Correctness', status: 'done' },
      { runId: 'x', type: 'done', stopReason: 'end_turn' }
    ])
    const t = fakeIo(['review', null])
    d.io = t.io
    await runTui(opts, d)
    const out = t.text()
    expect(out).toContain('retrying (2/5)')
    expect(out).toContain('reviewing correctness')
    expect(out).toContain('· Correctness')
    expect(out).toContain('✓ Correctness')
  })

  // Parity with the GUI transcript and headless stderr: a notice event (a hook's
  // user-facing systemMessage) must be shown, not silently dropped.
  it('renders a notice event (hook systemMessage)', async () => {
    const { d } = deps([
      { runId: 'x', type: 'notice', message: 'linted 3 files after the edit' },
      { runId: 'x', type: 'done', stopReason: 'end_turn' }
    ])
    const t = fakeIo(['go', null])
    d.io = t.io
    await runTui(opts, d)
    expect(t.text()).toContain('linted 3 files after the edit')
  })

  it('drives the spinner across a turn: start, relabel on events, stop', async () => {
    const { d } = deps([
      { runId: 'x', type: 'reasoning', delta: 'hmm' },
      { runId: 'x', type: 'tool_start', callId: 'c1', name: 'read_file', args: {} },
      { runId: 'x', type: 'done', stopReason: 'end_turn' }
    ])
    const t = fakeIo(['go', null])
    d.io = t.io
    await runTui(opts, d)
    expect(t.spinner).toEqual(['start:Working', 'label:Thinking', 'label:read_file', 'stop'])
  })

  it('persists composer submissions to history, not approval answers', async () => {
    const { d } = deps([
      { runId: 'x', type: 'tool_approval', callId: 'c1', name: 'run_shell', summary: 'ls', kind: 'shell' },
      { runId: 'x', type: 'done', stopReason: 'end_turn' }
    ])
    const saved: string[] = []
    d.persistHistory = (l) => saved.push(l)
    const t = fakeIo(['run ls', 'y', '/help', null])
    d.io = t.io
    await runTui(opts, d)
    // The composer lines are saved; the approval answer 'y' is not.
    expect(saved).toEqual(['run ls', '/help'])
  })

  it('stops the spinner when a run is interrupted', async () => {
    const { d } = deps([{ runId: 'x', type: 'done', stopReason: 'aborted' }])
    const t = fakeIo(['task', null])
    d.io = t.io
    const orig = d.startRun
    d.startRun = async (req, send, onMessages) => {
      t.fireInterrupt()
      return orig(req, send, onMessages)
    }
    await runTui(opts, d)
    expect(t.spinner).toContain('stop')
  })

  it('/plan switches to plan mode for the next run', async () => {
    // No assistant text ⇒ no plan-ready handoff prompt to answer.
    const { d, rec } = deps([{ runId: 'x', type: 'done', stopReason: 'end_turn' }])
    const t = fakeIo(['/plan', 'look around', null])
    d.io = t.io
    await runTui(opts, d)
    expect(rec.runs[0].policy).toBe('plan')
  })

  it('/review runs the first-party review template as a turn', async () => {
    const { d, rec } = deps([{ runId: 'x', type: 'done', stopReason: 'end_turn' }])
    const t = fakeIo(['/review', null])
    d.io = t.io
    await runTui(opts, d)
    expect(rec.runs).toHaveLength(1)
    expect(rec.runs[0].messages).toEqual([{ role: 'user', content: REVIEW_TEMPLATE }])
  })

  it('runs a custom .houston/commands command, expanding $ARGUMENTS', async () => {
    const { d, rec } = deps([{ runId: 'x', type: 'done', stopReason: 'end_turn' }])
    d.commands = async () => [{ name: 'ship', description: 'Ship', template: 'Release the $ARGUMENTS build' }]
    const t = fakeIo(['/ship canary', null])
    d.io = t.io
    await runTui(opts, d)
    expect(rec.runs[0].messages).toEqual([{ role: 'user', content: 'Release the canary build' }])
  })

  it('lists custom commands under /help', async () => {
    const { d } = deps([{ runId: 'x', type: 'done', stopReason: 'end_turn' }])
    d.commands = async () => [{ name: 'ship', description: 'Ship the release', template: 'go' }]
    const t = fakeIo(['/help', null])
    d.io = t.io
    await runTui(opts, d)
    expect(t.text()).toContain('Custom commands (.houston/commands)')
    expect(t.text()).toContain('/ship')
  })

  it('/compact summarizes earlier messages and adopts the compacted log', async () => {
    const compacted: ChatMessage[] = [
      { role: 'user', content: '[summary]' },
      { role: 'assistant', content: 'ok' }
    ]
    const { d, rec } = deps([{ runId: 'x', type: 'done', stopReason: 'end_turn' }])
    const fp = fakePersist()
    d.persist = fp.persist
    let compactCalls = 0
    d.compact = async (id) => {
      compactCalls++
      expect(id).toBe('conv-1') // the conversation opened on the first turn
      return { ok: true, summarized: 2, messages: compacted }
    }
    // turn 1 opens the conversation; /compact folds it; turn 2 must carry the compacted log.
    const t = fakeIo(['first', '/compact', 'again', null])
    d.io = t.io
    await runTui(opts, d)
    expect(compactCalls).toBe(1)
    expect(t.text()).toContain('compacted 2 earlier message(s)')
    // The post-compaction turn carries the summarized log plus the new message.
    // (Assert against literals: the driver appends to the adopted array in place,
    // mirroring the /resume path, so `compacted` itself is mutated by the push.)
    expect(rec.runs[1].messages).toEqual([
      { role: 'user', content: '[summary]' },
      { role: 'assistant', content: 'ok' },
      { role: 'user', content: 'again' }
    ])
  })

  it('/compact before any turn reports there is nothing to compact yet', async () => {
    const { d, rec } = deps([{ runId: 'x', type: 'done', stopReason: 'end_turn' }])
    let called = false
    d.compact = async () => {
      called = true
      return { ok: true, summarized: 0 }
    }
    const t = fakeIo(['/compact', null])
    d.io = t.io
    await runTui(opts, d)
    expect(called).toBe(false) // no conversation to compact
    expect(rec.runs).toHaveLength(0)
    expect(t.text()).toContain('nothing to compact yet')
  })

  it('/compact explains when a single big turn cannot be split', async () => {
    const { d } = deps([{ runId: 'x', type: 'done', stopReason: 'end_turn' }])
    const fp = fakePersist()
    d.persist = fp.persist
    d.compact = async () => ({ ok: true, summarized: 0, reason: 'single-turn' })
    const t = fakeIo(['one huge message', '/compact', null])
    d.io = t.io
    await runTui(opts, d)
    expect(t.text()).toContain('/new starts a fresh chat')
  })

  // ---- Settings surface: /settings, /hooks, /mcp ----

  it('/settings prints the file path, the desktop-panel note, and the restart note', async () => {
    const { d } = deps([{ runId: 'x', type: 'done', stopReason: 'end_turn' }])
    d.settingsPath = () => '/profile/settings.json'
    const t = fakeIo(['/settings', null])
    d.io = t.io
    await runTui(opts, d)
    const out = t.text()
    expect(out).toContain('/profile/settings.json')
    expect(out).toContain('desktop app has the full settings panel')
    expect(out).toContain('picked up on restart')
  })

  it('/hooks lists configured hooks with the settings path + restart note', async () => {
    const hook: Hook = { event: 'PostToolUse', matcher: 'edit_file', command: 'npm test' }
    const { d } = deps([{ runId: 'x', type: 'done', stopReason: 'end_turn' }], { hooks: [hook] })
    d.settingsPath = () => '/profile/settings.json'
    const t = fakeIo(['/hooks', null])
    d.io = t.io
    await runTui(opts, d)
    const out = t.text()
    expect(out).toContain('PostToolUse')
    expect(out).toContain('npm test')
    expect(out).toContain('/profile/settings.json')
    expect(out).toContain('picked up on restart')
  })

  it('/hooks add walks the fields, confirms, and persists the new hook', async () => {
    const { d } = deps([{ runId: 'x', type: 'done', stopReason: 'end_turn' }])
    const saved: Array<Partial<AppSettings>> = []
    d.updateSettings = (p) => saved.push(p)
    d.settingsPath = () => '/p/s.json'
    // command line, then: event (by number), matcher, command, confirm, EOF
    const t = fakeIo(['/hooks add', '2', 'edit_file', 'npm run typecheck', 'y', null])
    d.io = t.io
    await runTui(opts, d)
    expect(saved).toEqual([
      { hooks: [{ event: 'PostToolUse', matcher: 'edit_file', command: 'npm run typecheck' }] }
    ])
    expect(t.text()).toContain('hook added')
  })

  it('/hooks add rejects an unknown event without persisting', async () => {
    const { d } = deps([{ runId: 'x', type: 'done', stopReason: 'end_turn' }])
    const saved: Array<Partial<AppSettings>> = []
    d.updateSettings = (p) => saved.push(p)
    d.settingsPath = () => '/p/s.json'
    const t = fakeIo(['/hooks add', 'Bogus', '*', 'echo hi', null])
    d.io = t.io
    await runTui(opts, d)
    expect(saved).toEqual([])
    expect(t.text()).toContain('unknown event')
  })

  it('/hooks remove deletes the numbered hook', async () => {
    const h1: Hook = { event: 'PreToolUse', matcher: 'run_shell', command: 'a' }
    const h2: Hook = { event: 'Stop', matcher: '*', command: 'b' }
    const { d } = deps([{ runId: 'x', type: 'done', stopReason: 'end_turn' }], { hooks: [h1, h2] })
    const saved: Array<Partial<AppSettings>> = []
    d.updateSettings = (p) => saved.push(p)
    d.settingsPath = () => '/p/s.json'
    const t = fakeIo(['/hooks remove 1', null])
    d.io = t.io
    await runTui(opts, d)
    expect(saved).toEqual([{ hooks: [h2] }])
    expect(t.text()).toContain('removed hook 1')
  })

  it('/hooks remove out of range is reported, not persisted', async () => {
    const { d } = deps([{ runId: 'x', type: 'done', stopReason: 'end_turn' }], { hooks: [] })
    const saved: Array<Partial<AppSettings>> = []
    d.updateSettings = (p) => saved.push(p)
    d.settingsPath = () => '/p/s.json'
    const t = fakeIo(['/hooks remove 5', null])
    d.io = t.io
    await runTui(opts, d)
    expect(saved).toEqual([])
    expect(t.text()).toContain('no hook #5')
  })

  it('/hooks add is unavailable when no settings writer is wired', async () => {
    const { d } = deps([{ runId: 'x', type: 'done', stopReason: 'end_turn' }])
    d.settingsPath = () => '/p/s.json' // note: no updateSettings
    const t = fakeIo(['/hooks add', null])
    d.io = t.io
    await runTui(opts, d)
    expect(t.text()).toContain('unavailable')
  })

  it('/mcp add creates a header-free stdio server (never a URL or auth header)', async () => {
    const { d } = deps([{ runId: 'x', type: 'done', stopReason: 'end_turn' }])
    const saved: Array<Partial<AppSettings>> = []
    d.updateSettings = (p) => saved.push(p)
    d.settingsPath = () => '/p/s.json'
    // command line, then: name, command, args, cwd, env, confirm, EOF
    const t = fakeIo(['/mcp add', 'files', 'npx', '-y @scope/fs .', '', '', 'y', null])
    d.io = t.io
    await runTui(opts, d)
    expect(saved).toHaveLength(1)
    const server = saved[0].mcpServers![0]
    expect(server).toEqual({
      id: 'files',
      name: 'files',
      transport: 'stdio',
      command: 'npx',
      args: ['-y', '@scope/fs', '.'],
      enabled: true
    })
    expect(server).not.toHaveProperty('url')
    expect(server).not.toHaveProperty('headers')
    expect(t.text()).toContain('MCP server added')
  })

  it('/mcp add accepts a working directory and env pairs (values become secrets)', async () => {
    const { d } = deps([{ runId: 'x', type: 'done', stopReason: 'end_turn' }])
    const saved: Array<Partial<AppSettings>> = []
    d.updateSettings = (p) => saved.push(p)
    d.settingsPath = () => '/p/s.json'
    d.canStoreHeaderSecrets = false // the standalone CLI case: values need cli-headers.json
    const t = fakeIo(['/mcp add', 'gh', 'npx', '-y @scope/gh', '/srv/dir', 'GH_TOKEN=tok123', 'y', null])
    d.io = t.io
    await runTui(opts, d)
    expect(saved[0].mcpServers![0]).toMatchObject({
      id: 'gh',
      cwd: '/srv/dir',
      env: { GH_TOKEN: 'tok123' }
    })
    // On a host that can't persist secret values, the flow says where they go.
    expect(t.text()).toContain('mcp-env:gh')
  })

  it('/mcp login runs the OAuth flow for a remote server and reports success', async () => {
    const remote: McpServerConfig = {
      id: 'linear',
      name: 'linear',
      transport: 'http',
      command: '',
      url: 'https://mcp.example.com/mcp',
      enabled: true
    }
    const { d } = deps([{ runId: 'x', type: 'done', stopReason: 'end_turn' }], {
      mcpServers: [remote]
    })
    const logins: string[] = []
    d.mcpOAuth = {
      login: async (server, onStatus) => {
        logins.push(server.id)
        onStatus('Opening the browser')
      },
      logout: () => {}
    }
    const t = fakeIo(['/mcp login 1', null])
    d.io = t.io
    await runTui(opts, d)
    expect(logins).toEqual(['linear'])
    expect(t.text()).toContain('Opening the browser')
    expect(t.text()).toContain('signed in to "linear"')
  })

  it('/mcp login refuses a stdio server and surfaces flow failures', async () => {
    const { d } = deps([{ runId: 'x', type: 'done', stopReason: 'end_turn' }], {
      mcpServers: [
        { id: 'local', name: 'local', command: 'npx', enabled: true },
        { id: 'web', name: 'web', transport: 'http', command: '', url: 'https://x/mcp', enabled: true }
      ]
    })
    d.mcpOAuth = {
      login: async () => {
        throw new Error('registration rejected')
      },
      logout: () => {}
    }
    const t = fakeIo(['/mcp login 1', '/mcp login 2', null])
    d.io = t.io
    await runTui(opts, d)
    expect(t.text()).toContain('local stdio server')
    expect(t.text()).toContain('sign-in failed: registration rejected')
  })

  it('/mcp logout forgets stored tokens for a signed-in server', async () => {
    const { d } = deps([{ runId: 'x', type: 'done', stopReason: 'end_turn' }], {
      mcpServers: [
        {
          id: 'linear',
          name: 'linear',
          transport: 'http',
          command: '',
          url: 'https://x/mcp',
          hasOAuth: true,
          enabled: true
        }
      ]
    })
    const outs: string[] = []
    d.mcpOAuth = { login: async () => {}, logout: (id) => outs.push(id) }
    const t = fakeIo(['/mcp logout 1', null])
    d.io = t.io
    await runTui(opts, d)
    expect(outs).toEqual(['linear'])
    expect(t.text()).toContain('signed out of "linear"')
  })

  it('/mcp list shows live connection status and sign-in badges', async () => {
    const { d } = deps([{ runId: 'x', type: 'done', stopReason: 'end_turn' }], {
      mcpServers: [
        {
          id: 'linear',
          name: 'linear',
          transport: 'http',
          command: '',
          url: 'https://x/mcp',
          hasOAuth: true,
          enabled: true
        },
        { id: 'gh', name: 'gh', transport: 'http', command: '', url: 'https://y/mcp', enabled: true }
      ]
    })
    d.settingsPath = () => '/p/s.json'
    d.mcpStatuses = () => [
      { id: 'linear', state: 'connected', tools: 7 },
      { id: 'gh', state: 'needs-auth', error: 'HTTP 401' }
    ]
    const t = fakeIo(['/mcp', null])
    d.io = t.io
    await runTui(opts, d)
    expect(t.text()).toContain('signed in')
    expect(t.text()).toContain('connected, 7 tools')
    expect(t.text()).toContain('needs sign-in (/mcp login 2)')
  })

  it('/mcp lists servers without leaking header secrets and points to the desktop app', async () => {
    const remote: McpServerConfig = {
      id: 'remote',
      name: 'remote',
      transport: 'http',
      command: '',
      url: 'https://example.com/mcp',
      headers: { Authorization: 'secret-xyz' },
      enabled: true
    }
    const { d } = deps([{ runId: 'x', type: 'done', stopReason: 'end_turn' }], { mcpServers: [remote] })
    d.settingsPath = () => '/p/s.json'
    const t = fakeIo(['/mcp', null])
    d.io = t.io
    await runTui(opts, d)
    const out = t.text()
    expect(out).toContain('remote')
    expect(out).not.toContain('secret-xyz')
    expect(out).toContain('desktop app')
  })
})

describe('runTui — plan review (present_plan)', () => {
  const planEvent = { runId: 'x', type: 'plan_ready' as const, callId: 'p1', plan: { title: 'Refactor auth', body: 'Move the guard to middleware.' } }
  const withPlan = (): AgentEvent[] => [planEvent, { runId: 'x', type: 'done', stopReason: 'end_turn' }]

  it('renders the plan and resolves accept (auto-edit) — the run does not hang', async () => {
    const { d, rec } = deps(withPlan())
    const t = fakeIo(['do it', 'a', null])
    d.io = t.io
    await runTui(opts, d)
    expect(t.text()).toContain('Refactor auth')
    expect(t.text()).toContain('Move the guard to middleware.')
    expect(rec.plans).toEqual([['run-1', 'p1', { kind: 'accept', mode: 'auto-edit' }]])
  })

  it('resolves accept-ask (approve each edit)', async () => {
    const { d, rec } = deps(withPlan())
    d.io = fakeIo(['do it', 'k', null]).io
    await runTui(opts, d)
    expect(rec.plans).toEqual([['run-1', 'p1', { kind: 'accept', mode: 'ask' }]])
  })

  it('resolves reject', async () => {
    const { d, rec } = deps(withPlan())
    d.io = fakeIo(['do it', 'r', null]).io
    await runTui(opts, d)
    expect(rec.plans).toEqual([['run-1', 'p1', { kind: 'reject' }]])
  })

  it('resolves suggest, carrying the typed note', async () => {
    const { d, rec } = deps(withPlan())
    d.io = fakeIo(['do it', 's', 'add tests first', null]).io
    await runTui(opts, d)
    expect(rec.plans).toEqual([['run-1', 'p1', { kind: 'suggest', note: 'add tests first' }]])
  })

  it('edit opens the editor and accepts the edited body', async () => {
    const { d, rec } = deps(withPlan())
    d.io = fakeIo(['do it', 'e', null]).io
    d.editText = async (initial) => `${initial}\n\nEdited by hand.`
    await runTui(opts, d)
    expect(rec.plans).toHaveLength(1)
    const [, , decision] = rec.plans[0]
    expect(decision.kind).toBe('accept')
    if (decision.kind === 'accept') expect(decision.editedBody).toContain('Edited by hand.')
  })

  it('edit with no editor configured falls back to accepting as presented', async () => {
    const { d, rec } = deps(withPlan())
    const t = fakeIo(['do it', 'e', null])
    d.io = t.io
    // No editText dep wired → no editor available.
    await runTui(opts, d)
    expect(rec.plans).toEqual([['run-1', 'p1', { kind: 'accept', mode: 'auto-edit' }]])
    expect(t.text()).toMatch(/no editor available/i)
  })

  // Parity guard (runtime complement to the assertNever compile guard): every
  // BLOCKING interaction the loop awaits must be resolved by the client, or the
  // run hangs. plan_ready was the case that regressed — it was silently dropped.
  it('resolves every blocking interaction so the run never hangs', async () => {
    const { d, rec } = deps([
      { runId: 'x', type: 'tool_approval', callId: 'a1', name: 'run_shell', summary: 'ls', kind: 'shell' },
      { runId: 'x', type: 'tool_question', callId: 'q1', question: 'Which?', options: [{ label: 'A' }] },
      { runId: 'x', type: 'plan_ready', callId: 'p1', plan: { title: 'Plan' } },
      {
        runId: 'x',
        type: 'elicitation',
        callId: 'm1',
        elicitId: 'm1:e1',
        serverId: 'srv',
        message: 'Which region?',
        fields: [{ name: 'region', kind: 'string', required: true }]
      },
      { runId: 'x', type: 'done', stopReason: 'end_turn' }
    ])
    // go → approval y → question 1 → plan r → elicitation: provide? y → region value.
    d.io = fakeIo(['go', 'y', '1', 'r', 'y', 'us-east', null]).io
    await runTui(opts, d)
    expect(rec.approvals).toHaveLength(1)
    expect(rec.questions).toHaveLength(1)
    expect(rec.plans).toEqual([['run-1', 'p1', { kind: 'reject' }]])
    expect(rec.elicitations).toEqual([
      ['run-1', 'm1:e1', { action: 'accept', content: { region: 'us-east' } }]
    ])
  })

  it('declines an elicitation on "n" and cancels on end-of-input', async () => {
    const elicit = (id: string): AgentEvent => ({
      runId: 'x',
      type: 'elicitation',
      callId: 'm1',
      elicitId: id,
      serverId: 'srv',
      message: 'Token?',
      fields: [{ name: 'token', kind: 'string', required: true }]
    })
    const declined = deps([elicit('m1:e1'), { runId: 'x', type: 'done', stopReason: 'end_turn' }])
    declined.d.io = fakeIo(['go', 'n', null]).io
    await runTui(opts, declined.d)
    expect(declined.rec.elicitations).toEqual([['run-1', 'm1:e1', { action: 'decline' }]])

    const cancelled = deps([elicit('m1:e2'), { runId: 'x', type: 'done', stopReason: 'end_turn' }])
    cancelled.d.io = fakeIo(['go', 'y', null]).io // EOF while awaiting the field value
    await runTui(opts, cancelled.d)
    expect(cancelled.rec.elicitations).toEqual([['run-1', 'm1:e2', { action: 'cancel' }]])
  })
})

describe('/login helpers', () => {
  it('keyableProviders keeps only key-requiring providers', () => {
    const s = settings({
      providers: [
        prov({ id: 'anthropic', requiresKey: true, hasKey: false, models: [] }),
        prov({ id: 'ollama', requiresKey: false, hasKey: false, models: [] })
      ]
    })
    expect(keyableProviders(s).map((p) => p.id)).toEqual(['anthropic'])
  })

  it('parseProviderMenuChoice maps numbers to provider / other / cancel', () => {
    expect(parseProviderMenuChoice('1', 2)).toEqual({ kind: 'provider', index: 0 })
    expect(parseProviderMenuChoice('2', 2)).toEqual({ kind: 'provider', index: 1 })
    expect(parseProviderMenuChoice('3', 2)).toEqual({ kind: 'other' }) // the "Other host…" row
    expect(parseProviderMenuChoice('', 2)).toEqual({ kind: 'cancel' }) // Enter → skip
    expect(parseProviderMenuChoice('9', 2)).toEqual({ kind: 'cancel' })
    expect(parseProviderMenuChoice('x', 2)).toEqual({ kind: 'cancel' })
  })

  it('parseCatalogChoice maps numbers to host / custom / cancel', () => {
    expect(parseCatalogChoice('1', 3)).toEqual({ kind: 'host', index: 0 })
    expect(parseCatalogChoice('3', 3)).toEqual({ kind: 'host', index: 2 })
    expect(parseCatalogChoice('4', 3)).toEqual({ kind: 'custom' }) // the trailing custom row
    expect(parseCatalogChoice('', 3)).toEqual({ kind: 'cancel' })
  })

  it('renderProviderMenu shows key status and the Other-host row', () => {
    const providers = keyableProviders(
      settings({
        providers: [
          prov({ id: 'anthropic', label: 'Anthropic', requiresKey: true, hasKey: true, models: [{ id: 'claude' }] }),
          prov({ id: 'openai', label: 'OpenAI', requiresKey: true, hasKey: false, models: [{ id: 'gpt-5' }] })
        ]
      })
    )
    const out = renderProviderMenu(providers, makePainter(false), { firstRun: true })
    expect(out).toContain('No model is ready yet')
    expect(out).toContain('1)')
    expect(out).toContain('Anthropic')
    expect(out).toContain('key set')
    expect(out).toContain('no key')
    expect(out).toContain('Other host')
  })

  it('summarizeModels caps the preview and collapses the rest to +N more', () => {
    const paint = makePainter(false)
    expect(summarizeModels([], paint)).toBe('no models yet')
    expect(summarizeModels(['a', 'b'], paint)).toBe('a, b') // under the cap: shown in full
    const many = Array.from({ length: 30 }, (_, i) => `m${i}`)
    const out = summarizeModels(many, paint, 4)
    expect(out).toContain('m0, m1, m2, m3')
    expect(out).toContain('+26 more')
    expect(out).not.toContain('m10') // the tail is collapsed, not printed
  })

  it('renderProviderMenu caps a huge model list instead of dumping every id', () => {
    const providers = keyableProviders(
      settings({
        providers: [
          prov({
            id: 'openrouter',
            label: 'OpenRouter',
            requiresKey: true,
            hasKey: true,
            models: Array.from({ length: 300 }, (_, i) => ({ id: `vendor/model-${i}` }))
          })
        ]
      })
    )
    const out = renderProviderMenu(providers, makePainter(false), { firstRun: true })
    expect(out).toContain('more') // e.g. "+296 more"
    expect(out).not.toContain('vendor/model-299') // the wall of ids is not printed
  })

  it('otherHostExamples names addable hosts plus the custom-endpoint option', () => {
    const addable = catalogForPlatform(true).filter((e) => e.id === 'groq' || e.id === 'together')
    const out = otherHostExamples(addable)
    expect(out).toContain('Groq')
    expect(out).toContain('a custom endpoint')
    expect(out).not.toContain('OpenRouter') // not in the addable list we passed
  })

  it('renderCatalogMenu lists hosts flatly then a Custom endpoint row', () => {
    const out = renderCatalogMenu(catalogForPlatform(true), makePainter(false))
    expect(out).toContain('OpenRouter')
    expect(out).toContain('Custom endpoint')
    // locals carry the inline "no key needed" note rather than a separate section
    expect(out).toContain('no key needed')
  })

  it('renderNoModelStatus points at /login', () => {
    const out = renderNoModelStatus('ask', '/proj', 80, makePainter(false))
    expect(out).toContain('/login')
    expect(out).toContain('ask')
  })

  it('renderNoModelStatus truncates a long line to the width', () => {
    const out = renderNoModelStatus('ask', '/a/very/long/path/that/exceeds', 20, makePainter(false))
    expect(out.length).toBeLessThanOrEqual(20)
  })

  it('parseSlashCommand routes /login and /providers to the login flow', () => {
    expect(parseSlashCommand('/login', settings())).toEqual({ kind: 'login' })
    expect(parseSlashCommand('/providers', settings())).toEqual({ kind: 'login' })
  })
})

describe('runTui — /login & keyless start', () => {
  // Build wizard-capable deps: a keyless start (no ready provider) plus recorders
  // for the injected setKey / updateSettings seams.
  function wizardDeps(events: AgentEvent[], over: Partial<AppSettings>) {
    const base = deps(events, over)
    const setKeyCalls: Array<[string, string]> = []
    const patches: Array<Partial<AppSettings>> = []
    const keyed = new Set<string>()
    base.d.setKey = (id, key) => {
      setKeyCalls.push([id, key])
      keyed.add(id) // reality: getSettings recomputes hasKey, so this provider is now ready
      return { shadowedByEnv: null }
    }
    base.d.updateSettings = (patch) => {
      patches.push(patch)
    }
    base.d.isMac = true
    // getSettings recomputes hasKey from the credential store on every read; mirror
    // that so a just-stored key marks its provider ready (the run-time key preflight
    // reads getSettings().hasKey).
    const origGetSettings = base.d.getSettings
    base.d.getSettings = () => {
      const s = origGetSettings()
      return {
        ...s,
        providers: s.providers.map((p) => (keyed.has(p.id) ? { ...p, hasKey: true } : p))
      }
    }
    return { ...base, setKeyCalls, patches }
  }

  const twoProviders = [
    prov({ id: 'anthropic', requiresKey: true, hasKey: false, models: [{ id: 'claude' }], defaultModel: 'claude' }),
    prov({ id: 'openai', requiresKey: true, hasKey: false, models: [{ id: 'gpt-5' }], defaultModel: 'gpt-5' })
  ]

  it('auto-launches setup on a keyless start, stores a key, then runs (no eject)', async () => {
    const { d, rec, setKeyCalls, patches } = wizardDeps(
      [
        { runId: 'x', type: 'text', delta: 'ok' },
        { runId: 'x', type: 'done', stopReason: 'end_turn' }
      ],
      { selected: null, providers: twoProviders }
    )
    // pick #1 (anthropic), paste a key, then send a real prompt, then EOF.
    const t = fakeIo(['1', 'sk-ant-123', 'fix the bug', null])
    d.io = t.io
    const code = await runTui(opts, d)
    expect(code).toBe(0)
    expect(setKeyCalls).toEqual([['anthropic', 'sk-ant-123']])
    expect(rec.runs).toHaveLength(1)
    expect(rec.runs[0]).toMatchObject({ providerId: 'anthropic', model: 'claude' })
    // The selection is persisted so the next launch skips setup.
    expect(patches.some((p) => (p.selected as { providerId?: string } | null)?.providerId === 'anthropic')).toBe(true)
    expect(t.text()).toContain('Key saved for anthropic')
  })

  it('skipping setup lands in a gated REPL, not the shell', async () => {
    const { d, rec } = wizardDeps([], { selected: null, providers: twoProviders })
    // Enter to skip, then try a prompt (blocked), then EOF.
    const t = fakeIo(['', 'hello', null])
    d.io = t.io
    const code = await runTui(opts, d)
    expect(code).toBe(0)
    expect(rec.runs).toHaveLength(0) // no turn ran without a model
    expect(t.text()).toContain('No provider set up yet')
    expect(t.text()).toContain('No model is ready yet. Run /login')
  })

  it('/login mid-session stores a key and switches the active model', async () => {
    const { d, rec, setKeyCalls } = wizardDeps(
      [
        { runId: 'x', type: 'text', delta: 'ok' },
        { runId: 'x', type: 'done', stopReason: 'end_turn' }
      ],
      // Boot ready on anthropic; openai has no key yet.
      {
        selected: { providerId: 'anthropic', model: 'claude' },
        providers: [
          prov({ id: 'anthropic', requiresKey: true, hasKey: true, models: [{ id: 'claude' }], defaultModel: 'claude' }),
          prov({ id: 'openai', requiresKey: true, hasKey: false, models: [{ id: 'gpt-5' }], defaultModel: 'gpt-5' })
        ]
      }
    )
    const t = fakeIo(['/login', '2', 'sk-openai', 'do it', null])
    d.io = t.io
    const code = await runTui(opts, d)
    expect(code).toBe(0)
    expect(setKeyCalls).toEqual([['openai', 'sk-openai']])
    expect(rec.runs).toHaveLength(1)
    expect(rec.runs[0]).toMatchObject({ providerId: 'openai', model: 'gpt-5' })
  })

  it('/login → Other host adds a catalog host and stores its key', async () => {
    const { d, rec, setKeyCalls, patches } = wizardDeps(
      [
        { runId: 'x', type: 'text', delta: 'ok' },
        { runId: 'x', type: 'done', stopReason: 'end_turn' }
      ],
      {
        selected: { providerId: 'anthropic', model: 'claude' },
        providers: [
          prov({ id: 'anthropic', requiresKey: true, hasKey: true, models: [{ id: 'claude' }], defaultModel: 'claude' })
        ]
      }
    )
    // menu: 1) anthropic, 2) Other host…; catalog item 1 is OpenRouter (first entry).
    const t = fakeIo(['/login', '2', '1', 'sk-or-key', 'go', null])
    d.io = t.io
    const code = await runTui(opts, d)
    expect(code).toBe(0)
    expect(patches.some((p) => (p.providers ?? []).some((pr) => pr.id === 'openrouter'))).toBe(true)
    expect(setKeyCalls).toEqual([['openrouter', 'sk-or-key']])
    // OpenRouter has no models yet, so the active model stays on anthropic.
    expect(rec.runs[0]).toMatchObject({ providerId: 'anthropic', model: 'claude' })
    expect(t.text()).toContain('has no models yet')
  })

  it('the Other-host hint excludes an already-configured host (e.g. OpenRouter as row 2)', async () => {
    const { d } = wizardDeps([], {
      selected: { providerId: 'anthropic', model: 'claude' },
      providers: [
        prov({ id: 'anthropic', requiresKey: true, hasKey: true, models: [{ id: 'claude' }], defaultModel: 'claude' }),
        prov({ id: 'openrouter', label: 'OpenRouter', requiresKey: true, hasKey: true, models: [{ id: 'x' }], defaultModel: 'x' })
      ]
    })
    const t = fakeIo(['/login', '', null]) // open /login, cancel at the menu, exit
    d.io = t.io
    await runTui(opts, d)
    const text = t.text()
    expect(text).toMatch(/2\).*OpenRouter/) // OpenRouter is a numbered provider row
    const otherLine = text.split('\n').find((l) => l.includes('Other host')) ?? ''
    expect(otherLine).not.toContain('OpenRouter') // but the hint doesn't re-advertise it
  })

  it('/login → Other host → Custom endpoint adds a URL-based provider', async () => {
    const { d, patches } = wizardDeps([], {
      selected: { providerId: 'anthropic', model: 'claude' },
      providers: [
        prov({ id: 'anthropic', requiresKey: true, hasKey: true, models: [{ id: 'claude' }], defaultModel: 'claude' })
      ]
    })
    d.newId = () => 'aaaabbbb-cccc-dddd-eeee-ffff00001111'
    // The custom-endpoint row is the item after every catalog host.
    const customIdx = String(catalogForPlatform(true).length + 1)
    const t = fakeIo([
      '/login',
      '2',
      customIdx,
      'My Router',
      'https://router.internal/v1',
      '', // no key needed (endpoint is keyless)
      null
    ])
    d.io = t.io
    const code = await runTui(opts, d)
    expect(code).toBe(0)
    const added = patches
      .flatMap((p) => p.providers ?? [])
      .find((pr) => pr.baseUrl === 'https://router.internal/v1')
    expect(added).toBeDefined()
    expect(added!.id).toMatch(/^custom-/)
    expect(added!.label).toBe('My Router')
    expect(added!.kind).toBe('openai-compatible')
  })

  it('an unknown --provider is a usage error: prints it and exits, no wizard', async () => {
    const { d, rec } = wizardDeps([], { selected: null, providers: twoProviders })
    const t = fakeIo([null])
    d.io = t.io
    const code = await runTui({ ...opts, providerId: 'bogus' }, d)
    expect(code).toBe(1)
    expect(rec.runs).toHaveLength(0)
    expect(t.text()).toContain('Unknown provider: bogus')
    expect(t.text()).not.toContain('Other host') // the setup wizard never opened
  })

  it('without a writable key store, a keyless start still prints the error and exits', async () => {
    // No setKey wired → fall back to the headless-style message + exit 1 (old behavior).
    const { d } = deps([], { selected: null, providers: twoProviders })
    const t = fakeIo([null])
    d.io = t.io
    const code = await runTui(opts, d)
    expect(code).toBe(1)
    expect(t.text()).toContain('No model configured')
  })

  it('a stored openai selection with no key opens setup instead of the confusing eject', async () => {
    // The original bug: selected=openai, no key → the message named openai and ejected.
    // Now it opens /login; picking anthropic clears the stale selection.
    const { d, rec, setKeyCalls } = wizardDeps(
      [
        { runId: 'x', type: 'text', delta: 'ok' },
        { runId: 'x', type: 'done', stopReason: 'end_turn' }
      ],
      { selected: { providerId: 'openai', model: 'gpt-5' }, providers: twoProviders }
    )
    const t = fakeIo(['1', 'sk-ant', 'go', null])
    d.io = t.io
    const code = await runTui(opts, d)
    expect(code).toBe(0)
    expect(setKeyCalls).toEqual([['anthropic', 'sk-ant']])
    expect(rec.runs[0]).toMatchObject({ providerId: 'anthropic', model: 'claude' })
  })
})

describe('promptFolderTrust', () => {
  const elevatingProject = {
    permissionRules: [{ action: 'allow', tool: 'run_shell', match: 'npm test*' }],
    hooks: [{ event: 'PostToolUse', matcher: 'write_file', command: 'npm run fmt' }],
    mcpServers: [{ id: 'docs', command: 'npx' }]
  }

  function makeWorkspace(project?: unknown): string {
    const ws = mkdtempSync(join(tmpdir(), 'houston-trust-'))
    if (project !== undefined) {
      mkdirSync(join(ws, '.houston'), { recursive: true })
      writeFileSync(join(ws, '.houston/settings.json'), JSON.stringify(project))
    }
    return ws
  }

  function trustDeps(
    answers: Array<string | null>,
    over: Partial<AppSettings> = {}
  ): { d: TuiDeps; patches: Partial<AppSettings>[]; text: () => string } {
    const { d } = deps([], over)
    const io = fakeIo(answers)
    d.io = io.io
    const patches: Partial<AppSettings>[] = []
    d.updateSettings = (patch) => patches.push(patch)
    return { d, patches, text: io.text }
  }

  it('no-ops when the project elevates nothing (no prompt, no write)', async () => {
    const ws = makeWorkspace({ permissionRules: [{ action: 'deny', tool: 'run_shell', match: '*' }] })
    try {
      const { d, patches, text } = trustDeps(['y'])
      await promptFolderTrust(ws, d, makePainter(false))
      expect(patches).toEqual([])
      expect(text()).not.toContain('Trust this folder?')
    } finally {
      rmSync(ws, { recursive: true, force: true })
    }
  })

  it('persists a trusted decision bound to the current fingerprint on y', async () => {
    const ws = makeWorkspace(elevatingProject)
    try {
      const { d, patches, text } = trustDeps(['y'])
      await promptFolderTrust(ws, d, makePainter(false))
      expect(text()).toContain('1 allow rule, 1 hook, 1 MCP server')
      expect(patches).toHaveLength(1)
      const rec = patches[0].trustedFolders![0]
      expect(rec.decision).toBe('trusted')
      expect(rec.path).toBe(realpathSync(ws))
      expect(rec.hash).toMatch(/^[0-9a-f]{64}$/)
    } finally {
      rmSync(ws, { recursive: true, force: true })
    }
  })

  it('persists never, leaves undecided on anything else, and skips when already decided', async () => {
    const ws = makeWorkspace(elevatingProject)
    try {
      const never = trustDeps(['never'])
      await promptFolderTrust(ws, never.d, makePainter(false))
      expect(never.patches[0].trustedFolders![0].decision).toBe('never')

      const later = trustDeps([''])
      await promptFolderTrust(ws, later.d, makePainter(false))
      expect(later.patches).toEqual([])
      expect(later.text()).toContain('ask again next session')

      // Already decided (same fingerprint): no prompt at all.
      const decidedSettings = never.patches[0]
      const again = trustDeps(['y'], decidedSettings)
      await promptFolderTrust(ws, again.d, makePainter(false))
      expect(again.patches).toEqual([])
      expect(again.text()).not.toContain('Trust this folder?')
    } finally {
      rmSync(ws, { recursive: true, force: true })
    }
  })

  it('re-prompts (as changed) when the elevating config drifted since trust', async () => {
    const ws = makeWorkspace(elevatingProject)
    try {
      const first = trustDeps(['y'])
      await promptFolderTrust(ws, first.d, makePainter(false))
      // The project gains a new hook after the user trusted it.
      writeFileSync(
        join(ws, '.houston/settings.json'),
        JSON.stringify({ ...elevatingProject, hooks: [{ event: 'Stop', matcher: '*', command: 'curl x' }] })
      )
      const second = trustDeps(['y'], first.patches[0])
      await promptFolderTrust(ws, second.d, makePainter(false))
      expect(second.text()).toContain('trusted configuration changed')
      expect(second.patches).toHaveLength(1) // re-trusted under the new fingerprint
      expect(second.patches[0].trustedFolders![0].hash).not.toBe(first.patches[0].trustedFolders![0].hash)
    } finally {
      rmSync(ws, { recursive: true, force: true })
    }
  })

  it('does nothing when the host cannot persist settings', async () => {
    const ws = makeWorkspace(elevatingProject)
    try {
      const { d, text } = trustDeps(['y'])
      d.updateSettings = undefined
      await promptFolderTrust(ws, d, makePainter(false))
      expect(text()).toBe('')
    } finally {
      rmSync(ws, { recursive: true, force: true })
    }
  })
})

describe('summarizeElevated', () => {
  it('pluralizes and joins only the present kinds', () => {
    expect(summarizeElevated({ allowRules: [1, 2], hooks: [], mcpServers: [1] })).toBe(
      '2 allow rules, 1 MCP server'
    )
    expect(summarizeElevated({ allowRules: [], hooks: [1], mcpServers: [] })).toBe('1 hook')
  })
})

// The composer read goes through io.readComposer when the terminal provides one
// (the raw-mode editor), falling back to line-at-a-time readLine otherwise. These
// cover the driver's side of that seam; the editor itself is tested in
// tui-editor.test.ts and the decoder in tui-keys.test.ts.
describe('readComposer seam', () => {
  function fakeComposerIo(inputs: Array<string | null>) {
    const out: string[] = []
    const interrupts: Array<() => void> = []
    const prompts: string[] = []
    let idx = 0
    const io: TuiIo = {
      out: (s) => out.push(s),
      clearLine: () => {},
      readLine: async () => null,
      readComposer: async (prompt) => {
        prompts.push(typeof prompt === 'string' ? prompt : prompt())
        const next = idx < inputs.length ? inputs[idx++] : null
        if (next === CTRLC) {
          interrupts.forEach((h) => h())
          return null
        }
        return next
      },
      onInterrupt: (h) => interrupts.push(h),
      cancelRead: () => {}
    }
    return { io, prompts, text: () => out.join('') }
  }

  const done: AgentEvent[] = [{ runId: 'x', type: 'done', stopReason: 'end_turn' }]

  it('prefers readComposer over readLine and sends its text as one turn', async () => {
    const { d, rec } = deps(done)
    const t = fakeComposerIo(['hello there', null])
    d.io = t.io
    await runTui(opts, d)
    expect(rec.runs).toHaveLength(1)
    expect(rec.runs[0].messages.at(-1)?.content).toBe('hello there')
  })

  // The paste fix, end to end at the driver: a multi-line message is ONE turn,
  // not a first line submitted with the rest replayed as further input.
  it('sends a multi-line message as a single turn', async () => {
    const { d, rec } = deps(done)
    const t = fakeComposerIo(['fix this:\n\n```js\nconst a = 1\n```', null])
    d.io = t.io
    await runTui(opts, d)
    expect(rec.runs).toHaveLength(1)
    expect(rec.runs[0].messages.at(-1)?.content).toBe('fix this:\n\n```js\nconst a = 1\n```')
  })

  it('shows the policy in the composer prompt', async () => {
    const { d } = deps(done)
    const t = fakeComposerIo([null])
    d.io = t.io
    await runTui({ ...opts, approvalPolicy: 'auto-edit' }, d)
    expect(t.prompts[0]).toContain('auto-edit')
  })

  it('treats a null read with no interrupt as EOF and exits', async () => {
    const { d, rec } = deps(done)
    const t = fakeComposerIo([null])
    d.io = t.io
    const code = await runTui(opts, d)
    expect(code).toBe(0)
    expect(rec.runs).toHaveLength(0)
    expect(t.text()).toMatch(/Bye/)
  })

  it('Ctrl-C at the composer discards the draft and re-prompts instead of exiting', async () => {
    const { d, rec } = deps(done)
    const t = fakeComposerIo([CTRLC, 'after the interrupt', null])
    d.io = t.io
    await runTui(opts, d)
    expect(rec.runs).toHaveLength(1)
    expect(rec.runs[0].messages.at(-1)?.content).toBe('after the interrupt')
    expect(t.text()).toMatch(/Ctrl-C again or Ctrl-D to exit/)
  })

  it('a second Ctrl-C in quick succession exits', async () => {
    const { d, rec } = deps(done)
    const t = fakeComposerIo([CTRLC, CTRLC, 'never sent', null])
    d.io = t.io
    d.now = () => 1000 // a frozen clock: both interrupts land inside the 1500ms window
    const code = await runTui(opts, d)
    expect(code).toBe(0)
    expect(rec.runs).toHaveLength(0)
  })

  it('slash commands still work through the composer', async () => {
    const { d, rec } = deps(done)
    const t = fakeComposerIo(['/cwd', null])
    d.io = t.io
    await runTui(opts, d)
    expect(rec.runs).toHaveLength(0)
    expect(t.text()).toContain(opts.cwd)
  })

  it('persists a submitted message to history', async () => {
    const { d, rec } = deps(done)
    const saved: string[] = []
    d.persistHistory = (l) => saved.push(l)
    d.io = fakeComposerIo(['remember me', null]).io
    await runTui(opts, d)
    expect(saved).toEqual(['remember me'])
    expect(rec.runs).toHaveLength(1)
  })
})

describe('version, update check, and /doctor', () => {
  const done: AgentEvent[] = [{ runId: 'x', type: 'done', stopReason: 'end_turn' }]

  it('shows the running version in the banner', async () => {
    const { d } = deps(done)
    const t = fakeIo([null])
    d.io = t.io
    d.version = '1.2.3'
    await runTui(opts, d)
    expect(t.text()).toContain('v1.2.3')
  })

  it('surfaces an available update between turns, once', async () => {
    const { d } = deps(done)
    const t = fakeIo(['hi', null])
    d.io = t.io
    d.version = '0.2.141'
    d.checkUpdate = async () => ({ latest: '0.3.0', url: 'https://x/releases', headline: 'Faster' })
    await runTui(opts, d)
    const out = t.text()
    expect(out).toContain('update available: 0.3.0')
    expect(out).toContain('https://x/releases')
    expect(out).toContain('Faster')
    // One nudge per session, not one per prompt.
    expect(out.match(/update available/g)).toHaveLength(1)
  })

  it('says nothing when there is no update, and never blocks on the check', async () => {
    const { d } = deps(done)
    const t = fakeIo([null])
    d.io = t.io
    d.checkUpdate = async () => null
    await runTui(opts, d)
    expect(t.text()).not.toContain('update available')
  })

  // A failed check is a non-event: it must not surface, and must not break the REPL.
  it('ignores a failing update check', async () => {
    const { d, rec } = deps(done)
    const t = fakeIo(['still works', null])
    d.io = t.io
    d.checkUpdate = async () => {
      throw new Error('offline')
    }
    const code = await runTui(opts, d)
    expect(code).toBe(0)
    expect(rec.runs).toHaveLength(1)
    expect(t.text()).not.toContain('update available')
  })

  it('/doctor renders the report', async () => {
    const { d } = deps(done)
    const t = fakeIo(['/doctor', null])
    d.io = t.io
    d.doctor = async () => ({
      version: '0.2.141',
      nodeVersion: 'v22.11.0',
      platform: 'darwin arm64',
      cwd: '/w',
      settingsPath: '/s.json',
      sandbox: { backend: 'seatbelt', enforced: true },
      providers: [{ id: 'anthropic', requiresKey: true, hasKey: true }],
      active: { providerId: 'anthropic', model: 'claude' },
      mcp: [],
      binaries: [{ name: 'git', path: '/usr/bin/git', purpose: 'git' }],
      terminal: { tty: true, color: false, columns: 80, term: 'xterm' },
      update: null
    })
    await runTui(opts, d)
    expect(t.text()).toContain('Everything looks healthy.')
    expect(t.text()).toContain('seatbelt')
  })

  it('/doctor reports rather than throws when the probe fails', async () => {
    const { d } = deps(done)
    const t = fakeIo(['/doctor', null])
    d.io = t.io
    d.doctor = async () => {
      throw new Error('probe exploded')
    }
    const code = await runTui(opts, d)
    expect(code).toBe(0)
    expect(t.text()).toContain("couldn't run diagnostics")
  })

  it('/doctor says so when diagnostics are unavailable', async () => {
    const { d } = deps(done)
    const t = fakeIo(['/doctor', null])
    d.io = t.io
    await runTui(opts, d)
    expect(t.text()).toContain('diagnostics are unavailable')
  })
})

// A terminal session that blocked on an approval used to say nothing at all: the
// run stalls and the only way to notice is to keep looking at it.
describe('attention signals', () => {
  function signalIo(inputs: Array<string | null>) {
    const base = fakeIo(inputs)
    const signals: Array<{ title?: string; alert?: { title: string; body: string } }> = []
    base.io.signal = (s) => signals.push(s)
    return { ...base, signals }
  }

  it('signals when a run blocks on an approval, naming the tool', async () => {
    const { d } = deps([
      { runId: 'x', type: 'tool_approval', callId: 'a1', name: 'run_shell', summary: 'rm -rf build', kind: 'shell' },
      { runId: 'x', type: 'done', stopReason: 'end_turn' }
    ])
    const t = signalIo(['go', 'n', null])
    d.io = t.io
    await runTui(opts, d)
    const alerts = t.signals.filter((s) => s.alert)
    expect(alerts.some((s) => s.alert?.title.includes('needs approval'))).toBe(true)
    expect(alerts.some((s) => s.alert?.body.includes('rm -rf build'))).toBe(true)
  })

  it('signals when the turn finishes and returns the title to idle', async () => {
    const { d } = deps([{ runId: 'x', type: 'done', stopReason: 'end_turn' }])
    const t = signalIo(['go', null])
    d.io = t.io
    await runTui(opts, d)
    expect(t.signals.some((s) => s.alert?.body === 'Finished responding.')).toBe(true)
    expect(t.signals.at(-1)?.title).toBe('')
  })

  it('honors the user’s notify-me setting: title still set, no alert', async () => {
    const { d } = deps([{ runId: 'x', type: 'done', stopReason: 'end_turn' }], {
      desktopNotifications: false
    })
    const t = signalIo(['go', null])
    d.io = t.io
    await runTui(opts, d)
    expect(t.signals.some((s) => s.alert)).toBe(false)
    expect(t.signals.some((s) => s.title)).toBe(true)
  })

  it('does not signal for ordinary streaming', async () => {
    const { d } = deps([
      { runId: 'x', type: 'text', delta: 'hello' },
      { runId: 'x', type: 'tool_start', callId: 'c', name: 'read_file', args: { path: 'a.ts' } }
    ])
    const t = signalIo(['go', null])
    d.io = t.io
    await runTui(opts, d)
    expect(t.signals.filter((s) => s.alert)).toHaveLength(0)
  })

  it('sets an idle title at startup so the tab is never blank', async () => {
    const { d } = deps([])
    const t = signalIo([null])
    d.io = t.io
    await runTui(opts, d)
    expect(t.signals[0]?.title).toContain('Houston')
  })
})

// Tool output used to be unrecoverable: one 80-char line, forever, even though
// the full text was already sitting in the persisted log.
describe('/verbose and /output', () => {
  const withTool: AgentEvent[] = [
    { runId: 'x', type: 'tool_start', callId: 'c1', name: 'run_shell', args: { command: 'ls' }, kind: 'shell' },
    { runId: 'x', type: 'tool_result', callId: 'c1', name: 'run_shell', ok: true, output: 'alpha\nbeta\ngamma' },
    { runId: 'x', type: 'done', stopReason: 'end_turn' }
  ]

  it('collapses tool output to one line by default', async () => {
    const { d } = deps(withTool)
    const t = fakeIo(['go', null])
    d.io = t.io
    await runTui(opts, d)
    expect(t.text()).toContain('alpha')
    expect(t.text()).not.toContain('gamma')
  })

  it('/verbose opens it up for subsequent turns', async () => {
    const { d } = deps(withTool)
    const t = fakeIo(['/verbose', 'go', null])
    d.io = t.io
    await runTui(opts, d)
    expect(t.text()).toContain('gamma')
  })

  it('/verbose toggles back off', async () => {
    const { d } = deps(withTool)
    const t = fakeIo(['/verbose on', '/verbose off', 'go', null])
    d.io = t.io
    await runTui(opts, d)
    expect(t.text()).toContain('verbose off')
    expect(t.text()).not.toContain('gamma')
  })

  it('/output reprints the last tool result in full, from the persisted log', async () => {
    const { d } = deps(withTool, {}, (req) => [
      ...req.messages,
      { role: 'tool', content: 'alpha\nbeta\ngamma', toolName: 'run_shell', toolCallId: 'c1' }
    ])
    const t = fakeIo(['go', '/output', null])
    d.io = t.io
    await runTui(opts, d)
    // Not shown while streaming (collapsed), but recoverable afterwards.
    expect(t.text()).toContain('gamma')
    expect(t.text()).toContain('run_shell')
  })

  it('/output says so when nothing has run yet', async () => {
    const { d } = deps([])
    const t = fakeIo(['/output', null])
    d.io = t.io
    await runTui(opts, d)
    expect(t.text()).toContain('no tool output')
  })

  // The gap that hurt most: a failure told you nothing about why.
  it('shows a failure’s output without any toggle', async () => {
    const { d } = deps([
      { runId: 'x', type: 'tool_result', callId: 'c1', name: 'run_shell', ok: false, output: 'permission denied: /etc/hosts' },
      { runId: 'x', type: 'done', stopReason: 'end_turn' }
    ])
    const t = fakeIo(['go', null])
    d.io = t.io
    await runTui(opts, d)
    expect(t.text()).toContain('permission denied: /etc/hosts')
  })
})

// The escape every terminal REPL has. Without it, checking `git status` or
// rerunning a test meant leaving the session or asking the agent to do it for you.
describe('! shell escape', () => {
  it('recognizes a command, and only a real one', () => {
    expect(parseShellEscape('!git status')).toBe('git status')
    expect(parseShellEscape('!  npm test  ')).toBe('npm test')
    expect(parseShellEscape('!')).toBeNull()
    expect(parseShellEscape('!   ')).toBeNull()
    expect(parseShellEscape('git status')).toBeNull()
    expect(parseShellEscape('/help')).toBeNull()
    // Mid-line `!` is prompt text, not an escape.
    expect(parseShellEscape('fix the !important rule')).toBeNull()
  })

  it('runs the command and streams its output', async () => {
    const { d, rec } = deps([])
    const t = fakeIo(['!echo hi', null])
    d.io = t.io
    const ran: string[] = []
    d.runUserShell = async (cmd, onOutput) => {
      ran.push(cmd)
      onOutput('hi\n')
      return 0
    }
    await runTui(opts, d)
    expect(ran).toEqual(['echo hi'])
    expect(t.text()).toContain('$ echo hi')
    expect(t.text()).toContain('hi')
    expect(rec.runs).toHaveLength(0) // it is not a turn
  })

  it('reports a non-zero exit', async () => {
    const { d } = deps([])
    const t = fakeIo(['!false', null])
    d.io = t.io
    d.runUserShell = async () => 1
    await runTui(opts, d)
    expect(t.text()).toContain('exited 1')
  })

  // The reason to run it HERE rather than in another window: the agent can act on
  // what you just saw, without pasting it back.
  it('records the command and output in the conversation for the next turn', async () => {
    const { d, rec } = deps([{ runId: 'x', type: 'done', stopReason: 'end_turn' }])
    const t = fakeIo(['!npm test', 'fix those failures', null])
    d.io = t.io
    d.runUserShell = async (_cmd, onOutput) => {
      onOutput('2 tests failed\n')
      return 1
    }
    await runTui(opts, d)
    const sent = rec.runs[0].messages
    expect(sent.some((m) => m.content.includes('$ npm test'))).toBe(true)
    expect(sent.some((m) => m.content.includes('2 tests failed'))).toBe(true)
    expect(sent.some((m) => m.content.includes('exited 1'))).toBe(true)
    expect(sent.at(-1)?.content).toBe('fix those failures')
  })

  it('trims a chatty command so it cannot eat the context window', () => {
    const many = Array.from({ length: 500 }, (_, i) => `line ${i}`).join('\n')
    const rec = renderShellEscapeRecord('yes', many, 0)
    expect(rec).toContain('line 499') // the TAIL is what matters (errors land last)
    expect(rec).not.toContain('line 0\n')
    expect(rec).toContain('trimmed')
  })

  it('records a silent command honestly', () => {
    expect(renderShellEscapeRecord('true', '', 0)).toContain('(no output)')
  })

  it('survives a shell that cannot start', async () => {
    const { d } = deps([])
    const t = fakeIo(['!nope', null])
    d.io = t.io
    d.runUserShell = async () => {
      throw new Error('spawn ENOENT')
    }
    const code = await runTui(opts, d)
    expect(code).toBe(0)
    expect(t.text()).toContain("couldn't run it")
  })

  it('says so when the escape is unavailable', async () => {
    const { d } = deps([])
    const t = fakeIo(['!ls', null])
    d.io = t.io
    await runTui(opts, d)
    expect(t.text()).toContain('shell escape (!) is unavailable')
  })
})

// The agent could always fan work out from the terminal (spawn_session), but the
// only sign of it was one line when a session FINISHED — so parallel work was
// invisible exactly while it was running.
describe('/spawned — background fan-out', () => {
  const paintNo = makePainter(false)
  const NOW = 1_000_000
  const sessions: BackgroundSession[] = [
    { id: 'c-old', title: 'Docs pass', running: false, startedAt: NOW - 600_000 },
    { id: 'c-live', title: 'Refactor auth', running: true, startedAt: NOW - 60_000, branch: 'feat/auth' }
  ]

  it('lists running sessions first, with their branch', () => {
    const out = renderBackgroundSessions(sessions, NOW, paintNo)
    expect(out.indexOf('Refactor auth')).toBeLessThan(out.indexOf('Docs pass'))
    expect(out).toContain('running')
    expect(out).toContain('feat/auth')
    expect(out).toContain('finished')
  })

  it('says so when nothing has been spawned', () => {
    expect(renderBackgroundSessions([], NOW, paintNo)).toContain('No background sessions')
  })

  it('selects by the displayed order, not insertion order', () => {
    expect(parseSessionSelection('1', sessions)).toBe('c-live') // running is listed first
    expect(parseSessionSelection('2', sessions)).toBe('c-old')
    expect(parseSessionSelection('9', sessions)).toBeNull()
    expect(parseSessionSelection('no', sessions)).toBeNull()
  })

  it('opens a finished session into the current chat', async () => {
    const { d } = deps([])
    const t = fakeIo(['/spawned', '2', null])
    d.io = t.io
    d.now = () => NOW
    d.backgroundSessions = () => sessions
    d.persist = {
      ...(d.persist as TuiPersist),
      get: () => ({ messages: [{ role: 'user', content: 'seeded' }] })
    } as TuiPersist
    await runTui(opts, d)
    expect(t.text()).toContain('opened: 1 message(s)')
  })

  // Checking on parallel work must not stop it.
  it('opening a still-running session says it keeps going', async () => {
    const { d } = deps([])
    const t = fakeIo(['/spawned', '1', null])
    d.io = t.io
    d.now = () => NOW
    d.backgroundSessions = () => sessions
    d.persist = {
      ...(d.persist as TuiPersist),
      get: () => ({ messages: [{ role: 'user', content: 'go' }] })
    } as TuiPersist
    await runTui(opts, d)
    expect(t.text()).toContain('keeps going in the background')
  })

  it('says so when fan-out is unavailable', async () => {
    const { d } = deps([])
    const t = fakeIo(['/spawned', null])
    d.io = t.io
    await runTui(opts, d)
    expect(t.text()).toContain('background sessions are unavailable')
  })

  it('/resume still reopens saved chats', async () => {
    const { d } = deps([])
    const t = fakeIo(['/resume', null])
    d.io = t.io
    d.persist = {
      ...(d.persist as TuiPersist),
      list: () => [],
      get: () => null
    } as TuiPersist
    await runTui(opts, d)
    expect(t.text()).toContain('No saved sessions')
  })
})

// A follow-up typed during a turn should just… happen next, with no second Enter.
describe('queued follow-ups', () => {
  const done: AgentEvent[] = [{ runId: 'x', type: 'done', stopReason: 'end_turn' }]

  function queueIo(inputs: Array<string | null>, queued: string[][]) {
    const base = fakeIo(inputs)
    let i = 0
    base.io.takeQueued = () => queued[i++] ?? []
    base.io.clearQueued = () => {}
    return base
  }

  it('sends what was queued as the next turn, without prompting again', async () => {
    const { d, rec } = deps(done)
    // First turn from the composer; then a follow-up typed while it ran.
    const t = queueIo(['first', null], [['now add tests']])
    d.io = t.io
    await runTui(opts, d)
    expect(rec.runs).toHaveLength(2)
    expect(rec.runs[0].messages.at(-1)?.content).toBe('first')
    expect(rec.runs[1].messages.at(-1)?.content).toBe('now add tests')
  })

  it('echoes the queued message so the transcript shows what was sent', async () => {
    const { d } = deps(done)
    const t = queueIo(['first', null], [['queued thought']])
    d.io = t.io
    await runTui(opts, d)
    expect(t.text()).toContain('queued thought')
  })

  it('combines several queued messages into one turn', async () => {
    const { d, rec } = deps(done)
    const t = queueIo(['first', null], [['one', 'two']])
    d.io = t.io
    await runTui(opts, d)
    expect(rec.runs[1].messages.at(-1)?.content).toBe('one\n\ntwo')
  })

  it('prompts normally when nothing was queued', async () => {
    const { d, rec } = deps(done)
    const t = queueIo(['only', null], [[]])
    d.io = t.io
    await runTui(opts, d)
    expect(rec.runs).toHaveLength(1)
  })

  // The queue was a follow-up to work being thrown away.
  it('drops the queue when the run is interrupted', async () => {
    const { d } = deps(done)
    const t = fakeIo(['go', null])
    let cleared = 0
    t.io.takeQueued = () => []
    t.io.clearQueued = () => cleared++
    d.io = t.io
    d.startRun = async (_req, _send) => {
      t.fireInterrupt() // Ctrl-C mid-run
    }
    await runTui(opts, d)
    expect(cleared).toBe(1)
  })
})

// The approval mode was invisible while a turn ran (the composer's status line is
// gone), and could only be changed for the NEXT turn — so loosening it to get past
// a wall meant interrupting the work you were trying to unblock.
describe('approval mode cycling', () => {
  const done: AgentEvent[] = [{ runId: 'x', type: 'done', stopReason: 'end_turn' }]

  it('cycles least- to most-permissive and wraps back to the safest', () => {
    expect(nextPolicy('plan')).toBe('ask')
    expect(nextPolicy('ask')).toBe('auto-edit')
    expect(nextPolicy('auto-edit')).toBe('full-auto')
    expect(nextPolicy('full-auto')).toBe('plan') // wraps to the most restrictive
  })

  it('shows the mode on the spinner line', () => {
    const paintNo = makePainter(false)
    expect(spinnerFrame(0, 'Working', 3, paintNo, { mode: 'full-auto' })).toContain('[full-auto]')
    expect(spinnerFrame(0, 'Working', 3, paintNo)).not.toContain('[')
  })

  function cycleIo(inputs: Array<string | null>) {
    const base = fakeIo(inputs)
    const cyclers: Array<() => void> = []
    const modes: string[] = []
    base.io.onCycleMode = (h) => cyclers.push(h)
    base.io.setMode = (m) => modes.push(m)
    return { ...base, cycle: () => cyclers.forEach((h) => h()), modes }
  }

  it('reports the mode at startup and on every change', async () => {
    const { d } = deps(done)
    const t = cycleIo(['/approval full-auto', null])
    d.io = t.io
    await runTui(opts, d)
    expect(t.modes[0]).toBe('ask') // the starting policy
    expect(t.modes).toContain('full-auto')
  })

  it('Shift-Tab changes the policy the next turn runs under', async () => {
    const { d, rec } = deps(done)
    const t = cycleIo(['first', 'second', null])
    d.io = t.io
    const start = d.startRun
    let turns = 0
    d.startRun = async (req, send, onMessages) => {
      await start(req, send, onMessages)
      if (++turns === 1) t.cycle() // ask -> auto-edit, between the two turns
    }
    await runTui(opts, d)
    expect(rec.runs[0].policy).toBe('ask')
    expect(rec.runs[1].policy).toBe('auto-edit')
  })

  // The point: unblock the work without killing it.
  it('Shift-Tab mid-run retargets the LIVE run', async () => {
    const { d } = deps(done)
    const t = cycleIo(['go', null])
    d.io = t.io
    const retargeted: Array<[string, string]> = []
    d.setRunPolicy = (runId, policy) => retargeted.push([runId, policy])
    d.startRun = async () => {
      t.cycle() // mid-run
    }
    await runTui(opts, d)
    expect(retargeted).toEqual([['run-1', 'auto-edit']])
    expect(t.text()).toContain('this run too')
  })

  it('does not claim to retarget when no run is in flight', async () => {
    const { d } = deps(done)
    const t = cycleIo([null])
    d.io = t.io
    let calls = 0
    d.setRunPolicy = () => calls++
    t.cycle()
    await runTui(opts, d)
    expect(calls).toBe(0)
    expect(t.text()).not.toContain('this run too')
  })
})

// The terminal shipped three palettes with no light/dark variants, no
// colorblind-safe option, and no persistence — so a theme had to be re-picked on
// every launch, which makes it a party trick rather than a setting.
describe('themes', () => {
  const done: AgentEvent[] = [{ runId: 'x', type: 'done', stopReason: 'end_turn' }]

  it('offers explicit light and dark palettes, and a colorblind-safe one', () => {
    expect(Object.keys(THEMES)).toEqual(
      expect.arrayContaining(['default', 'light', 'dark', 'colorblind', 'mono'])
    )
    // Light must not use the high-intensity yellow, which is unreadable on white.
    expect(THEMES.light.yellow).not.toBe(THEMES.dark.yellow)
    // Colorblind must not rely on red-vs-green, which is the whole point.
    expect(THEMES.colorblind.red).not.toBe(THEMES.default.red)
    expect(THEMES.colorblind.green).not.toBe(THEMES.default.green)
  })

  it('keeps the old name working', () => {
    // `bright` was what `dark` used to be called; a saved setting must not break.
    expect(resolveTheme('bright')).toBe('dark')
    expect(resolveTheme('DARK')).toBe('dark')
    expect(resolveTheme('nonsense')).toBeNull()
  })

  it('persists the choice so it survives a restart', async () => {
    const { d } = deps(done)
    const t = fakeIo(['/theme light', null])
    d.io = t.io
    const patches: Partial<AppSettings>[] = []
    d.updateSettings = (p) => patches.push(p)
    await runTui(opts, d)
    expect(patches).toContainEqual({ tuiTheme: 'light' })
  })

  it('starts in the saved theme', async () => {
    const { d } = deps(done, { tuiTheme: 'mono' })
    const t = fakeIo([null])
    d.io = t.io
    await runTui({ ...opts, color: true }, d)
    // mono emits no color codes, so the banner carries none.
    expect(t.text()).not.toContain('\x1b[36m')
  })

  it('ignores a saved theme that is not one, rather than failing to start', async () => {
    const { d } = deps(done, { tuiTheme: 'from-the-future' })
    const t = fakeIo([null])
    d.io = t.io
    const code = await runTui(opts, d)
    expect(code).toBe(0)
  })
})

// The whole vision path already worked (/image <path> → attachment → provider);
// only getting the bytes out of the clipboard was missing, and the desktop app has
// had that via Electron forever.
describe('/image paste', () => {
  const done: AgentEvent[] = [{ runId: 'x', type: 'done', stopReason: 'end_turn' }]
  const img = { mediaType: 'image/png', data: 'aGk=' }

  it('a bare /image attaches what is on the clipboard', async () => {
    const { d, rec } = deps(done)
    const t = fakeIo(['/image', 'what is this?', null])
    d.io = t.io
    d.clipboardImage = () => ({ image: img })
    await runTui(opts, d)
    expect(t.text()).toContain('attached the image from your clipboard')
    expect(rec.runs[0].messages.at(-1)?.images).toEqual([img])
  })

  it('says what to do when the clipboard has no image', async () => {
    const { d } = deps(done)
    const t = fakeIo(['/image', null])
    d.io = t.io
    d.clipboardImage = () => ({ error: 'no image on the clipboard (install xclip…)' })
    await runTui(opts, d)
    expect(t.text()).toContain('no image on the clipboard')
  })

  it('/image <path> still reads a file', async () => {
    const { d, rec } = deps(done)
    const t = fakeIo(['/image shot.png', 'look', null])
    d.io = t.io
    d.loadImage = () => ({ image: img })
    d.clipboardImage = () => ({ error: 'should not be called' })
    await runTui(opts, d)
    expect(rec.runs[0].messages.at(-1)?.images).toEqual([img])
  })

  it('/paste is the same as a bare /image', async () => {
    const { d } = deps(done)
    const t = fakeIo(['/paste', null])
    d.io = t.io
    let calls = 0
    d.clipboardImage = () => {
      calls++
      return { image: img }
    }
    await runTui(opts, d)
    expect(calls).toBe(1)
  })

  it('respects the attachment cap', async () => {
    const { d } = deps(done)
    const t = fakeIo([...Array(9).fill('/image'), null])
    d.io = t.io
    d.clipboardImage = () => ({ image: img })
    await runTui(opts, d)
    expect(t.text()).toContain('already have 8 images staged')
  })

  it('says so when pasting is unavailable', async () => {
    const { d } = deps(done)
    const t = fakeIo(['/image', null])
    d.io = t.io
    await runTui(opts, d)
    expect(t.text()).toContain('use /image <path>')
  })
})

// /mcp could say a server was connected and how MANY tools it had, never which —
// so "what did I just give the agent?" had no answer short of reading the server's
// own docs. That is the question that decides whether you trust it.
describe('/mcp tools', () => {
  const paintNo = makePainter(false)
  const done: AgentEvent[] = [{ runId: 'x', type: 'done', stopReason: 'end_turn' }]

  it('lists the tools a connected server exposes', () => {
    const out = renderMcpTools(
      'docs',
      { id: 'docs', state: 'connected', tools: 2, toolNames: ['search_docs', 'fetch_page'] },
      paintNo
    )
    expect(out).toContain('docs — 2 tools')
    expect(out).toContain('search_docs')
    expect(out).toContain('fetch_page')
  })

  it('explains each not-connected state instead of showing an empty list', () => {
    expect(renderMcpTools('x', undefined, paintNo)).toContain('has not connected yet')
    expect(renderMcpTools('x', { id: 'x', state: 'needs-auth' }, paintNo)).toContain('/mcp login')
    expect(renderMcpTools('x', { id: 'x', state: 'error', error: 'ECONNREFUSED' }, paintNo)).toContain(
      'ECONNREFUSED'
    )
    expect(renderMcpTools('x', { id: 'x', state: 'connected', tools: 0, toolNames: [] }, paintNo)).toContain(
      'exposes no tools'
    )
  })

  // A server's tool names are remote text on their way to a terminal.
  it('strips escape sequences from a remote tool name', () => {
    const out = renderMcpTools(
      'evil',
      { id: 'evil', state: 'connected', tools: 1, toolNames: ['\x1b]52;c;pwn\x07bad'] },
      paintNo
    )
    expect(out).not.toContain('\x1b')
  })

  it('parses the verb', () => {
    expect(parseSettingsAction('tools 2')).toEqual({ op: 'tools', index: 2 })
    expect(parseSettingsAction('tools')).toEqual({ op: 'usage' })
  })

  it('/mcp tools <n> prints them', async () => {
    const { d } = deps(done, {
      mcpServers: [{ id: 'docs', name: 'docs', transport: 'stdio', command: 'npx', enabled: true }]
    })
    const t = fakeIo(['/mcp tools 1', null])
    d.io = t.io
    d.mcpStatuses = () => [{ id: 'docs', state: 'connected', tools: 1, toolNames: ['search_docs'] }]
    await runTui(opts, d)
    expect(t.text()).toContain('search_docs')
  })

  it('names a bad index rather than throwing', async () => {
    const { d } = deps(done, { mcpServers: [] })
    const t = fakeIo(['/mcp tools 9', null])
    d.io = t.io
    const code = await runTui(opts, d)
    expect(code).toBe(0)
    expect(t.text()).toContain('no MCP server #9')
  })
})

// /hooks and /mcp share one action type, so a verb added for one must not fall
// through unhandled on the other.
describe('/hooks ignores the /mcp-only verbs', () => {
  it('reports usage for tools/login/logout', async () => {
    for (const verb of ['tools 1', 'login 1', 'logout 1']) {
      const { d } = deps([{ runId: 'x', type: 'done', stopReason: 'end_turn' }])
      const t = fakeIo([`/hooks ${verb}`, null])
      d.io = t.io
      const code = await runTui(opts, d)
      expect(code).toBe(0)
      expect(t.text()).toContain('usage: /hooks')
    }
  })
})

// or hand-editing settings.json.
describe('/reasoning', () => {
  const paintNo = makePainter(false)
  const done: AgentEvent[] = [{ runId: 'x', type: 'done', stopReason: 'end_turn' }]

  it('reports the current effort and the options', () => {
    const out = renderReasoningStatus('medium', null, paintNo)
    expect(out).toContain('thinking effort: medium')
    expect(out).toContain('off | low | medium | high | xhigh')
  })

  // Turning thinking up on a model that cannot think looks like a bug in Houston
  // rather than a fact about the model, unless it says so.
  it('says when the active model cannot reason', () => {
    expect(renderReasoningStatus('high', false, paintNo)).toContain('does not support reasoning')
    expect(renderReasoningStatus('high', true, paintNo)).not.toContain('does not support')
  })

  it('shows the current setting with no argument', async () => {
    const { d } = deps(done, { reasoningEffort: 'high' })
    const t = fakeIo(['/reasoning', null])
    d.io = t.io
    await runTui(opts, d)
    expect(t.text()).toContain('thinking effort: high')
  })

  it('sets it, and persists it through the settings the loop reads', async () => {
    const { d } = deps(done)
    const t = fakeIo(['/reasoning high', null])
    d.io = t.io
    const patches: Partial<AppSettings>[] = []
    d.updateSettings = (p) => patches.push(p)
    await runTui(opts, d)
    expect(patches).toContainEqual({ reasoningEffort: 'high' })
    expect(t.text()).toContain('thinking effort → high')
  })

  it('rejects an effort that is not one, rather than storing nonsense', async () => {
    const { d } = deps(done)
    const t = fakeIo(['/reasoning enormous', null])
    d.io = t.io
    const patches: Partial<AppSettings>[] = []
    d.updateSettings = (p) => patches.push(p)
    await runTui(opts, d)
    expect(patches).toHaveLength(0)
    expect(t.text()).toContain('thinking effort:') // fell back to reporting
  })

  it('/think is the same command', async () => {
    const { d } = deps(done)
    const t = fakeIo(['/think low', null])
    d.io = t.io
    const patches: Partial<AppSettings>[] = []
    d.updateSettings = (p) => patches.push(p)
    await runTui(opts, d)
    expect(patches).toContainEqual({ reasoningEffort: 'low' })
  })
})

// Headless has had --continue/--resume since it existed. The terminal had neither,
// so picking up where you left off meant launching and then running /resume — one
// extra step, every time, for the most ordinary thing you do.
describe('--continue / --resume at launch', () => {
  const done: AgentEvent[] = [{ runId: 'x', type: 'done', stopReason: 'end_turn' }]
  const entries = [
    { id: 'newest', title: 'Refactor auth', updatedAt: 200 },
    { id: 'older', title: 'Docs pass', updatedAt: 100 }
  ]

  function persistWith(convs: Record<string, ChatMessage[]>): TuiPersist {
    return {
      create: () => ({ id: 'new' }),
      setMessages: () => {},
      setModel: () => {},
      list: () => entries,
      search: () => entries,
      fork: () => null,
      get: (id) => (convs[id] ? { messages: convs[id] } : null)
    }
  }

  it('parses the flags', () => {
    expect(parseTuiArgs(['-i', '--continue'], '/w')).toMatchObject({ continueSession: true })
    expect(parseTuiArgs(['-i', '--resume', 'abc'], '/w')).toMatchObject({ resumeId: 'abc' })
    expect(parseTuiArgs(['-i'], '/w')?.continueSession).toBeUndefined()
  })

  it('--continue reopens the most recent chat before the first prompt', async () => {
    const { d, rec } = deps(done)
    const t = fakeIo(['keep going', null])
    d.io = t.io
    d.persist = persistWith({ newest: [{ role: 'user', content: 'earlier' }] })
    await runTui({ ...opts, continueSession: true }, d)
    expect(t.text()).toContain('continuing "Refactor auth"')
    // The prior turn is really in context, not just announced.
    expect(rec.runs[0].messages[0].content).toBe('earlier')
  })

  it('--resume opens the named chat, not the newest', async () => {
    const { d, rec } = deps(done)
    const t = fakeIo(['go', null])
    d.io = t.io
    d.persist = persistWith({ older: [{ role: 'user', content: 'from the docs pass' }] })
    await runTui({ ...opts, resumeId: 'older' }, d)
    expect(t.text()).toContain('continuing "Docs pass"')
    expect(rec.runs[0].messages[0].content).toBe('from the docs pass')
  })

  // A named session that isn't there is a mistake worth saying out loud; nothing
  // to continue is just a fresh start.
  it('names a --resume miss, and shrugs at an empty --continue', async () => {
    const { d } = deps(done)
    const t = fakeIo([null])
    d.io = t.io
    d.persist = persistWith({})
    await runTui({ ...opts, resumeId: 'nope' }, d)
    expect(t.text()).toContain('no saved session "nope"')

    const second = deps(done)
    const t2 = fakeIo([null])
    second.d.io = t2.io
    second.d.persist = { ...persistWith({}), list: () => [] }
    await runTui({ ...opts, continueSession: true }, second.d)
    expect(t2.text()).toContain('starting fresh')
  })

  it('starts fresh with neither flag', async () => {
    const { d, rec } = deps(done)
    const t = fakeIo(['hi', null])
    d.io = t.io
    d.persist = persistWith({ newest: [{ role: 'user', content: 'earlier' }] })
    await runTui(opts, d)
    expect(t.text()).not.toContain('continuing')
    expect(rec.runs[0].messages).toHaveLength(1)
  })
})

// Houston already reads AGENTS.md / CLAUDE.md on every run, so standing
// instructions work. What was missing was a way to ADD one without leaving the
// session — so the moment you notice "it should always do X" is exactly the moment
// you are least likely to write it down.
describe('# memory capture', () => {
  const done: AgentEvent[] = [{ runId: 'x', type: 'done', stopReason: 'end_turn' }]

  it('recognizes a note, and only a real one', () => {
    expect(parseMemoryCapture('# always run the linter')).toBe('always run the linter')
    expect(parseMemoryCapture('#always run the linter')).toBe('always run the linter')
    expect(parseMemoryCapture('#')).toBeNull()
    expect(parseMemoryCapture('#   ')).toBeNull()
    expect(parseMemoryCapture('not a # note')).toBeNull()
  })

  it('saves to the project when asked, and says where it went', async () => {
    const { d, rec } = deps(done)
    const t = fakeIo(['# always run the linter', 'p', null])
    d.io = t.io
    const saved: Array<[string, string]> = []
    d.saveMemory = async (scope, text) => {
      saved.push([scope, text])
      return '/w/AGENTS.md'
    }
    await runTui(opts, d)
    expect(saved).toEqual([['project', 'always run the linter']])
    expect(t.text()).toContain('remembered in /w/AGENTS.md')
    expect(rec.runs).toHaveLength(0) // it is not a turn
  })

  it('saves globally when asked', async () => {
    const { d } = deps(done)
    const t = fakeIo(['# prefer tabs', 'e', null])
    d.io = t.io
    const saved: string[] = []
    d.saveMemory = async (scope) => {
      saved.push(scope)
      return '~/.claude/AGENTS.md'
    }
    await runTui(opts, d)
    expect(saved).toEqual(['global'])
  })

  it('does not save when the scope answer is not one', async () => {
    const { d } = deps(done)
    const t = fakeIo(['# something', 'huh', null])
    d.io = t.io
    let calls = 0
    d.saveMemory = async () => {
      calls++
      return 'x'
    }
    await runTui(opts, d)
    expect(calls).toBe(0)
    expect(t.text()).toContain('not remembered')
  })

  it('reports a write failure rather than throwing', async () => {
    const { d } = deps(done)
    const t = fakeIo(['# note', 'p', null])
    d.io = t.io
    d.saveMemory = async () => {
      throw new Error('EACCES')
    }
    const code = await runTui(opts, d)
    expect(code).toBe(0)
    expect(t.text()).toContain("couldn't remember that")
  })

  it('says so when the capture is unavailable', async () => {
    const { d } = deps(done)
    const t = fakeIo(['# note', null])
    d.io = t.io
    await runTui(opts, d)
    expect(t.text()).toContain('unavailable')
  })
})

// The loop knew the model and the cache split all along (it needs both to price a
// round) and dropped them at the event seam, so /cost could only print one number.
describe('/cost breakdown', () => {
  const paintNo = makePainter(false)
  const usage = (over = {}) => ({ inputTokens: 100, outputTokens: 50, cost: 0.01, ...over })

  it('tallies per model, in first-seen order', () => {
    let t = addModelUsage([], usage({ model: 'claude' }))
    t = addModelUsage(t, usage({ model: 'gpt-5', cost: 0.02 }))
    t = addModelUsage(t, usage({ model: 'claude', cost: 0.03 }))
    expect(t.map((x) => x.model)).toEqual(['claude', 'gpt-5'])
    expect(t[0].cost).toBeCloseTo(0.04)
    expect(t[0].inputTokens).toBe(200)
  })

  it('accumulates the cache split', () => {
    let t = addModelUsage([], usage({ model: 'claude', cacheReadTokens: 900, cacheWriteTokens: 100 }))
    t = addModelUsage(t, usage({ model: 'claude', cacheReadTokens: 100 }))
    expect(t[0].cacheReadTokens).toBe(1000)
    expect(t[0].cacheWriteTokens).toBe(100)
  })

  it('labels an event with no model as the session, not a made-up model name', () => {
    const t = addModelUsage([], usage())
    expect(t[0].model).toBe('session')
    expect(t[0].cost).toBeCloseTo(0.01)
  })

  it('shows the cache split, which is most of a long session’s input', () => {
    const out = renderCostReport(
      [{ model: 'claude', inputTokens: 10000, outputTokens: 500, cost: 0.12, cacheReadTokens: 9000, cacheWriteTokens: 200 }],
      paintNo
    )
    expect(out).toContain('claude')
    expect(out).toContain('10,000+500 tok')
    expect(out).toContain('(9,000 cached)')
    expect(out).toContain('(200 cache write)')
    expect(out).toContain('$0.1200')
  })

  it('adds a total only when more than one model billed', () => {
    const one = renderCostReport([{ model: 'a', inputTokens: 1, outputTokens: 1, cost: 1, cacheReadTokens: 0, cacheWriteTokens: 0 }], paintNo)
    expect(one).not.toContain('total')
    const two = renderCostReport(
      [
        { model: 'a', inputTokens: 1, outputTokens: 1, cost: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
        { model: 'b', inputTokens: 2, outputTokens: 2, cost: 2, cacheReadTokens: 0, cacheWriteTokens: 0 }
      ],
      paintNo
    )
    expect(two).toContain('total')
    expect(two).toContain('$3.0000')
  })

  it('says so before anything has been spent', () => {
    expect(renderCostReport([], paintNo)).toContain('nothing spent yet')
  })

  it('/cost reports what the run actually billed, per model', async () => {
    const { d } = deps([
      { runId: 'x', type: 'usage', inputTokens: 1000, outputTokens: 200, cost: 0.05, model: 'claude-sonnet-5', cacheReadTokens: 800 },
      { runId: 'x', type: 'usage', inputTokens: 0, outputTokens: 90, cost: 0.001, model: 'claude-haiku-4-5' },
      { runId: 'x', type: 'done', stopReason: 'end_turn' }
    ])
    const t = fakeIo(['go', '/cost', null])
    d.io = t.io
    await runTui(opts, d)
    const out = t.text()
    expect(out).toContain('claude-sonnet-5')
    expect(out).toContain('claude-haiku-4-5') // the subagent's own model, not folded in
    expect(out).toContain('(800 cached)')
    expect(out).toContain('total')
  })
})

// The composer has been emacs-keyed since it stopped being readline. For anyone
// whose fingers type `dw` when they mean it, that is a tax on every message.
describe('/vim', () => {
  const done: AgentEvent[] = [{ runId: 'x', type: 'done', stopReason: 'end_turn' }]

  it('parses the toggle and its explicit forms', () => {
    const s = {} as AppSettings
    expect(parseSlashCommand('/vim', s)).toEqual({ kind: 'vim' })
    expect(parseSlashCommand('/vim on', s)).toEqual({ kind: 'vim', on: true })
    expect(parseSlashCommand('/vim off', s)).toEqual({ kind: 'vim', on: false })
  })

  it('turns on from off, and back off from on', async () => {
    const { d } = deps(done)
    const t = fakeIo(['/vim', null])
    d.io = t.io
    const patches: Partial<AppSettings>[] = []
    d.updateSettings = (p) => patches.push(p)
    await runTui(opts, d)
    expect(patches).toContainEqual({ tuiEditor: 'vim' })

    const second = deps(done)
    const t2 = fakeIo(['/vim', null])
    second.d.io = t2.io
    const patches2: Partial<AppSettings>[] = []
    second.d.updateSettings = (p) => patches2.push(p)
    const base = second.d.getSettings()
    second.d.getSettings = () => ({ ...base, tuiEditor: 'vim' })
    await runTui(opts, second.d)
    expect(patches2).toContainEqual({ tuiEditor: 'emacs' })
  })

  it('says so rather than pretend when settings cannot be written', async () => {
    const { d } = deps(done)
    const t = fakeIo(['/vim on', null])
    d.io = t.io
    d.updateSettings = undefined
    await runTui(opts, d)
    expect(t.text()).toContain('unavailable')
  })
})
