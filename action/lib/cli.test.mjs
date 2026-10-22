import { describe, expect, it } from 'vitest'
import {
  ALWAYS_DENIED_TOOLS,
  GITHUB_READ_TOOLS,
  budgetInputs,
  cliArgs,
  keyEnvName,
  parseRunOutput,
  parseToolList,
  permissionRules,
  resolveApproval
} from './cli.mjs'

/** The first matching rule wins, as in Houston's matcher (src/main/agent/permissions.ts). */
function verdict(rules, tool) {
  return rules.find((r) => r.tool === '*' || r.tool === tool)?.action ?? null
}

describe('resolveApproval', () => {
  it('defaults to read-only plan for respond and review, auto-edit for fix-ci', () => {
    expect(resolveApproval('respond', '')).toBe('plan')
    expect(resolveApproval('review', 'default')).toBe('plan')
    expect(resolveApproval('fix-ci', '')).toBe('auto-edit')
  })

  it('takes an explicit policy and refuses anything else', () => {
    expect(resolveApproval('review', 'auto-edit')).toBe('auto-edit')
    expect(() => resolveApproval('review', 'yolo')).toThrow(/approval must be one of/)
  })
})

describe('parseToolList', () => {
  it('splits on commas, spaces, and newlines and drops duplicates', () => {
    expect(parseToolList('read_file, grep\nread_file  list_dir')).toEqual(['read_file', 'grep', 'list_dir'])
    expect(parseToolList('')).toEqual([])
  })

  it('refuses something that is not a tool name', () => {
    expect(() => parseToolList('read_file;rm')).toThrow(/not a tool name/)
    expect(() => parseToolList('*')).toThrow(/not a tool name/)
  })
})

describe('permissionRules', () => {
  it('denies the web and GitHub write tools and allows the GitHub reads by default', () => {
    const rules = permissionRules('respond')
    for (const t of ALWAYS_DENIED_TOOLS) expect(verdict(rules, t), t).toBe('deny')
    for (const t of GITHUB_READ_TOOLS) expect(verdict(rules, t), t).toBe('allow')
    // Anything else falls through to the policy, and every prompt is answered with a denial.
    expect(verdict(rules, 'run_shell')).toBeNull()
  })

  it('makes allowed-tools a strict allowlist that keeps the mode tools', () => {
    const rules = permissionRules('review', ['read_file'])
    expect(verdict(rules, 'read_file')).toBe('allow')
    expect(verdict(rules, 'review_changes')).toBe('allow')
    expect(verdict(rules, 'gh_pr_view')).toBe('allow')
    expect(verdict(rules, 'run_shell')).toBe('deny')
    expect(verdict(rules, 'gh_issue_view')).toBe('deny')
    expect(rules.at(-1)).toEqual({ action: 'deny', tool: '*', match: '*' })
  })

  it('never lets allowed-tools reopen a denied tool', () => {
    const rules = permissionRules('fix-ci', ['web_fetch', 'gh_pr_create', 'dispatch_writable_agent'])
    expect(verdict(rules, 'web_fetch')).toBe('deny')
    expect(verdict(rules, 'gh_pr_create')).toBe('deny')
    expect(verdict(rules, 'dispatch_writable_agent')).toBe('deny')
  })
})

describe('cliArgs', () => {
  const base = { cwd: '/w', provider: 'anthropic', model: 'm', approval: 'plan' }

  it('reads the prompt from stdin and always denies approval prompts', () => {
    const args = cliArgs(base)
    expect(args.slice(0, 2)).toEqual(['-p', '-'])
    expect(args).toContain('--json')
    expect(args[args.indexOf('--on-approval') + 1]).toBe('deny')
    expect(args[args.indexOf('--approval') + 1]).toBe('plan')
  })

  it('passes budgets and the verify command as --flag=value', () => {
    const args = cliArgs({ ...base, maxTurns: '30', maxCost: '2', effort: 'high', verify: '-x npm test' })
    expect(args).toEqual(expect.arrayContaining(['--max-turns=30', '--max-cost=2', '--effort=high', '--verify=-x npm test']))
  })

  it('omits what was not set', () => {
    const args = cliArgs({ cwd: '/w', approval: 'full-auto' })
    expect(args.some((a) => /^--(provider|model|max-turns|max-cost|verify|effort)/.test(a))).toBe(false)
  })
})

describe('budgetInputs', () => {
  it('accepts whole turns and positive dollars', () => {
    expect(budgetInputs({ maxTurns: '40', maxCost: '0.5' })).toEqual({ maxTurns: '40', maxCost: '0.5' })
    expect(budgetInputs({ maxTurns: '', maxCost: '' })).toEqual({ maxTurns: undefined, maxCost: undefined })
  })

  it.each([
    [{ maxTurns: '0' }, /max-turns/],
    [{ maxTurns: '1.5' }, /max-turns/],
    [{ maxCost: '-1' }, /max-cost/],
    [{ maxCost: '0' }, /max-cost/],
    [{ maxCost: '1e9' }, /max-cost/]
  ])('refuses %o', (input, err) => {
    expect(() => budgetInputs(input)).toThrow(err)
  })
})

describe('keyEnvName', () => {
  it('matches the CLI naming for custom ids', () => {
    expect(keyEnvName('anthropic')).toBe('HOUSTON_API_KEY_ANTHROPIC')
    expect(keyEnvName('my-gateway')).toBe('HOUSTON_API_KEY_MY_GATEWAY')
  })
})

describe('parseRunOutput', () => {
  it('reads the result line, tools, verification, and errors', () => {
    const out = [
      '{"type":"session","conversationId":"c"}',
      '{"type":"tool_start","name":"read_file"}',
      'not json',
      '{"type":"verification","passed":false}',
      '{"type":"verification","passed":true}',
      '{"type":"error","message":"boom"}',
      '{"type":"result","status":"success","finalText":"done","turns":2,"costUsd":0.1}'
    ].join('\n')
    const r = parseRunOutput(out)
    expect(r.result).toMatchObject({ status: 'success', finalText: 'done' })
    expect(r.tools).toEqual(['read_file'])
    expect(r.verification).toBe(true)
    expect(r.errors).toEqual(['boom'])
  })

  it('reports no result when the run never got that far', () => {
    expect(parseRunOutput('{"type":"text","delta":"x"}').result).toBeNull()
  })
})
