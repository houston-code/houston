# Houston GitHub Action

Run Houston in GitHub Actions, on your own runners, with your own model API key. There
is no Houston service in between: the action downloads the standalone CLI from a Houston
release, checks its signature, and runs it in the job. Your key goes from your
repository's secrets straight to your model provider.

It has five modes:

| Mode | Runs on | What it does |
| --- | --- | --- |
| `respond` | `issue_comment`, `pull_request_review_comment`, `issues` | Answers an `@houston` mention from someone with write access, with the thread as context, in a reply. |
| `review` | `pull_request` | Reviews the change against its base with Houston's multi-agent `review_changes` and posts one review, with each finding as an inline comment on its diff line. |
| `fix-ci` | `workflow_run` | Reads a failed run's logs, fixes the cause in a sandbox, pushes the fix to a new branch, and opens a pull request. |
| `implement` | `issues` (labeled), `issue_comment`, and opted-in `schedule` or `workflow_dispatch` runs | Makes the change an issue asks for (or a scheduled run's `prompt`) in a sandbox, pushes it to a new branch, and opens a pull request that links the issue. |
| `task` | `schedule`, `workflow_dispatch` | Works on the workflow's `prompt` read-only and writes its report to the job summary. |

`implement` is never picked from the event: a workflow opts in by setting `mode: implement`.

Ready-to-copy workflows are in [examples/](examples/):
[respond](examples/houston-respond.yml), [review](examples/houston-review.yml),
[fix CI](examples/houston-fix-ci.yml), [implement](examples/houston-implement.yml), and
[scheduled](examples/houston-scheduled.yml).

## Quick start

1. Add your model key as a repository secret, for example `ANTHROPIC_API_KEY`.
2. Copy one of the example workflows into `.github/workflows/`.
3. Pin the action to a full commit SHA. The examples show the release tag
   (`houston-code/houston/action@v0.10.0`, the first release that ships the action) so
   they read well. In your workflow, use the commit that tag points to:

   ```bash
   git ls-remote https://github.com/houston-code/houston refs/tags/v0.10.0
   ```

   ```yaml
   - uses: houston-code/houston/action@<that commit SHA> # v0.10.0
   ```

```yaml
on:
  issue_comment:
    types: [created]

permissions: {}

jobs:
  respond:
    runs-on: ubuntu-24.04
    permissions:
      contents: read
      issues: write
      pull-requests: write
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
        with:
          persist-credentials: false
      - uses: houston-code/houston/action@<commit SHA> # v0.10.0
        with:
          api-key: ${{ secrets.ANTHROPIC_API_KEY }}
```

Linux runners are the recommended home: shell commands are sandboxed there with
bubblewrap, which the action installs on GitHub-hosted runners. macOS runners use the
built-in Seatbelt sandbox. Windows runners are not supported.

## Inputs

| Input | Default | Description |
| --- | --- | --- |
| `mode` | from the event | `respond`, `review`, `fix-ci`, `implement`, or `task`. |
| `prompt` | | Extra instructions added to the task, such as house review rules. For `task`, and for `implement` on `schedule` or `workflow_dispatch`, it is the task itself and is required. |
| `provider` | `anthropic` | `anthropic`, `openai`, `gemini`, a catalog host (`openrouter`, `groq`, `together`, ...), or the id for a `base-url` endpoint. |
| `model` | provider default | Model id. |
| `base-url` | | An OpenAI-compatible endpoint to register as `provider`, for a self-hosted model or a gateway. |
| `api-key` | | The provider key, from a secret. Masked, and given to Houston only through its environment. |
| `approval` | `default` | `default` is `plan` (read-only) for `respond`, `review`, and `task`, and `auto-edit` with sandboxed, offline shell allowed by rule for `fix-ci` and `implement`. Also `plan`, `auto-edit`, `full-auto`. |
| `max-turns` | `40` | Hard cap on model steps. |
| `max-cost` | | US dollars at which Houston is told to wrap up, like `2`. |
| `effort` | | Reasoning effort: `off`, `low`, `medium`, `high`, `xhigh`. |
| `verify` | | A check Houston must pass after editing, like `npm test`. The pull request says whether it passed, and opens as a draft when it did not. |
| `allowed-tools` | | Comma or newline separated tool names. When set, only these tools (and the ones the mode needs) run at all. |
| `trigger` | `@houston` | The mention that starts a `respond` run. Followed by `implement`, it starts an `implement` run. |
| `label` | `houston` | The issue label whose addition starts an `implement` run. |
| `branch-prefix` | `houston/` | Where new branches go: `houston/fix-ci-<run id>-<attempt>`, `houston/implement-<issue>-<run id>-<attempt>`, or `houston/task-<run id>-<attempt>`. |
| `working-directory` | workspace | The git checkout to work in. |
| `post` | `true` | `false` writes the result to the job summary and the `reply-file` output instead of posting. A good first run. |
| `install-sandbox` | `true` | Install bubblewrap on GitHub-hosted Linux runners when the run can use the shell. Self-hosted runners are only checked. |
| `cli-version` | pinned | Houston CLI release to run. Defaults to the release in [cli-release.json](cli-release.json). |
| `github-token` | `github.token` | Token for reading threads and logs and for posting. |

Outputs: `status` (`success`, `limit`, `verify_failed`, `stalled`, `approval_denied`,
`error`, or `skipped`), `skipped`, `url`, `branch`, `reply-file`, `cost-usd`, `turns`, `cli-version`.

## Implementing issues

With [houston-implement.yml](examples/houston-implement.yml), a collaborator with write
access starts a run by adding the `houston` label to an issue, or by commenting
`@houston implement` (anything after it is part of the request). Houston reads the issue
and makes the change in the default branch's checkout. The action commits it to a new
branch, `houston/implement-<issue>-<run id>-<attempt>`, and opens a pull request against
the default branch with `Closes #<issue>` in its description. When Houston changes nothing
(the issue needs a decision, say) or the run fails, the action says so on the issue.

```yaml
on:
  issues:
    types: [labeled]
  issue_comment:
    types: [created]

permissions: {}

jobs:
  implement:
    if: ${{ !github.event.issue.pull_request }}
    runs-on: ubuntu-24.04
    permissions:
      contents: write
      issues: write
      pull-requests: write
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
        with:
          persist-credentials: false
      - uses: houston-code/houston/action@<commit SHA> # v0.10.0
        with:
          mode: implement
          api-key: ${{ secrets.ANTHROPIC_API_KEY }}
          verify: npm test
```

It never works from a pull request and never pushes to an existing branch: a comment on a
pull request is skipped. If you also use the respond workflow, keep `@houston implement`
comments out of it, as [houston-respond.yml](examples/houston-respond.yml) does, so one
comment doesn't start both.

## Inline review comments

A `review` run posts one review. Its body is Houston's summary, and each finding the
review kept (not rejected, and not merged into another by the verification pass) whose
`path:line` falls on a line of the pull request's diff becomes an inline comment on that
line, inside the same review. Findings outside the diff stay in the body.

Each inline comment carries a hidden marker, so when a push (`synchronize`) reviews the
pull request again, findings Houston already commented on are not posted a second time,
even if their line moved. Only markers on comments from a GitHub App or a collaborator
count, so no one else can hide a finding by copying one. Inline comments need the head
commit in the checkout (`fetch-depth: 0`, as in the example). Without it, or if GitHub
refuses the comments, the review is posted as a plain comment.

## Scheduled and manual runs

On `schedule` and `workflow_dispatch` the default mode is `task`: Houston works on the
`prompt` input read-only, writes its report to the job summary and the `reply-file`
output, and posts nothing. See [houston-scheduled.yml](examples/houston-scheduled.yml).

```yaml
on:
  schedule:
    - cron: '0 6 * * 1'
  workflow_dispatch:
    inputs:
      prompt:
        description: What Houston should look into.

permissions: {}

jobs:
  task:
    runs-on: ubuntu-24.04
    permissions:
      contents: read
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
        with:
          persist-credentials: false
      - uses: houston-code/houston/action@<commit SHA> # v0.10.0
        with:
          api-key: ${{ secrets.ANTHROPIC_API_KEY }}
          prompt: ${{ inputs.prompt || 'List the TODO comments that look out of date.' }}
```

To let a scheduled or manual run change code, set `mode: implement` and grant
`contents: write` and `pull-requests: write`. The action then commits Houston's changes to
a new branch, `houston/task-<run id>-<attempt>`, and opens a pull request against the
branch the run started on. Only someone with write access can start `workflow_dispatch`,
so its inputs may be the task; never pass issue or comment text to `prompt`.

## Other providers

```yaml
- uses: houston-code/houston/action@<commit SHA>
  with:
    provider: openai
    model: gpt-6.1-sol
    api-key: ${{ secrets.OPENAI_API_KEY }}

- uses: houston-code/houston/action@<commit SHA>
  with:
    provider: my-gateway
    base-url: https://llm.internal.example.com/v1
    model: my-model
    api-key: ${{ secrets.GATEWAY_KEY }}
```

## How the CLI is verified

Before anything runs, the install step:

1. Downloads `houston-cli.cjs`, `SHA256SUMS`, and its signatures from the
   `houston-code/houston` release.
2. Checks the GPG signature on `SHA256SUMS` with `gpgv`, against a keyring holding only
   the project key committed in this repository (`houston-signing-key.asc`), and requires
   the signer's primary fingerprint to be `A11D D282 4C1E F838 D441 452F 5DD4 F607 9F8B A5DB`.
   A key shipped with the release itself is never trusted.
3. Also checks the keyless cosign signature when `cosign` is installed on the runner
   (for example with `sigstore/cosign-installer`).
4. Checks the CLI's SHA-256 against its `SHA256SUMS` line and, for the default release,
   against the hash recorded in `cli-release.json`.
5. Runs `houston-cli.cjs --version` only after all of that passes.

## Security

Issue, comment, and pull request text, and CI logs, are written by people who may want to
steer the model. The action is built around that:

- **Who can start a run.** `respond` needs a mention, outside code and quotes, from a
  user whose `author_association` is `OWNER`, `MEMBER`, or `COLLABORATOR` and whose actual
  repository permission (asked from the API) is write, maintain, or admin. `implement`
  asks the same of the commenter, or of whoever added the label (the triage role can add
  labels, but does not pass). Bots never start a run. `review` skips pull requests from
  forks, which get no secrets anyway. `fix-ci` skips runs of fork pull requests and its own
  fix branches. Only the workflow itself starts a `schedule` or `workflow_dispatch` run.
- **No `pull_request_target`.** The action refuses to run on it: that event hands the
  base repository's secrets to a job that can read a fork's code.
- **Untrusted text stays data.** Event text never reaches a shell: inputs reach the
  scripts through environment variables, the prompt goes to the CLI on stdin, and posts
  use `--body-file`. The prompt carries only the authorized commenter's request and ids
  from the event. The thread, the pull request description, and CI logs are read by
  Houston's GitHub tools, which wrap them in Houston's untrusted-content fence and flag
  likely prompt injection.
- **Least privilege for the model.** Every approval prompt is answered with a denial (no
  one is there to answer). Web fetch and web search, every GitHub write tool, and the
  session, scheduling, and writable-subagent tools are refused by rule; only the GitHub
  read tools are allowed. Shell commands run in the OS sandbox with no network, and
  without the job's credentials in their environment. The run uses a fresh Houston
  profile outside the checkout and outside the sandbox's writable temp directories.
- **The action does the writes.** The model never posts or pushes. After a `fix-ci` or
  `implement` run the action refuses to continue if the run changed `.git/config`, a hook,
  or `.git/info/attributes`, or moved `HEAD` (a commit of its own would skip the checks
  that follow); runs git with hooks disabled; refuses to post or push anything that
  contains the job's API key or tokens; and pushes only a new branch under `branch-prefix`,
  never the branch it started from or the default branch. The push credential is
  passed to git through its environment, never in a URL or `.git/config`.
- **Least-privilege tokens.** The examples start from `permissions: {}` and grant each job
  only what its mode needs, and check out with `persist-credentials: false`.

Things to know:

- A pull request opened with the default `GITHUB_TOKEN` does not trigger your workflows,
  so a fix or implement PR shows no CI until someone pushes to it. Pass a GitHub App token as
  `github-token` to get CI on it.
- The default token cannot push changes to `.github/workflows/`, so a fix that edits a
  workflow fails to push. That is deliberate.
- Prefer Linux runners for `fix-ci` and `implement`. On macOS the Seatbelt sandbox lets a shell command
  read the environment of other processes you own, which includes the model key. The
  network is blocked and the action refuses a change that contains the key, but an
  encoded copy could still end up in the fix branch.
- Keep event text out of the `prompt` input (no `${{ github.event.comment.body }}`
  there): it is trusted as the workflow's own instructions.
- A `review` run reads the pull request's code, including any `AGENTS.md` it adds, as
  project context. Only same-repository pull requests are reviewed, so their authors
  already have write access.

## Where it lives

The action lives in the Houston repository, under `action/`, rather than in a repository
of its own. It is versioned and released with the CLI it runs, verifies against the same
committed signing key, and goes through the same required checks (workflow linting with
actionlint and zizmor, its unit tests, and the end-to-end test in
[action-test.yml](../.github/workflows/action-test.yml)). The cost is that `uses:` fetches
the whole repository, and that a GitHub Marketplace listing needs a dedicated repository
with `action.yml` at its root. If a listing is wanted later, a `houston-code/houston-action`
repository can mirror this directory.

## Developing

```bash
npx vitest run action/                 # unit tests for every script
node action/test/fixture.mjs /tmp/e2e  # the end-to-end fixture, as action-test.yml builds it
```

Release - publish moves [cli-release.json](cli-release.json) to each new latest release
in its sync PR (`scripts/pin-action-cli.mjs`): the new version, the `houston-cli.cjs` hash
from its `SHA256SUMS`, and that `SHA256SUMS` and `SHA256SUMS.asc` under
`test/fixtures/v<version>/`, where the unit tests check the pinned hash against the
signed list.
