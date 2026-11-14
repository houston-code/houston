// One action run: read the event, decide whether it may start Houston, run the verified
// CLI once with a private profile, then post the reply, the review, or the fix pull
// request. Every side effect goes through the injected `exec`, so tests drive the whole
// flow with a fake CLI and a fake `gh`.

import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join, relative, resolve, isAbsolute } from 'node:path'
import { WRITE_MODES, buildContext, defaultMode, isSha, isValidLabel, isValidTrigger } from './event.mjs'
import { buildPrompt } from './prompt.mjs'
import {
  budgetInputs,
  cliArgs,
  isValidProviderId,
  keyEnvName,
  parseRunOutput,
  parseToolList,
  permissionRules,
  resolveApproval
} from './cli.mjs'
import {
  SAFE_GIT,
  assertPushTarget,
  capBody,
  changedControlFiles,
  containsSecret,
  fixBranchName,
  implementBranchName,
  logSafe,
  secretValues,
  snapshotGitControl
} from './guard.mjs'
import {
  createPullRequest,
  hasWriteAccess,
  listReviewComments,
  postIssueComment,
  postReview,
  postReviewWithComments,
  replyToReviewComment
} from './github.mjs'
import { commentableLines, inlineComments, postedKeys } from './review.mjs'

const EFFORTS = ['off', 'low', 'medium', 'high', 'xhigh']
const BOT_NAME = 'github-actions[bot]'
const BOT_EMAIL = '41898282+github-actions[bot]@users.noreply.github.com'

/** Read one action input, passed by action.yml as `HOUSTON_INPUT_<NAME>`. */
function inputFrom(env) {
  return (name) => (env[`HOUSTON_INPUT_${name.toUpperCase().replace(/-/g, '_')}`] ?? '').trim()
}

/** Is `child` inside (or equal to) `parent`? */
function within(parent, child) {
  const rel = relative(resolve(parent), resolve(child))
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

/**
 * The run's private Houston profile. It must sit outside the checkout (the agent's file
 * tools reach that) and outside the temp dirs (the shell sandbox can write those), or the
 * run could rewrite its own permission rules.
 */
export function profileDir(env, workspace, temps = [tmpdir(), '/tmp', env.TMPDIR].filter(Boolean)) {
  const base = env.RUNNER_TEMP && isAbsolute(env.RUNNER_TEMP) ? env.RUNNER_TEMP : join(homedir(), '.houston-action')
  if (within(workspace, base) || temps.some((t) => within(t, base))) {
    throw new Error(`cannot place Houston's profile in ${base}: it is inside the workspace or a temp dir the agent can write`)
  }
  mkdirSync(base, { recursive: true })
  return mkdtempSync(join(base, 'houston-profile-'))
}

/** `GITHUB_OUTPUT`-style writer; heredoc syntax so a value can never smuggle a second output. */
function outputWriter(env) {
  return (name, value) => {
    if (!env.GITHUB_OUTPUT) return
    const delim = `houston_${Math.random().toString(36).slice(2)}_eof`
    appendFileSync(env.GITHUB_OUTPUT, `${name}<<${delim}\n${String(value)}\n${delim}\n`)
  }
}

/**
 * `tempDirs` are the directories the shell sandbox can write, which the profile must stay
 * out of; tests pass their own.
 */
export async function run({ env, exec, log = (s) => process.stdout.write(`${s}\n`), tempDirs }) {
  const input = inputFrom(env)
  const setOutput = outputWriter(env)
  const notice = (s) => log(`::notice title=Houston::${logSafe(s)}`)
  const warn = (s) => log(`::warning title=Houston::${logSafe(s)}`)
  const fail = (s) => {
    log(`::error title=Houston::${logSafe(s)}`)
    setOutput('status', 'error')
    return 1
  }
  const skip = (reason) => {
    notice(`skipped: ${reason}`)
    setOutput('skipped', 'true')
    setOutput('status', 'skipped')
    return 0
  }

  // HOUSTON_ACTION_EVENT_NAME / _PATH replay a recorded event; only the action's own
  // end-to-end test sets them (.github/workflows/action-test.yml).
  const eventName = env.HOUSTON_ACTION_EVENT_NAME || env.GITHUB_EVENT_NAME || ''
  const repository = env.GITHUB_REPOSITORY ?? ''
  const workspace = resolve(env.GITHUB_WORKSPACE ?? process.cwd(), input('working-directory') || '.')
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) return fail('GITHUB_REPOSITORY is not set')
  const event = JSON.parse(readFileSync(env.HOUSTON_ACTION_EVENT_PATH || env.GITHUB_EVENT_PATH, 'utf8'))

  let ctx, approval, allowedTools, budgets, mode
  const trigger = input('trigger') || '@houston'
  const branchPrefix = input('branch-prefix') || 'houston/'
  const provider = input('provider') || 'anthropic'
  const label = input('label') || 'houston'
  try {
    mode = input('mode') || defaultMode(eventName)
    if (!mode) return fail(`no mode for ${eventName} events: set the mode input to respond, review, fix-ci, implement, or task`)
    if (!isValidTrigger(trigger)) throw new Error(`trigger must be one @handle, like @houston (got ${JSON.stringify(trigger)})`)
    if (!isValidLabel(label)) throw new Error(`label must be a label name of at most 50 characters (got ${JSON.stringify(label)})`)
    ctx = buildContext(mode, eventName, event, {
      trigger,
      repository,
      branchPrefix,
      label,
      refName: env.GITHUB_REF_NAME,
      refType: env.GITHUB_REF_TYPE
    })
    if ('skip' in ctx) return skip(ctx.skip)
    // A scheduled or manual run has no comment to act on: the workflow's prompt is the task.
    if ((mode === 'task' || (mode === 'implement' && ctx.number === null)) && !input('prompt')) {
      throw new Error(`a ${eventName} run needs the prompt input: it is the task Houston is given`)
    }
    if (!isValidProviderId(provider)) throw new Error(`provider must be a provider id like anthropic (got ${JSON.stringify(provider)})`)
    approval = resolveApproval(mode, input('approval'))
    allowedTools = parseToolList(input('allowed-tools'))
    budgets = budgetInputs({ maxTurns: input('max-turns'), maxCost: input('max-cost') })
    const effort = input('effort')
    if (effort && !EFFORTS.includes(effort)) throw new Error(`effort must be one of ${EFFORTS.join(', ')} (got ${JSON.stringify(effort)})`)
    budgets.effort = effort || undefined
    if (mode === 'fix-ci') fixBranchName(branchPrefix, 1, 1) // validates the prefix before any work
    if (mode === 'implement') {
      ctx.runId = Number(env.GITHUB_RUN_ID)
      ctx.attempt = env.GITHUB_RUN_ATTEMPT ? Number(env.GITHUB_RUN_ATTEMPT) : 1
      implementBranchName(branchPrefix, ctx.number, ctx.runId, ctx.attempt) // validates before any work
    }
  } catch (e) {
    return fail(e.message)
  }

  const ghToken = env.GH_TOKEN ?? ''
  const ghEnv = { ...env, GH_TOKEN: ghToken, GH_PROMPT_DISABLED: '1', GH_NO_UPDATE_NOTIFIER: '1', NO_COLOR: '1' }
  const ghExec = (cmd, args, opts = {}) => exec(cmd, args, { env: ghEnv, cwd: workspace, ...opts })

  // The author_association gate already turned strangers away; this asks for the real
  // permission, since an org member or an outside collaborator may only have read. An
  // implement run's requester (the commenter, or whoever added the label) is asked the
  // same way; a scheduled or manual run has none, as only the workflow can start it.
  if (mode === 'respond' || (mode === 'implement' && ctx.author)) {
    try {
      if (!(await hasWriteAccess(ghExec, repository, ctx.author))) return skip(`@${ctx.author} does not have write access`)
    } catch (e) {
      return fail(`could not check @${ctx.author}'s permission: ${e.message}`)
    }
  }

  const apiKey = env.HOUSTON_ACTION_API_KEY ?? ''
  if (apiKey) log(`::add-mask::${apiKey}`)
  const secrets = secretValues(env, [apiKey, ghToken])

  const post = input('post') !== 'false'
  const cli = env.HOUSTON_CLI_PATH
  if (!cli) return fail('HOUSTON_CLI_PATH is not set: the install step did not run')
  const node = env.HOUSTON_NODE || process.execPath

  if (mode === 'review') {
    const has = await exec('git', ['cat-file', '-e', `${ctx.baseSha}^{commit}`], { cwd: workspace })
    if (has.code !== 0) {
      return fail(`the base commit ${ctx.baseSha} is not in the checkout: check out with fetch-depth: 0`)
    }
  }

  let before
  if (WRITE_MODES.has(mode)) {
    const head = await exec('git', ['rev-parse', 'HEAD'], { cwd: workspace })
    // implement builds on whatever the workflow checked out (its base branch); the pull
    // request is only right if the run leaves that commit where it was.
    if (mode === 'implement') ctx.headSha = head.code === 0 ? head.stdout.trim() : ''
    if (mode === 'implement' && !ctx.headSha) return fail('the working directory has no commit checked out')
    if (head.stdout.trim() !== ctx.headSha) {
      return fail(`the checkout is at ${head.stdout.trim() || 'no commit'}, not the failed run's ${ctx.headSha}: check out ref: github.event.workflow_run.head_sha`)
    }
    try {
      before = snapshotGitControl(workspace)
    } catch (e) {
      return fail(e.message)
    }
  }

  // Shell is settled by rule so it never prompts: allowed inside the OS sandbox, refused
  // without one. macOS always has Seatbelt; Linux needs a working bubblewrap.
  let shell
  if (approval !== 'plan') {
    const sandboxed =
      process.platform === 'darwin' ||
      (process.platform === 'linux' && (await ensureSandbox(exec, env, input('install-sandbox') !== 'false', log)))
    if (!sandboxed) warn('no OS sandbox is usable on this runner, so Houston will refuse every shell command this run')
    shell = sandboxed ? 'allow' : 'deny'
  }
  const rules = permissionRules(mode, allowedTools, { shell })

  // A private profile: settings with this run's permission rules, the provider, and nothing
  // from anyone's desktop install.
  let profile
  try {
    profile = profileDir(env, workspace, tempDirs)
  } catch (e) {
    return fail(e.message)
  }
  writeFileSync(join(profile, 'settings.json'), `${JSON.stringify({ permissionRules: rules }, null, 2)}\n`, { mode: 0o600 })
  // GH_REPO pins Houston's gh tools to the repository the event came from. The CLI refuses
  // a gh call it can't pin, which a working directory with no GitHub remote would cause.
  const cliEnv = { ...env, HOUSTON_DATA_DIR: profile, GH_TOKEN: ghToken, GH_REPO: repository, NO_COLOR: '1' }
  for (const k of Object.keys(cliEnv)) if (k.startsWith('HOUSTON_INPUT_') || k === 'HOUSTON_ACTION_API_KEY') delete cliEnv[k]
  if (apiKey) cliEnv[keyEnvName(provider)] = apiKey

  const setup = await providerSetup(exec, node, cli, cliEnv, provider, input('base-url'))
  if (setup) return fail(setup)

  const prompt = buildPrompt(ctx, { prompt: input('prompt'), verify: input('verify') })
  const args = cliArgs({
    cwd: workspace,
    provider,
    model: input('model'),
    approval,
    maxTurns: budgets.maxTurns,
    maxCost: budgets.maxCost,
    effort: budgets.effort,
    verify: input('verify')
  })
  log(`Running Houston (${mode}, ${approval}) with ${provider}${input('model') ? `/${input('model')}` : ''}`)
  const res = await exec(node, [cli, ...args], {
    env: cliEnv,
    cwd: workspace,
    input: prompt,
    onStdoutLine: (line) => {
      if (!line.startsWith('{"type":"tool_start"')) return
      try {
        log(`  · ${logSafe(JSON.parse(line).name)}`)
      } catch {
        // a partial line: the full output is parsed once the run ends
      }
    }
  })
  for (const line of res.stderr.split('\n').filter((l) => l.trim())) log(`  ${logSafe(line)}`)
  const out = parseRunOutput(res.stdout)
  const result = out.result
  if (!result) return fail(`Houston exited ${res.code} without a result${out.errors.length ? `: ${out.errors.join('; ')}` : ''}`)
  setOutput('status', result.status)
  setOutput('cost-usd', String(result.costUsd))
  setOutput('turns', String(result.turns))
  log(`Houston finished: ${result.status} in ${result.turns} turns, $${result.costUsd}`)

  const finalText = (result.finalText ?? '').trim()
  const replyPath = join(profile, 'reply.md')
  setOutput('reply-file', replyPath)
  const runUrl = `${env.GITHUB_SERVER_URL || 'https://github.com'}/${repository}/actions/runs/${env.GITHUB_RUN_ID ?? ''}`
  const footer = `\n\n<sub>Posted by Houston from [this workflow run](${runUrl}).</sub>`
  // A run whose last --verify check still failed (`verify_failed`) did its work; fix-ci
  // opens its pull request as a draft, like a run stopped at its budget.
  const finished = result.status === 'success' || result.status === 'limit' || result.status === 'verify_failed'
  const limitNote = result.status === 'limit' ? '\n\n_Houston stopped at its budget before it was done; this is as far as it got._' : ''

  /** Write a body, refuse it if it carries a credential, and record it in the job summary. */
  const prepare = (body) => {
    const text = capBody(body)
    if (containsSecret(text, secrets)) throw new Error('the reply contains a credential from this job; nothing was posted')
    writeFileSync(replyPath, text, { mode: 0o600 })
    if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, `## Houston (${mode})\n\n${text}\n`)
    return replyPath
  }

  try {
    if (mode === 'respond') {
      const body = finished && finalText
        ? `${finalText}${limitNote}${footer}`
        : `@${ctx.author} Houston could not finish this request (${result.status}).${footer}`
      const file = prepare(body)
      if (!post) return dryRun(notice, setOutput)
      const url = ctx.replyToReviewComment
        ? await replyToReviewComment(ghExec, repository, ctx.number, ctx.replyToReviewComment, file)
        : await postIssueComment(ghExec, repository, ctx.number, file)
      setOutput('url', url)
      return finished ? 0 : fail(`the run ended with ${result.status}; posted a note on #${ctx.number}`)
    }

    if (mode === 'review') {
      if (!finished || !finalText) return fail(`the review ended with ${result.status} and nothing to post`)
      const body = `${finalText}${limitNote}${footer}`
      const file = prepare(body)
      const lines = out.findings.length ? await reviewLines(exec, workspace, ctx) : null
      if (out.findings.length && !lines) notice(`the head commit ${ctx.headSha ?? ''} is not in the checkout, so findings stay in the review body`)
      if (!post) {
        const { comments } = inlineComments(out.findings, lines ?? new Map())
        const list = comments.map((c) => `- \`${c.path}:${c.line}\` ${c.body.split('\n')[0]}`).join('\n')
        if (comments.length && env.GITHUB_STEP_SUMMARY && !containsSecret(list, secrets)) {
          appendFileSync(env.GITHUB_STEP_SUMMARY, `\n### Inline comments\n\n${list}\n`)
        }
        return dryRun(notice, setOutput)
      }
      setOutput('url', await postReviewRun({ ghExec, repository, ctx, file, findings: out.findings, lines, secrets, profile, warn }))
      return 0
    }

    // An implement run that came from an issue says on it when it opens no pull request.
    const tellIssue =
      mode === 'implement' && ctx.number !== null
        ? async (text) => {
            const note = capBody(`@${ctx.author} ${text}`)
            if (containsSecret(note, secrets)) return warn('the note for the issue contains a credential from this job; not posted')
            const noteFile = join(profile, 'issue-note.md')
            writeFileSync(noteFile, note, { mode: 0o600 })
            try {
              await postIssueComment(ghExec, repository, ctx.number, noteFile)
            } catch (e) {
              warn(`could not comment on issue #${ctx.number}: ${e.message}`)
            }
          }
        : undefined

    if (mode === 'task') {
      if (!finished || !finalText) return fail(`the task ended with ${result.status} and nothing to report`)
      prepare(`${finalText}${limitNote}${footer}`)
      setOutput('url', '')
      return 0
    }

    return await openFixPullRequest({
      ctx, env, exec, ghExec, workspace, before, secrets, post, ghToken, branchPrefix, result, out,
      finalText, limitNote, footer, prepare, setOutput, notice, fail, log, repository, tellIssue
    })
  } catch (e) {
    return fail(e.message)
  }
}

function dryRun(notice, setOutput) {
  notice('post is false: wrote the result to the job summary and the reply-file output instead of posting it')
  setOutput('url', '')
  return 0
}

/**
 * What a write mode's pull request is: the new branch it pushes, the branch it targets, and
 * its wording. fix-ci targets the branch that failed; implement targets the branch it was
 * checked out on (the default branch for an issue).
 */
function pullRequestPlan(ctx, prefix, verified) {
  if (ctx.mode === 'fix-ci') {
    const failed = ctx.runUrl ? `[run ${ctx.runId}](${ctx.runUrl})` : `run ${ctx.runId}`
    return {
      branch: fixBranchName(prefix, ctx.runId, ctx.attempt),
      base: ctx.branch,
      title: `Fix the CI failure in run ${ctx.runId}`,
      fallback: 'Houston changed the files below to fix the failing run.',
      trailer: `Fixes the failure in ${failed} on \`${ctx.branch}\`. Verification: ${verified}.`
    }
  }
  const branch = implementBranchName(prefix, ctx.number, ctx.runId, ctx.attempt)
  if (ctx.number === null) {
    const kind = ctx.source === 'schedule' ? 'a scheduled' : 'a manually started'
    return {
      branch,
      base: ctx.base,
      title: `Houston task from run ${ctx.runId}`,
      fallback: "Houston changed the files below for the workflow's task.",
      trailer: `From ${kind} run on \`${ctx.base}\`. Verification: ${verified}.`
    }
  }
  return {
    branch,
    base: ctx.base,
    title: `Implement issue #${ctx.number}`,
    fallback: `Houston changed the files below for issue #${ctx.number}.`,
    trailer: `Closes #${ctx.number}. Requested by @${ctx.author}. Verification: ${verified}.`
  }
}

/**
 * The ending of fix-ci and implement: commit what the run changed to a new branch and open
 * a pull request. `tellIssue`, when set, posts on the issue an implement run came from
 * when there is no pull request to show for it.
 */
async function openFixPullRequest(o) {
  const { ctx, exec, workspace, before, secrets, post, ghToken, branchPrefix, result, out, setOutput } = o
  if (result.status !== 'success' && result.status !== 'limit' && result.status !== 'verify_failed') {
    if (post) await o.tellIssue?.(`Houston could not finish this request (${result.status}), so no pull request was opened.${o.footer}`)
    return o.fail(`the ${ctx.mode} run ended with ${result.status}; no pull request opened`)
  }
  const changed = changedControlFiles(before, snapshotGitControl(workspace))
  if (changed.length) {
    return o.fail(`the run changed .git/${changed.join(', .git/')}; refusing to commit or push from this checkout`)
  }
  const git = (args, opts = {}) => exec('git', [...SAFE_GIT, ...args], { cwd: workspace, ...opts })
  // The run must leave the checked-out commit where it was: a commit it made, or a branch
  // it switched to, would reach the pull request without the credential check below.
  const head = await git(['rev-parse', 'HEAD'])
  if (head.code !== 0 || head.stdout.trim() !== ctx.headSha) {
    return o.fail(`the run moved HEAD off ${ctx.headSha}; refusing to commit or push from this checkout`)
  }
  const status = await git(['status', '--porcelain', '--untracked-files=all'])
  if (status.code !== 0) return o.fail(`git status failed: ${status.stderr.trim()}`)
  if (!status.stdout.trim()) {
    o.notice('Houston made no changes, so there is nothing to open a pull request for')
    if (o.finalText) {
      o.prepare(`${o.finalText}${o.footer}`)
      if (post) await o.tellIssue?.(`${o.finalText}${o.footer}`)
    }
    setOutput('url', '')
    return 0
  }

  const verified = out.verification === null ? 'not run' : out.verification ? 'passed' : 'failed'
  const plan = pullRequestPlan(ctx, branchPrefix, verified)
  const branch = plan.branch
  assertPushTarget(branch, { prefix: branchPrefix, defaultBranch: ctx.defaultBranch, failedBranch: plan.base })
  const step = async (what, args) => {
    const r = await git(args)
    if (r.code !== 0) throw new Error(`git ${what} failed: ${r.stderr.trim()}`)
    return r.stdout
  }
  await step('switch', ['switch', '--create', branch])
  await step('add', ['add', '--all'])
  const diff = await step('diff', ['diff', '--cached', '--binary', '--no-ext-diff', '--no-textconv'])
  if (containsSecret(diff, secrets)) return o.fail('the change contains a credential from this job; nothing was committed')
  await step('commit', [
    '-c', `user.name=${BOT_NAME}`, '-c', `user.email=${BOT_EMAIL}`,
    'commit', '--no-verify', '--quiet', '-m', plan.title
  ])
  setOutput('branch', branch)

  const draft = result.status === 'limit' || result.status === 'verify_failed' || out.verification === false
  const summary = o.finalText || plan.fallback
  const file = o.prepare(`${summary}${o.limitNote}\n\n${plan.trailer}${o.footer}`)
  if (!post) return dryRun(o.notice, setOutput)

  // The token rides in an extraheader set through the environment, so it is never in argv,
  // in .git/config, or visible to anything the agent left in the checkout.
  const header = Buffer.from(`x-access-token:${ghToken}`).toString('base64')
  o.log(`::add-mask::${header}`)
  const push = await git(['push', '--no-verify', `https://github.com/${o.repository}.git`, `HEAD:refs/heads/${branch}`], {
    env: {
      ...o.env,
      GIT_TERMINAL_PROMPT: '0',
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'http.https://github.com/.extraheader',
      GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${header}`
    }
  })
  if (push.code !== 0) return o.fail(`git push to ${branch} failed: ${push.stderr.trim()}`)
  const url = await createPullRequest(o.ghExec, o.repository, {
    base: plan.base,
    head: branch,
    title: plan.title,
    bodyFile: file,
    draft
  })
  setOutput('url', url)
  o.notice(`opened ${url}`)
  return 0
}

/**
 * The lines of the pull request's diff (merge base to head, as GitHub shows it) that take
 * an inline comment, or null when the head commit isn't in the checkout.
 */
async function reviewLines(exec, workspace, ctx) {
  const run = (args) => exec('git', [...SAFE_GIT, ...args], { cwd: workspace })
  if (!isSha(ctx.headSha) || (await run(['cat-file', '-e', `${ctx.headSha}^{commit}`])).code !== 0) return null
  const range = `${ctx.baseSha}...${ctx.headSha}`
  const diff = await run(['diff', '--no-color', '--no-ext-diff', '--no-textconv', '--unified=3', range])
  return diff.code === 0 ? commentableLines(diff.stdout) : null
}

/**
 * Post the review: one comment review whose findings sit on their diff lines, skipping any
 * Houston already posted on this pull request. With no new inline comment, or if GitHub
 * refuses them, it is the plain review comment it always was.
 */
async function postReviewRun({ ghExec, repository, ctx, file, findings, lines, secrets, profile, warn }) {
  if (lines) {
    let posted = new Set()
    try {
      posted = postedKeys(await listReviewComments(ghExec, repository, ctx.number))
    } catch (e) {
      warn(`could not list earlier review comments, so findings may repeat: ${e.message}`)
    }
    const { comments, skipped } = inlineComments(findings, lines, posted)
    if (skipped) warn(`${skipped} finding(s) already have an inline comment on this pull request; not posting them again`)
    if (comments.length) {
      const payload = JSON.stringify({ commit_id: ctx.headSha, event: 'COMMENT', body: readFileSync(file, 'utf8'), comments })
      if (containsSecret(payload, secrets)) throw new Error('a review comment contains a credential from this job; nothing was posted')
      const payloadFile = join(profile, 'review.json')
      writeFileSync(payloadFile, payload, { mode: 0o600 })
      try {
        return await postReviewWithComments(ghExec, repository, ctx.number, payloadFile)
      } catch (e) {
        warn(`GitHub refused the inline comments, so the review is posted without them: ${e.message}`)
      }
    }
  }
  return postReview(ghExec, repository, ctx.number, file)
}

/**
 * Register the provider in the profile: a custom endpoint from `base-url`, or a catalog
 * host (openrouter, groq, ...) the profile doesn't have yet. Returns an error message, or
 * null when the provider is ready.
 */
async function providerSetup(exec, node, cli, env, provider, baseUrl) {
  const call = (args) => exec(node, [cli, 'providers', ...args], { env })
  if (baseUrl) {
    if (!/^https?:\/\/[^\s]+$/.test(baseUrl)) return `base-url must be an http(s) URL (got ${JSON.stringify(baseUrl)})`
    const r = await call(['add', '--url', baseUrl, '--id', provider, '--label', provider])
    return r.code === 0 ? null : `could not add the ${provider} endpoint: ${r.stderr.trim() || r.stdout.trim()}`
  }
  const list = await call(['list'])
  const configured = list.stdout.split('Available to add')[0]
  if (new RegExp(`^\\s+${provider}\\s`, 'm').test(configured)) return null
  const r = await call(['add', provider])
  return r.code === 0 ? null : `unknown provider ${provider}: ${r.stderr.trim() || r.stdout.trim()}`
}

/**
 * Make sure bubblewrap can confine shell commands. On a GitHub-hosted runner (ephemeral,
 * passwordless sudo) it installs bubblewrap and lifts Ubuntu's AppArmor limit on
 * unprivileged user namespaces; on a self-hosted runner it only probes, since changing a
 * host the workflow doesn't own is not this action's call.
 */
export async function ensureSandbox(exec, env, install, log) {
  const probe = async () =>
    (
      await exec('bwrap', [
        '--ro-bind', '/', '/', '--dev', '/dev', '--proc', '/proc',
        '--unshare-pid', '--unshare-net', '--die-with-parent', '/bin/true'
      ])
    ).code === 0
  if (await probe()) return true
  if (!install || env.RUNNER_ENVIRONMENT !== 'github-hosted') return false
  log('Installing bubblewrap so shell commands run sandboxed')
  const apt = await exec('sudo', ['apt-get', 'install', '-y', '-q', 'bubblewrap'])
  if (apt.code !== 0) {
    await exec('sudo', ['apt-get', 'update', '-q'])
    await exec('sudo', ['apt-get', 'install', '-y', '-q', 'bubblewrap'])
  }
  await exec('sudo', ['sysctl', '-q', '-w', 'kernel.apparmor_restrict_unprivileged_userns=0'])
  return probe()
}
