import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import { exec as realExec } from './exec.mjs'
import { profileDir, run } from './run.mjs'

const REPO = 'acme/widgets'
const NODE = 'fake-node'
const CLI = '/opt/houston/houston-cli.cjs'
const API_KEY = 'sk-test-0123456789abcdef'
const GH_TOKEN = 'ghs_test0123456789abcdef'

const gitIn = (dir) => (...a) =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...a], { cwd: dir, encoding: 'utf8' }).trim()

// Built once per file and copied for each world: a fresh repository costs seven git spawns,
// which on Windows runners is most of a test's time and all of its exposure to a slow runner.
let template
beforeAll(() => {
  const dir = mkdtempSync(join(tmpdir(), 'h-run-template-'))
  const git = gitIn(dir)
  git('init', '--quiet', '--initial-branch=main')
  // Every commit otherwise spawns a detached `git maintenance run --auto`, which creates and
  // removes .git/objects/maintenance.lock after the commit returns. A copy taken while it
  // runs lists the lock, then fails to copy it once it is gone (ENOENT on .git/objects).
  git('config', 'maintenance.auto', 'false')
  writeFileSync(join(dir, 'app.js'), 'bug\n')
  git('add', '.')
  git('commit', '--quiet', '-m', 'base')
  const base = git('rev-parse', 'HEAD')
  git('switch', '--quiet', '--create', 'feature')
  writeFileSync(join(dir, 'app.js'), 'still a bug\n')
  git('commit', '--quiet', '-am', 'head')
  template = { dir, base, head: git('rev-parse', 'HEAD') }
}, 30_000)

/** A private copy of the template checkout (on `feature`, one commit past `main`). */
function gitRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'h-run-'))
  cpSync(template.dir, dir, { recursive: true, preserveTimestamps: true })
  return { dir, base: template.base, head: template.head, git: gitIn(dir) }
}

function resultLine(o = {}) {
  return [
    '{"type":"tool_start","name":"gh_issue_view"}',
    JSON.stringify({ type: 'result', status: 'success', stopReason: 'end_turn', turns: 3, costUsd: 0.25, finalText: 'Here is the answer.', ...o })
  ].join('\n')
}

/**
 * A world for one run: a real git checkout, an event file, and a fake `exec` that plays
 * the CLI (`onCli` can change the checkout mid-run) and gh, while git runs for real except
 * `push`, which is only recorded.
 */
function world({ eventName, event, inputs = {}, cliOut = resultLine(), onCli, permission = 'write', repo = gitRepo() }) {
  const temp = mkdtempSync(join(tmpdir(), 'h-runner-'))
  const eventPath = join(temp, 'event.json')
  writeFileSync(eventPath, JSON.stringify(typeof event === 'function' ? event(repo) : event))
  const env = {
    GITHUB_EVENT_NAME: eventName,
    GITHUB_EVENT_PATH: eventPath,
    GITHUB_REPOSITORY: REPO,
    GITHUB_WORKSPACE: repo.dir,
    GITHUB_RUN_ID: '9',
    GITHUB_OUTPUT: join(temp, 'output'),
    RUNNER_TEMP: temp,
    HOUSTON_CLI_PATH: CLI,
    HOUSTON_NODE: NODE,
    HOUSTON_ACTION_API_KEY: API_KEY,
    GH_TOKEN,
    ...Object.fromEntries(Object.entries(inputs).map(([k, v]) => [`HOUSTON_INPUT_${k.toUpperCase().replace(/-/g, '_')}`, v]))
  }
  const calls = []
  const exec = async (cmd, args, opts = {}) => {
    calls.push({ cmd, args, opts })
    if (cmd === NODE && args[0] === CLI) {
      if (args[1] === 'providers') {
        return args[2] === 'list'
          ? { code: 0, stdout: 'Configured providers:\n  anthropic      key set      4 models\n\nAvailable to add\n  groq x\n', stderr: '' }
          : { code: 0, stdout: 'Added.\n', stderr: '' }
      }
      onCli?.(repo, opts)
      return { code: 0, stdout: cliOut, stderr: '' }
    }
    if (cmd === 'gh') {
      if (args[0] === 'api' && args[1].endsWith('/permission')) return { code: 0, stdout: `${permission}\n`, stderr: '' }
      if (args[0] === 'issue' && args[1] === 'comment') return { code: 0, stdout: 'https://github.com/acme/widgets/issues/12#c1\n', stderr: '' }
      if (args[0] === 'pr' && args[1] === 'create') return { code: 0, stdout: 'https://github.com/acme/widgets/pull/13\n', stderr: '' }
      return { code: 0, stdout: '', stderr: '' }
    }
    if (cmd === 'git' && args.includes('push')) return { code: 0, stdout: '', stderr: '' }
    if (cmd === 'git') return realExec(cmd, args, opts)
    return { code: 1, stdout: '', stderr: `${cmd} is not available` }
  }
  const logs = []
  const go = () => run({ env, exec, log: (s) => logs.push(s), tempDirs: [] })
  const outputs = () => (existsSync(env.GITHUB_OUTPUT) ? readFileSync(env.GITHUB_OUTPUT, 'utf8') : '')
  const cliCall = () => calls.find((c) => c.cmd === NODE && c.args[1] !== 'providers')
  const gh = (a, b) => calls.filter((c) => c.cmd === 'gh' && c.args[0] === a && c.args[1] === b)
  return { env, calls, logs, go, outputs, cliCall, gh, repo, temp }
}

const mention = (comment = {}) => ({
  action: 'created',
  issue: { number: 12 },
  comment: { id: 5, body: '@houston why?', author_association: 'MEMBER', user: { login: 'dana', type: 'User' }, ...comment }
})

describe('respond', () => {
  it('runs the CLI read-only with the key in its env, then posts the reply', async () => {
    const w = world({ eventName: 'issue_comment', event: mention() })
    expect(await w.go()).toBe(0)
    const cli = w.cliCall()
    expect(cli.args).toEqual(expect.arrayContaining(['-p', '-', '--approval', 'plan', '--on-approval', 'deny', '--provider', 'anthropic']))
    expect(cli.opts.input).toContain('@houston why?')
    expect(cli.args.join(' ')).not.toContain('@houston why?')
    expect(cli.opts.env.HOUSTON_API_KEY_ANTHROPIC).toBe(API_KEY)
    expect(cli.opts.env.HOUSTON_ACTION_API_KEY).toBeUndefined()
    expect(Object.keys(cli.opts.env).some((k) => k.startsWith('HOUSTON_INPUT_'))).toBe(false)
    // The CLI's gh tools act only on a repository they can pin to; this is the event's.
    expect(cli.opts.env.GH_REPO).toBe(REPO)
    const settings = JSON.parse(readFileSync(join(cli.opts.env.HOUSTON_DATA_DIR, 'settings.json'), 'utf8'))
    expect(settings.permissionRules.find((r) => r.tool === 'web_fetch')).toEqual({ action: 'deny', tool: 'web_fetch', match: '*' })
    expect(w.logs).toContain(`::add-mask::${API_KEY}`)

    const [post] = w.gh('issue', 'comment')
    expect(post.args).toEqual(['issue', 'comment', '12', '--repo', REPO, '--body-file', expect.any(String)])
    const body = readFileSync(post.args.at(-1), 'utf8')
    expect(body).toMatch(/^Here is the answer\./)
    expect(body).toContain('https://github.com/acme/widgets/actions/runs/9')
    expect(w.outputs()).toMatch(/status<<.*\nsuccess\n/)
    expect(w.outputs()).toContain('https://github.com/acme/widgets/issues/12#c1')
  })

  it('skips a commenter whose real permission is read, without running anything', async () => {
    const w = world({ eventName: 'issue_comment', event: mention(), permission: 'read' })
    expect(await w.go()).toBe(0)
    expect(w.cliCall()).toBeUndefined()
    expect(w.outputs()).toMatch(/skipped<<.*\ntrue\n/)
  })

  it("answers an Enterprise Managed User, whose login has a _shortcode suffix", async () => {
    const w = world({ eventName: 'issue_comment', event: mention({ user: { login: 'mona-cat_octo', type: 'User' } }) })
    expect(await w.go()).toBe(0)
    const [check] = w.calls.filter((c) => c.cmd === 'gh' && c.args[0] === 'api')
    expect(check.args[1]).toBe(`repos/${REPO}/collaborators/mona-cat_octo/permission`)
    expect(w.cliCall()).toBeDefined()
    expect(w.gh('issue', 'comment')).toHaveLength(1)
  })

  it('fails on a login that could change the permission API path, without running', async () => {
    const w = world({ eventName: 'issue_comment', event: mention({ user: { login: 'a/../../x', type: 'User' } }) })
    expect(await w.go()).toBe(1)
    expect(w.calls).toEqual([])
  })

  it('skips an outsider before any gh call', async () => {
    const w = world({ eventName: 'issue_comment', event: mention({ author_association: 'CONTRIBUTOR' }) })
    expect(await w.go()).toBe(0)
    expect(w.calls).toEqual([])
  })

  it('refuses to post a reply that carries a credential', async () => {
    const w = world({ eventName: 'issue_comment', event: mention(), cliOut: resultLine({ finalText: `the key is ${API_KEY}` }) })
    expect(await w.go()).toBe(1)
    expect(w.gh('issue', 'comment')).toEqual([])
    expect(w.logs.join('\n')).toMatch(/contains a credential/)
  })

  it('posts a short note and fails when the run errors', async () => {
    const w = world({ eventName: 'issue_comment', event: mention(), cliOut: resultLine({ status: 'error', finalText: '' }) })
    expect(await w.go()).toBe(1)
    const body = readFileSync(w.gh('issue', 'comment')[0].args.at(-1), 'utf8')
    expect(body).toMatch(/^@dana Houston could not finish this request \(error\)/)
  })

  it('writes to the job summary instead of posting when post is false', async () => {
    const w = world({ eventName: 'issue_comment', event: mention(), inputs: { post: 'false' } })
    w.env.GITHUB_STEP_SUMMARY = join(w.temp, 'summary.md')
    expect(await w.go()).toBe(0)
    expect(w.gh('issue', 'comment')).toEqual([])
    expect(readFileSync(w.env.GITHUB_STEP_SUMMARY, 'utf8')).toContain('Here is the answer.')
  })

  it('fails when the CLI prints no result line', async () => {
    const w = world({ eventName: 'issue_comment', event: mention(), cliOut: '{"type":"error","message":"no key"}' })
    expect(await w.go()).toBe(1)
    expect(w.logs.join('\n')).toMatch(/without a result: no key/)
  })
})

describe('review', () => {
  const pr = (baseSha) => ({
    action: 'opened',
    pull_request: { number: 4, base: { sha: baseSha }, head: { sha: 'b'.repeat(40), repo: { full_name: REPO } } }
  })

  it('posts one comment review', async () => {
    const w = world({ eventName: 'pull_request', event: (r) => pr(r.base) })
    expect(await w.go()).toBe(0)
    expect(w.cliCall().opts.input).toContain('review_changes with base')
    const [review] = w.gh('pr', 'review')
    expect(review.args.slice(0, 6)).toEqual(['pr', 'review', '4', '--repo', REPO, '--comment'])
  })

  it('stops before running when the base commit is not checked out', async () => {
    const w = world({ eventName: 'pull_request', event: pr('d'.repeat(40)) })
    expect(await w.go()).toBe(1)
    expect(w.cliCall()).toBeUndefined()
    expect(w.logs.join('\n')).toMatch(/fetch-depth: 0/)
  })
})

// Each run here makes real commits (status, add, commit, switch, then the checks' own git
// calls): around 1s on a Windows runner, and a busy runner has stretched that past 5s.
describe('fix-ci', { timeout: 30_000 }, () => {
  const failed = (r, o = {}) => ({
    action: 'completed',
    repository: { default_branch: 'main' },
    workflow_run: {
      id: 321,
      run_attempt: 1,
      conclusion: 'failure',
      head_branch: 'feature',
      head_sha: r.head,
      html_url: 'https://github.com/acme/widgets/actions/runs/321',
      head_repository: { full_name: REPO },
      ...o
    }
  })
  const fix = (r) => writeFileSync(join(r.dir, 'app.js'), 'fixed\n')

  it('commits the fix on a new branch, pushes it with the token in the env only, and opens a PR', async () => {
    const w = world({ eventName: 'workflow_run', event: failed, onCli: fix })
    expect(await w.go()).toBe(0)
    expect(w.cliCall().args).toEqual(expect.arrayContaining(['--approval', 'auto-edit', '--on-approval', 'deny']))

    const { git } = w.repo
    expect(git('rev-parse', '--abbrev-ref', 'HEAD')).toBe('houston/fix-ci-321-1')
    expect(git('show', 'houston/fix-ci-321-1:app.js')).toBe('fixed')
    expect(git('show', 'feature:app.js')).toBe('still a bug')
    expect(git('log', '-1', '--format=%an')).toBe('github-actions[bot]')

    const push = w.calls.find((c) => c.cmd === 'git' && c.args.includes('push'))
    expect(push.args).toEqual(expect.arrayContaining(['-c', 'core.hooksPath=/dev/null', 'push', '--no-verify', 'https://github.com/acme/widgets.git', 'HEAD:refs/heads/houston/fix-ci-321-1']))
    expect(push.args.join(' ')).not.toContain(GH_TOKEN)
    expect(push.opts.env.GIT_CONFIG_KEY_0).toBe('http.https://github.com/.extraheader')
    expect(Buffer.from(push.opts.env.GIT_CONFIG_VALUE_0.split(' ').pop(), 'base64').toString()).toBe(`x-access-token:${GH_TOKEN}`)
    expect(w.logs).toContain(`::add-mask::${push.opts.env.GIT_CONFIG_VALUE_0.split(' ').pop()}`)

    const [create] = w.gh('pr', 'create')
    expect(create.args).toEqual(expect.arrayContaining(['--base=feature', '--head=houston/fix-ci-321-1']))
    expect(create.args).not.toContain('--draft')
    expect(readFileSync(create.args[create.args.indexOf('--body-file') + 1], 'utf8')).toContain('Verification: not run')
  })

  it('opens a draft when the final verification failed', async () => {
    const out = ['{"type":"verification","passed":false}', resultLine()].join('\n')
    const w = world({ eventName: 'workflow_run', event: failed, onCli: fix, cliOut: out })
    expect(await w.go()).toBe(0)
    expect(w.gh('pr', 'create')[0].args).toContain('--draft')
  })

  it('opens a draft when the CLI reports the last verification still failing', async () => {
    const out = ['{"type":"verification","passed":false}', resultLine({ status: 'verify_failed' })].join('\n')
    const w = world({ eventName: 'workflow_run', event: failed, onCli: fix, cliOut: out })
    expect(await w.go()).toBe(0)
    expect(w.gh('pr', 'create')[0].args).toContain('--draft')
  })

  it('refuses to commit when the run rewrote .git/config', async () => {
    const w = world({
      eventName: 'workflow_run',
      event: failed,
      onCli: (r) => {
        fix(r)
        r.git('config', 'core.sshCommand', 'curl evil')
      }
    })
    expect(await w.go()).toBe(1)
    expect(w.logs.join('\n')).toMatch(/changed \.git\/config/)
    expect(w.calls.some((c) => c.cmd === 'git' && c.args.includes('commit'))).toBe(false)
    expect(w.gh('pr', 'create')).toEqual([])
  })

  it('refuses to commit a change that carries a credential', async () => {
    const w = world({ eventName: 'workflow_run', event: failed, onCli: (r) => writeFileSync(join(r.dir, 'leak.txt'), API_KEY) })
    expect(await w.go()).toBe(1)
    expect(w.logs.join('\n')).toMatch(/contains a credential/)
    expect(w.calls.some((c) => c.cmd === 'git' && c.args.includes('push'))).toBe(false)
  })

  it('opens nothing when the run changed nothing', async () => {
    const w = world({ eventName: 'workflow_run', event: failed })
    expect(await w.go()).toBe(0)
    expect(w.calls.some((c) => c.cmd === 'git' && c.args.includes('push'))).toBe(false)
    expect(w.logs.join('\n')).toMatch(/made no changes/)
  })

  it('opens nothing after a failed run', async () => {
    const w = world({ eventName: 'workflow_run', event: failed, onCli: fix, cliOut: resultLine({ status: 'stalled' }) })
    expect(await w.go()).toBe(1)
    expect(w.gh('pr', 'create')).toEqual([])
  })

  it('stops when the checkout is not the failed commit', async () => {
    const w = world({ eventName: 'workflow_run', event: (r) => failed(r, { head_sha: r.base }) })
    expect(await w.go()).toBe(1)
    expect(w.cliCall()).toBeUndefined()
  })

  it('warns, and keeps going, when the shell sandbox is unavailable on Linux', async () => {
    const w = world({ eventName: 'workflow_run', event: failed })
    await w.go()
    if (process.platform === 'linux') expect(w.logs.join('\n')).toMatch(/refuse every shell command/)
    expect(w.cliCall()).toBeDefined()
  })
})

describe('refusals', () => {
  it('fails on pull_request_target without running anything', async () => {
    const w = world({ eventName: 'pull_request_target', event: { action: 'opened' }, inputs: { mode: 'review' } })
    expect(await w.go()).toBe(1)
    expect(w.calls).toEqual([])
    expect(w.logs.join('\n')).toMatch(/does not run on pull_request_target/)
  })

  it('fails on a bad input before any call', async () => {
    const w = world({ eventName: 'issue_comment', event: mention(), inputs: { approval: 'yolo' } })
    expect(await w.go()).toBe(1)
    expect(w.calls).toEqual([])
  })

  it('fails on an event with no mode', async () => {
    const w = world({ eventName: 'push', event: {} })
    expect(await w.go()).toBe(1)
  })
})

describe('profileDir', () => {
  it('refuses a profile inside the workspace or a sandbox-writable temp dir', () => {
    const ws = mkdtempSync(join(tmpdir(), 'h-ws-'))
    expect(() => profileDir({ RUNNER_TEMP: join(ws, 'tmp') }, ws, [])).toThrow(/inside the workspace/)
    const temp = mkdtempSync(join(tmpdir(), 'h-t-'))
    expect(() => profileDir({ RUNNER_TEMP: temp }, ws, [tmpdir()])).toThrow(/temp dir/)
    expect(profileDir({ RUNNER_TEMP: temp }, ws, [])).toContain('houston-profile-')
  })
})
