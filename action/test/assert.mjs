#!/usr/bin/env node
// Checks one scenario of the end-to-end test (.github/workflows/action-test.yml) after the
// action ran it: what was posted through the fake gh, what the mock model was shown, and
// what landed in the fixture repository.
//
//   node action/test/assert.mjs <scenario> <fixture dir>
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const [scenario, dir] = process.argv.slice(2)
const failures = []
const check = (ok, what) => {
  if (!ok) failures.push(what)
}
const jsonl = (path) =>
  existsSync(path)
    ? readFileSync(path, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l))
    : []

const gh = jsonl(join(dir, `gh-${scenario}.jsonl`))
const requests = jsonl(join(dir, 'mock.jsonl'))
const text = (c) => (typeof c === 'string' ? c : JSON.stringify(c ?? ''))
const firstUser = (r) => text(r.messages.find((m) => m.role === 'user')?.content)
const toolText = (r) => r.messages.filter((m) => m.role === 'tool').map((m) => text(m.content)).join('\n')
const posted = (sub) => gh.find((c) => c.args[0] === sub[0] && c.args[1] === sub[1])

if (scenario === 'respond') {
  check(gh.some((c) => c.args[0] === 'api' && c.args[1].endsWith('/collaborators/maintainer/permission')), 'checked the commenter permission')
  const reply = posted(['issue', 'comment'])
  check(reply?.args.includes('7'), 'posted a comment on issue 7')
  check(reply?.body?.includes('misspelled in greet.mjs'), 'the comment carries the final answer')
  const run = requests.filter((r) => firstUser(r).includes('mentioned you on issue #7'))
  check(run.length > 0, 'the model saw the respond task')
  check(run.some((r) => firstUser(r).includes('----- comment from @maintainer -----')), 'the request is delimited in the prompt')
  check(!run.some((r) => firstUser(r).includes('Ignore all previous')), 'thread text never reaches the prompt')
  const fenced = run.map(toolText).find((t) => t.includes('Ignore all previous'))
  check(Boolean(fenced && /<untrusted-content-[0-9a-f]+/.test(fenced)), 'thread text arrives inside the untrusted fence')
} else if (scenario === 'respond-stranger') {
  check(gh.length === 0, 'a stranger triggers no gh call at all')
} else if (scenario === 'review') {
  const review = posted(['pr', 'review'])
  check(review?.args.includes('--comment'), 'posted one comment review')
  check(review?.body?.includes('greet.mjs:1'), 'the review carries the final answer')
  check(!gh.some((c) => c.args[0] === 'issue' && c.args[1] === 'comment'), 'review posts no issue comment')
} else if (scenario === 'fix-ci') {
  const git = (...args) => execFileSync('git', args, { cwd: join(dir, 'repo'), encoding: 'utf8' }).trim()
  check(git('rev-parse', '--abbrev-ref', 'HEAD') === 'houston/fix-ci-4242-1', 'committed on the fix branch')
  check(git('show', 'houston/fix-ci-4242-1:greet.mjs').includes("'hello'"), 'the fix branch has the fix')
  check(git('show', 'feature:greet.mjs').includes("'helo'"), 'the failed branch is untouched')
  check(git('log', '-1', '--format=%an', 'houston/fix-ci-4242-1') === 'github-actions[bot]', 'committed as the Actions bot')
  check(!gh.some((c) => c.args[0] === 'pr' && c.args[1] === 'create'), 'post: false opened no pull request')
  const summary = readFileSync(process.env.REPLY_FILE ?? join(dir, 'reply-fix-ci.md'), 'utf8')
  check(summary.includes('Verification: passed'), 'the verify command ran and passed')
} else {
  failures.push(`unknown scenario ${scenario}`)
}

if (failures.length) {
  for (const f of failures) process.stdout.write(`::error title=action e2e (${scenario})::expected: ${f}\n`)
  process.exit(1)
}
process.stdout.write(`${scenario}: all checks passed\n`)
