import { describe, it, expect } from 'vitest'
import type { AppSettings, Hook, McpServerConfig, ProviderConfig } from '@shared/types'
import { catalogForPlatform } from '@shared/provider-catalog'
import type { AgentEvent, ChatMessage, PlanDecision } from '@shared/agent'
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
  pickModelFor,
  renderNoModelStatus,
  composerPrompt,
  extractDiff,
  colorizeDiff,
  renderToolResult,
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

  it('applies the bright theme (high-intensity foregrounds)', () => {
    expect(makePainter(true, 'bright')('x', 'cyan')).toContain('\x1b[96m')
  })

  it('mono theme drops color but keeps bold structure', () => {
    const paint = makePainter(true, 'mono')
    expect(paint('x', 'cyan')).toBe('x') // no color code emitted
    expect(paint('x', 'bold')).toContain('\x1b[1m') // structure preserved
  })

  it('isThemeName guards known themes', () => {
    expect(isThemeName('bright')).toBe(true)
    expect(isThemeName('nope')).toBe(false)
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

  it('parses answers, defaulting to deny', () => {
    expect(parseApprovalAnswer('y')).toBe('allow')
    expect(parseApprovalAnswer('YES')).toBe('allow')
    expect(parseApprovalAnswer('allow')).toBe('allow')
    expect(parseApprovalAnswer('a')).toBe('always')
    expect(parseApprovalAnswer('always')).toBe('always')
    expect(parseApprovalAnswer('n')).toBe('deny')
    expect(parseApprovalAnswer('')).toBe('deny')
    expect(parseApprovalAnswer('garbage')).toBe('deny')
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
    expect(parseSlashCommand('/theme bright', s)).toEqual({ kind: 'set-theme', theme: 'bright' })
    expect(parseSlashCommand('/theme mono', s)).toEqual({ kind: 'set-theme', theme: 'mono' })
    expect(parseSlashCommand('/theme bogus', s)).toEqual({ kind: 'handled' })
    expect(parseSlashCommand('/theme', s)).toEqual({ kind: 'handled' })
  })

  it('recognizes /image with a path', () => {
    expect(parseSlashCommand('/image shot.png', s)).toEqual({ kind: 'image', path: 'shot.png' })
    expect(parseSlashCommand('/image', s)).toEqual({ kind: 'handled' }) // no path
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
    cancelRun: (r) => cancels.push(r),
    io: undefined as unknown as TuiIo,
    newId: () => `run-${runs.length + 1}`
  }
  return { d, rec: { runs, approvals, questions, plans, cancels, accepted: () => accepted } }
}

/** An in-memory conversation store standing in for conversations.ts. */
function fakePersist(seed: Array<ResumeEntry & { messages: ChatMessage[] }> = []) {
  const store = new Map<
    string,
    { title: string; updatedAt: number; workspace: string; messages: ChatMessage[] }
  >()
  for (const s of seed) {
    store.set(s.id, { title: s.title, updatedAt: s.updatedAt, workspace: '/proj', messages: s.messages })
  }
  let seq = 0
  const persist: TuiPersist = {
    create: ({ workspace }) => {
      const id = `conv-${++seq}`
      store.set(id, { title: 'New chat', updatedAt: 0, workspace, messages: [] })
      return { id }
    },
    setMessages: (id, messages) => {
      const c = store.get(id)
      if (c) c.messages = messages
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
  return { persist, store }
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
    expect(t.text()).toContain('session: 200+100 tok · $0.0200')
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

  it('reports capability info unavailable without a provider', async () => {
    const { d } = deps([{ runId: 'x', type: 'done', stopReason: 'end_turn' }])
    const t = fakeIo(['/skills', null])
    d.io = t.io
    await runTui(opts, d)
    expect(t.text()).toContain('capability info is unavailable')
  })

  it('plan mode: accepting a plan switches to auto-edit and auto-runs it', async () => {
    const { d, rec } = deps([
      { runId: 'x', type: 'text', delta: 'Here is the plan.' },
      { runId: 'x', type: 'done', stopReason: 'end_turn' }
    ])
    const t = fakeIo(['make a plan', 'y', null]) // prompt, accept, then EOF
    d.io = t.io
    await runTui({ ...opts, approvalPolicy: 'plan' }, d)
    expect(rec.runs).toHaveLength(2)
    expect(rec.runs[0].policy).toBe('plan')
    expect(rec.runs[1].policy).toBe('auto-edit')
    expect(rec.runs[1].messages.at(-1)!.content).toBe('Proceed with the plan you just described.')
  })

  it('plan mode: declining keeps planning and does not re-run', async () => {
    const { d, rec } = deps([
      { runId: 'x', type: 'text', delta: 'A plan.' },
      { runId: 'x', type: 'done', stopReason: 'end_turn' }
    ])
    const t = fakeIo(['plan it', 'n', null])
    d.io = t.io
    await runTui({ ...opts, approvalPolicy: 'plan' }, d)
    expect(rec.runs).toHaveLength(1)
    expect(rec.runs[0].policy).toBe('plan')
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
    // The confirmation line is painted with the bright palette.
    expect(t.text()).toContain('theme → bright')
  })

  it('/theme with no arg lists the available themes', async () => {
    const { d } = deps([{ runId: 'x', type: 'done', stopReason: 'end_turn' }])
    const t = fakeIo(['/theme', null])
    d.io = t.io
    await runTui(opts, d)
    expect(t.text()).toContain('default, bright, mono')
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
    // command line, then: name, command, args, confirm, EOF
    const t = fakeIo(['/mcp add', 'files', 'npx', '-y @scope/fs .', 'y', null])
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
      { runId: 'x', type: 'done', stopReason: 'end_turn' }
    ])
    d.io = fakeIo(['go', 'y', '1', 'r', null]).io
    await runTui(opts, d)
    expect(rec.approvals).toHaveLength(1)
    expect(rec.questions).toHaveLength(1)
    expect(rec.plans).toEqual([['run-1', 'p1', { kind: 'reject' }]])
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

  it('pickModelFor prefers defaultModel, then the first model, else null', () => {
    expect(pickModelFor({ defaultModel: 'd', models: [{ id: 'a' }] } as never)).toBe('d')
    expect(pickModelFor({ models: [{ id: 'a' }] } as never)).toBe('a')
    expect(pickModelFor({ models: [] } as never)).toBeNull()
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
    const out = renderNoModelStatus('ask', '/proj', makePainter(false))
    expect(out).toContain('/login')
    expect(out).toContain('ask')
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
