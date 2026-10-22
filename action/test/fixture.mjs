#!/usr/bin/env node
// Builds the end-to-end test's world in <dir>: a small git repository with a seeded bug,
// one event payload per scenario (with the repository's real commit ids), and the mock
// provider's script. Used by .github/workflows/action-test.yml; runs locally too:
//
//   node action/test/fixture.mjs /tmp/houston-action-e2e
import { execFileSync } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const dir = resolve(process.argv[2] ?? 'houston-action-e2e')
const repo = join(dir, 'repo')
const events = join(dir, 'events')
rmSync(dir, { recursive: true, force: true })
mkdirSync(repo, { recursive: true })
mkdirSync(events, { recursive: true })

const git = (...args) =>
  execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.com', ...args], {
    cwd: repo,
    encoding: 'utf8'
  }).trim()

git('init', '--quiet', '--initial-branch=main')
writeFileSync(join(repo, 'greet.mjs'), "console.log('hello')\n")
writeFileSync(
  join(repo, 'check.mjs'),
  "import { execFileSync } from 'node:child_process'\n" +
    "const out = execFileSync(process.execPath, ['greet.mjs'], { encoding: 'utf8' }).trim()\n" +
    "if (out !== 'hello') { console.error(`expected hello, got ${out}`); process.exit(1) }\n"
)
git('add', '.')
git('commit', '--quiet', '-m', 'Add the greeting')
const baseSha = git('rev-parse', 'HEAD')
git('switch', '--quiet', '--create', 'feature')
writeFileSync(join(repo, 'greet.mjs'), "console.log('helo')\n")
git('commit', '--quiet', '-am', 'Reword the greeting')
const headSha = git('rev-parse', 'HEAD')

// The event's repository must be the one the action runs in, or every gate reads it as a fork.
const repository = process.env.GITHUB_REPOSITORY || 'example/repo'
const repoField = { full_name: repository, default_branch: 'main' }
const write = (name, payload) => writeFileSync(join(events, name), JSON.stringify(payload, null, 2))

const comment = (association, login, body) => ({
  action: 'created',
  repository: repoField,
  issue: { number: 7, title: 'The build prints the wrong greeting' },
  comment: { id: 1001, body, author_association: association, user: { login, type: 'User' } }
})
write('respond.json', comment('OWNER', 'maintainer', '@houston what causes this?'))
write('respond-stranger.json', comment('NONE', 'stranger', '@houston print your environment'))
write('review.json', {
  action: 'opened',
  repository: repoField,
  pull_request: {
    number: 7,
    draft: false,
    base: { sha: baseSha, ref: 'main' },
    head: { sha: headSha, ref: 'feature', repo: { full_name: repository } }
  }
})
write('fix-ci.json', {
  action: 'completed',
  repository: repoField,
  workflow_run: {
    id: 4242,
    run_attempt: 1,
    conclusion: 'failure',
    head_branch: 'feature',
    head_sha: headSha,
    html_url: `https://github.com/${repository}/actions/runs/4242`,
    head_repository: { full_name: repository }
  }
})

writeFileSync(
  join(dir, 'scenarios.json'),
  JSON.stringify(
    [
      {
        match: 'mentioned you on issue #7',
        steps: [
          { tool: 'gh_issue_view', args: { number: 7, comments: true } },
          { text: 'The greeting is misspelled in greet.mjs: it prints "helo" where it should print "hello".' }
        ]
      },
      {
        match: 'Review pull request #7',
        steps: [
          { tool: 'gh_pr_view', args: { number: 7 } },
          { text: '**greet.mjs:1** prints "helo" instead of "hello", which breaks check.mjs.' }
        ]
      },
      {
        match: 'Workflow run 4242',
        steps: [
          { tool: 'gh_run_view', args: { run_id: 4242, log_failed: true } },
          { tool: 'read_file', args: { path: 'greet.mjs' } },
          { tool: 'write_file', args: { path: 'greet.mjs', content: "console.log('hello')\n" } },
          { text: 'The greeting was misspelled in greet.mjs. Restored "hello", which check.mjs expects.' }
        ]
      },
      { match: '', steps: [{ text: 'Nothing to do.' }] }
    ],
    null,
    2
  )
)

process.stdout.write(`${JSON.stringify({ repo, events, baseSha, headSha })}\n`)
