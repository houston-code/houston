import { describe, expect, it } from 'vitest'
import type { BranchSync, GitActionResult, PrLookup, PrStatus } from '@shared/gitActions'
import { chooseShipAction } from '@shared/shipAction'
import type { WorkingTreeChanges } from '@shared/workingTree'
import { makePainter } from './tui'
import { canPush, parseGitCommand, renderPr, runGitCommand, type GitContext, type GitDeps } from './tui-git'

const paint = makePainter(false)

const tree = (over: Partial<WorkingTreeChanges> = {}): WorkingTreeChanges => ({
  isRepo: true,
  branch: 'feat/x',
  files: [{ path: 'a.ts', status: 'modified', hunks: [], added: 2, removed: 1, binary: false }],
  added: 2,
  removed: 1,
  ship: { hasCommits: true, remote: { name: 'origin', host: 'github' } },
  ...over
})
const sync = (over: Partial<BranchSync> = {}): BranchSync => ({
  branch: 'feat/x',
  upstream: 'origin/feat/x',
  ahead: 1,
  remote: 'origin',
  ...over
})

function harness(over: Partial<GitDeps> = {}, answers: Array<string | null> = []) {
  const calls: string[] = []
  const commits: string[] = []
  const deps: GitDeps = {
    tree: async () => tree(),
    sync: async () => sync(),
    suggest: async () => (calls.push('suggest'), { ok: true, detail: 'Add the thing' }),
    commit: async (m): Promise<GitActionResult> => (commits.push(m), { ok: true, detail: 'abc1234' }),
    push: async () => (calls.push('push'), { ok: true, detail: 'origin/feat/x' }),
    pr: async () => ({ kind: 'none' }),
    ...over
  }
  const out: string[] = []
  const asked: string[] = []
  const ctx: GitContext = {
    deps,
    conversationId: 'c1',
    out: (t) => out.push(t),
    ask: async (p) => (asked.push(p), answers.shift() ?? null),
    paint
  }
  return { ctx, calls, commits, asked, text: () => out.join('') }
}

describe('parseGitCommand', () => {
  it('reads the four commands and keeps the whole commit message', () => {
    expect(parseGitCommand('commit', '  Fix the  parser ')).toEqual({ op: 'commit', message: 'Fix the  parser' })
    expect(parseGitCommand('commit', '')).toEqual({ op: 'commit', message: '' })
    expect(parseGitCommand('push', 'whatever')).toEqual({ op: 'push' })
    expect(parseGitCommand('ship', '')).toEqual({ op: 'ship' })
    expect(parseGitCommand('pr', '')).toEqual({ op: 'pr' })
    expect(parseGitCommand('review', '')).toBeNull()
  })
})

describe('/commit', () => {
  it('commits the given message only after a yes', async () => {
    const h = harness({}, ['y'])
    await runGitCommand({ op: 'commit', message: 'Fix it' }, h.ctx)
    expect(h.calls).not.toContain('suggest')
    expect(h.text()).toContain('M a.ts')
    expect(h.text()).toContain('Fix it')
    expect(h.asked[0]).toContain('[y/N]')
    expect(h.commits).toEqual(['Fix it'])
    expect(h.text()).toContain('committed abc1234 on feat/x; /push sends it')
  })

  it('a declined or cut-off answer commits nothing', async () => {
    for (const answer of ['n', '', 'sure', null]) {
      const h = harness({}, [answer])
      await runGitCommand({ op: 'commit', message: 'Fix it' }, h.ctx)
      expect(h.commits).toEqual([])
      expect(h.text()).toContain('not committed')
    }
  })

  it("asks the chat's model for a message when none is given, then still confirms", async () => {
    const seen: Array<string | null> = []
    const h = harness({ suggest: async (id) => (seen.push(id), { ok: true, detail: 'Add the thing\n\nWith a body.' }) }, ['n'])
    await runGitCommand({ op: 'commit', message: '' }, h.ctx)
    expect(seen).toEqual(['c1'])
    expect(h.text()).toContain('Add the thing')
    expect(h.text()).toContain('With a body.')
    expect(h.commits).toEqual([])
  })

  it('says why a suggestion failed and commits nothing', async () => {
    const h = harness({ suggest: async () => ({ ok: false, error: 'Choose a model first.' }) }, ['y'])
    await runGitCommand({ op: 'commit', message: '' }, h.ctx)
    expect(h.text()).toContain('Choose a model first.')
    expect(h.text()).toContain('/commit <message>')
    expect(h.asked).toEqual([])
    expect(h.commits).toEqual([])
  })

  it("reports the handler's refusal (a risky repository config, a merge in progress)", async () => {
    const error = "This repository's own git config sets core.sshcommand, which can run a command, so Houston won't commit or push here."
    const h = harness({ commit: async () => ({ ok: false, error }) }, ['y'])
    await runGitCommand({ op: 'commit', message: 'Fix it' }, h.ctx)
    expect(h.text()).toContain(error)
    expect(h.text()).not.toContain('committed')
  })

  it('has nothing to commit in a clean tree or outside a repository', async () => {
    const clean = harness({ tree: async () => tree({ files: [], added: 0, removed: 0 }) })
    await runGitCommand({ op: 'commit', message: 'x' }, clean.ctx)
    expect(clean.text()).toContain('nothing to commit; 1 commit not pushed yet')
    const none = harness({ tree: async () => tree({ isRepo: false, files: [] }) })
    await runGitCommand({ op: 'commit', message: 'x' }, none.ctx)
    expect(none.text()).toContain('not a git repository')
    expect(clean.asked).toEqual([])
  })

  it('never passes escape sequences from the message or paths to the terminal', async () => {
    const h = harness(
      { tree: async () => tree({ files: [{ path: 'a\u001b[2J.ts', status: 'modified', hunks: [], added: 1, removed: 0, binary: false }] }) },
      ['n']
    )
    await runGitCommand({ op: 'commit', message: 'Fix \u001b]0;pwned\u0007it' }, h.ctx)
    expect(h.text()).not.toContain('\u001b[2J')
    expect(h.text()).not.toContain('\u001b]0;')
  })
})

describe('/push', () => {
  it('pushes when the branch is ahead, and says where', async () => {
    const h = harness()
    await runGitCommand({ op: 'push' }, h.ctx)
    expect(h.calls).toEqual(['push'])
    expect(h.text()).toContain('pushed to origin/feat/x')
  })

  it('publishes a branch with no upstream', async () => {
    const h = harness({ sync: async () => sync({ upstream: null, ahead: 2 }) })
    await runGitCommand({ op: 'push' }, h.ctx)
    expect(h.text()).toContain('origin (first push)')
  })

  it('pushes nothing when there is nothing to push or nowhere to push it', async () => {
    for (const s of [sync({ ahead: 0 }), sync({ branch: null }), sync({ upstream: null, remote: null }), null]) {
      const h = harness({ sync: async () => s })
      await runGitCommand({ op: 'push' }, h.ctx)
      expect(h.calls).toEqual([])
    }
  })

  it('reports a refused push', async () => {
    const h = harness({ push: async () => ({ ok: false, error: "Houston won't push to origin: its URL is a folder on this computer." }) })
    await runGitCommand({ op: 'push' }, h.ctx)
    expect(h.text()).toContain("won't push to origin")
  })

  it('agrees with the desktop on when Push is offered', () => {
    expect(canPush(sync())).toBe(true)
    expect(canPush(sync({ ahead: 0 }))).toBe(false)
    expect(canPush(sync({ upstream: null, remote: null }))).toBe(false)
    expect(canPush(null)).toBe(false)
  })
})

describe('/ship', () => {
  it("returns the Changes view's ship request as an invoked turn", async () => {
    const h = harness()
    const turn = await runGitCommand({ op: 'ship' }, h.ctx)
    const action = chooseShipAction(tree().ship)
    expect(turn).toEqual({ text: action.prompt, invokedAs: { kind: 'action', label: 'Create PR', detail: action.hint } })
  })

  it('follows the repository: publish with no remote, push to a non-GitHub one', async () => {
    const pub = await runGitCommand({ op: 'ship' }, harness({ tree: async () => tree({ ship: { hasCommits: true, remote: null } }) }).ctx)
    expect(pub?.invokedAs.label).toBe('Publish to GitHub')
    const other = await runGitCommand(
      { op: 'ship' },
      harness({ tree: async () => tree({ ship: { hasCommits: true, remote: { name: 'origin', host: 'other' } } }) }).ctx
    )
    expect(other?.invokedAs.label).toBe('Commit & push')
  })

  it('sends nothing with no changes or outside a repository', async () => {
    const clean = harness({ tree: async () => tree({ files: [] }) })
    expect(await runGitCommand({ op: 'ship' }, clean.ctx)).toBeNull()
    expect(clean.text()).toContain('no uncommitted changes')
    expect(await runGitCommand({ op: 'ship' }, harness({ tree: async () => tree({ isRepo: false }) }).ctx)).toBeNull()
  })
})

describe('/pr', () => {
  const status: PrStatus = {
    number: 42,
    title: 'Add a \u001b[31mthing',
    state: 'OPEN',
    isDraft: false,
    url: 'https://github.com/o/r/pull/42',
    checks: 'failing',
    counts: { passing: 1, failing: 1, pending: 1 },
    runs: [
      { name: 'lint', outcome: 'passing' },
      { name: 'test', outcome: 'pending' },
      { name: 'build', outcome: 'failing' }
    ]
  }
  const pr: PrLookup = { kind: 'pr', pr: status }

  it('shows the state, the link, the counts, and each check failing first', () => {
    const out = renderPr(pr, paint, 'feat/x')
    expect(out).toContain('Pull request #42 (open)')
    expect(out).toContain('https://github.com/o/r/pull/42')
    expect(out).toContain('Checks: 1 failing, 1 running, 1 passed')
    expect(out.indexOf('build')).toBeLessThan(out.indexOf('test'))
    expect(out.indexOf('test')).toBeLessThan(out.indexOf('lint'))
    expect(out).not.toContain('\u001b[31m')
  })

  it('says draft, and explains a missing PR or a missing gh', () => {
    expect(renderPr({ kind: 'pr', pr: { ...status, isDraft: true } }, paint, null)).toContain('(draft)')
    expect(renderPr({ kind: 'none' }, paint, 'feat/x')).toContain('no pull request for feat/x yet; /ship opens one')
    expect(renderPr({ kind: 'unavailable' }, paint, null)).toContain('gh command')
  })

  it('runs the lookup', async () => {
    const h = harness({ pr: async () => pr })
    expect(await runGitCommand({ op: 'pr' }, h.ctx)).toBeNull()
    expect(h.text()).toContain('#42')
  })
})

it('says so when the git commands are unavailable', async () => {
  const h = harness()
  h.ctx.deps = undefined
  await runGitCommand({ op: 'push' }, h.ctx)
  expect(h.text()).toContain('unavailable')
})
