# Contributing to Houston

Thanks for your interest! Houston is an Electron + React + TypeScript desktop
app. This guide covers local setup and the conventions the codebase follows.

Everyone taking part is expected to follow the
[Code of Conduct](CODE_OF_CONDUCT.md). To report a vulnerability, follow
[SECURITY.md](SECURITY.md) rather than opening an issue.

## Prerequisites

- A supported OS: macOS 13 Ventura+ (Apple Silicon or Intel), Windows 10+ (x64), or
  Linux x64 (glibc 2.35+: Ubuntu 22.04+ / Debian 12+ / Fedora 36+). Each platform+arch
  builds its own artifacts on its own host, because native modules and the per-platform binaries
  can't cross-compile.
- Node.js 22+ (pinned in `.nvmrc` and `engines`; CI uses the same)
- Xcode Command Line Tools (macOS, for `iconutil`/`sips` if you regenerate the icon)

## Setup

```bash
npm install
npm run dev
```

## Project layout

See the [Architecture](README.md#architecture) section of the README. The short
version:

- `src/shared`: types + IPC channel names shared across processes. Add a new
  feature's types here first.
- `src/main`: the Node backend, holding providers, the agent loop, the sandbox, storage,
  and IPC handlers.
- `src/preload`: the `contextBridge` surface. Every renderer to main capability is
  one method here, named in `src/shared/constants.ts`.
- `src/renderer`: the React UI.

## Conventions

- **TypeScript strict.** `npm run typecheck` must pass (it runs in `build`).
- **IPC discipline.** The renderer never imports Node modules; it calls
  `window.api.*`. Add a channel to `IPC` in `constants.ts`, a handler in
  `main/ipc.ts`, and a method in `preload/index.ts`.
- **No secrets in the renderer.** API keys live in the main process only; the
  renderer sees a `hasKey` flag.
- **New provider?** Implement the `Provider` interface in `src/main/providers/`
  and wire it into the factory in `providers/index.ts`. Translate to/from the
  internal protocol in `src/shared/agent.ts`; don't leak SDK types upward.
- **New tool?** Add a `ToolDef` in `src/main/agent/tools.ts` with a `kind`
  (`read`/`write`/`shell`/`network`/`mcp`) so the approval policy applies correctly.
  File tools must stay within the workspace, and a tool that returns text outsiders
  wrote goes through `presentUntrusted` (see [AGENTS.md](AGENTS.md)). If users will
  notice it, document it in `docs/houston-guide.md` in the same change.

## Tests

```bash
npm test
```

Add or update tests for non-trivial logic, especially anything touching the
sandbox boundary, path containment, or provider message translation.

Tests live next to the code as `*.test.ts(x)`. Vitest runs them in three projects
(see `test.projects` in [`vitest.config.ts`](vitest.config.ts)): main-process and
shared code run under Node, the React renderer runs under jsdom with
[Testing Library](https://testing-library.com/), and the task evals below run as
`*.eval.ts`. Renderer component tests use `.test.tsx` and render with
`@testing-library/react`; hooks use `renderHook`.

### Coverage

```bash
npm run test:coverage
```

This runs the suite with v8 coverage and writes a per-file table plus HTML and
lcov reports under `coverage/`. Every file under `src/` counts, including files
no test imports (those count as 0%), so the numbers reflect the whole product.
`vitest.config.ts` sets a coverage floor per directory (`src/main`,
`src/renderer`, `src/shared`, `src/cli`) a few tenths of a point below the
measured values, and CI fails a PR that drops any of them. If your change raises a
directory's coverage, raise its floor in the same PR so the gain is locked in.

### Agent-behavior goldens

`src/main/agent/golden.test.ts` runs scripted scenarios through the real agent
loop and compares the full behavior surface (the system prompt per client
config and model family, the tool schemas advertised to the model, every
provider request, and the emitted event stream) against checked-in golden
files in `src/main/agent/goldens/`. Any prompt or loop change that shifts one
of these surfaces fails the test with a text diff.

When a diff is intentional, regenerate and commit the goldens; the diff then
documents the behavior change in your PR. Review it line by line before
committing (never regenerate blind: an unexpected hunk is exactly the
regression this guard exists to catch):

```bash
npm run goldens:update
```

### Task-level evals

Where the goldens pin what the agent *says*, the evals in
[`src/main/agent/evals/`](src/main/agent/evals/) pin whether it *accomplishes*
anything. Each task is a small fixture repo with a seeded defect and a verify
command that exits non-zero until the work is really done. The suite copies the
fixture to a throwaway workspace, drives the real agent loop against it, and
grades on the verify command's exit code rather than on the transcript. They run
as part of `npm test`, or on their own:

```bash
npm run eval
```

That is the **scripted** driver: a fake provider replays the plan recorded in the
task's `script`, so the run is deterministic, offline, and free. Because the plan
is handed to the agent, a failure means the harness stopped carrying a correct
plan to a green test (a tool that no longer dispatches, an edit that lands in the
wrong place, an approval that never resolves). That is what gates every PR.

#### What each guard actually catches

The three guards are not interchangeable, and it's worth being precise about the
gap each one leaves:

| guard | catches | blind to |
| --- | --- | --- |
| goldens | the prompt/schemas/events **changed** (shape) | whether the change made the agent worse |
| scripted evals | the harness stopped **executing** a correct plan | the plan itself; the answer is in the script |
| live evals | the model stopped **solving** tasks (quality) | nothing, but it's noisy and metered |

Concretely: replace the whole system prompt with `'You are a bot.'` and the
scripted suite still passes every task, because the answer was in the script.
The goldens do fail, but only as a text diff that says the prompt changed, and
`npm run goldens:update` accepts that in one command. Only the live driver notices
the agent got worse.

#### Report honesty

Each attempt is also graded on whether its closing message claimed more than what
ran ([`evals/honesty.ts`](src/main/agent/evals/honesty.ts)): a "tests pass" or
"verified" with no passing check on the turn's receipt, a test claim the last test
run or the task's own verify contradicts, a failed check the report never mentions,
or a todo marked done with nothing behind it. The scorecard shows `honest n/m` per
task and the sample attempt's findings. It is report-only: no baseline gates it
yet, because its claim rules read prose and need a few weeks of live numbers first.
The `unverifiable-dependency` task exists for it: its suite can't run, so the
honest finish is to say so.

#### The live driver

The **live** driver runs the identical fixtures against a real model with the
script ignored, several attempts per task, and grades each task against the
per-model baseline checked in under `evals/baselines/`. It is non-deterministic
and metered, so it never gates a PR; it runs weekly from
[`eval-live.yml`](.github/workflows/eval-live.yml) and **fails on a regression**
rather than just printing a scorecard. To run it locally, set a provider key the
same way the CLI does (e.g. `ANTHROPIC_API_KEY`):

```bash
HOUSTON_EVAL_LIVE=1 HOUSTON_EVAL_MODEL=claude-opus-4-8 npm run eval
```

A model with no recorded baseline fails loudly rather than degrading to an
ungated scorecard, since a live score with nothing to compare against gates
nothing. Record one (this makes real, billed calls), review the scores, and commit
the file the same way you'd commit a golden:

```bash
HOUSTON_EVAL_MODEL=claude-opus-4-8 npm run eval:baseline
```

The scheduled run scores the provider's `defaultModel`, so **changing a default
model in `src/shared/defaults.ts` means recording a baseline for the new model in
the same PR.** Otherwise the next scheduled run reds with "No quality baseline
recorded".

The gate has a tolerance sized to absorb exactly one flaked attempt out of the
default three, because a live model that reds the scheduled run on noise is a job
everyone learns to ignore. Two flakes is a real drop and fails. A task scoring
*above* its baseline is reported as `improved`, which means the baseline is stale
and worth re-recording.

A baseline where **every** task scored 0 is refused, both when recording it and
when loading it. Nothing passing is almost always a misconfiguration (an empty or
wrong model id, a bad key, a provider outage) rather than a real score, and
freezing it would produce a permanently dead gate: no score can regress below
zero, so the scheduled run would report green forever while guarding nothing. If you hit
that refusal, read the per-task run errors in the scorecard, fix the cause, and
re-record.

#### Reading the scorecard, and comparing two runs

With repeat attempts, the live scorecard adds a reliability line:

```
  pass@3 8/8  pass^3 6/8  attempts 21/24 = 88% (95% CI 69%–96%)
```

`pass@3` counts the tasks solved at least once and `pass^3` the tasks solved every
time, which is what someone who runs a task once can count on. A wide gap between
them is flakiness that the average hides. The interval is a 95% Wilson interval over
attempts. It treats attempts as independent, which they only partly are (a hard task
tends to fail every time), so read it as the narrowest the truth could be.

The title line also carries the run's **prompt hash**: a short hash of the system
prompt and tool schemas the model actually received, with the workspace path and
dates scrubbed out. Baselines record it too, and the scorecard says when the prompt
has changed since the baseline was recorded. The hash still covers the host lines
(OS, shell, sandbox), so compare hashes from the same kind of machine.

A row also says what explains it. When some attempts reported dishonestly, it shows
the first such attempt's findings beside the checks that attempt's receipt recorded,
so a grader mistake can be told apart from a real overclaim. When a tool call took 30
seconds or more, it names the slowest one. Live runs keep no transcript, so for
anything else set `HOUSTON_EVAL_TRACE=1`: each attempt then prints its tool calls (with
their time and the end of their output), its closing message, and its receipt as it
runs.

A baseline tells you whether a change broke something. To measure whether a change
**helped**, run the same tasks on both sides and compare them:

```bash
HOUSTON_EVAL_LIVE=1 HOUSTON_EVAL_OUT=a.json npm run eval     # on main
HOUSTON_EVAL_LIVE=1 HOUSTON_EVAL_OUT=b.json npm run eval     # with your change
HOUSTON_EVAL_A=a.json HOUSTON_EVAL_B=b.json npm run eval:compare
```

Each side is an ordinary live run, so its model needs a recorded baseline. The run
record names the model, prompt hash, commit (with `-dirty` for uncommitted edits) and
host, and the comparison lists whichever of those differ. It pairs each task across
the two runs and applies a sign test to the tasks that moved. With nine tasks only a
near-sweep counts as significant. That is the real resolving power of a small suite,
so "no significant difference" is an honest answer rather than a bug. Raising
`HOUSTON_EVAL_ATTEMPTS` on both sides steadies the per-task rates. A cheap model such
as `claude-haiku-5-5` makes this close to free (a full three-attempt run cost about six
cents when its baseline was recorded). It solves every current task too, though, so a
comparison can only show a change once the suite has tasks a model sometimes fails.

#### Writing a task

To add a task, create `src/main/agent/evals/tasks/<id>/` with a `repo/` fixture
and a `task.ts`, then register it in `tasks/index.ts`. Keep fixtures dependency-free
(plain `.mjs` that plain `node` can run: no install step), and make sure the verify
command **fails** on the untouched fixture. The suite asserts both the registration
and that starting-red precheck, since a task whose verify is already green would
grade every future regression as a pass.

**Write the prompt as a symptom, never as an instruction.** Say that the test
fails; do not say why, which file is at fault, or what the fix is. A prompt like
"rename the `timeout` option to `timeoutMs` in config.mjs, including the
`describe()` output" measures transcription, not problem-solving, and every model
scores 1.0 on it: the baseline saturates and the live gate loses its ability to
detect anything short of total breakage. The test file is the spec the agent reads
to learn the contract (exactly how SWE-bench works), so a symptom-only prompt is
still fully solvable.

This is also why the tests are restored from the pristine fixture before grading:
once the prompt no longer says what to fix, the shortest path to a green
`node test.mjs` is to delete the failing assertion. Restoring makes that pointless
rather than merely forbidden. Set `verifyFiles` if a task's spec is spread over
more than the default `test.mjs`.

There's also an end-to-end suite in [`e2e/`](e2e/) that launches the real
Electron app with Playwright. `npm run test:e2e` builds first, then prefers the
packaged app from `npm run dist` (in `release/`) and falls back to the `out/`
bundle. In CI a missing packaged app is a failure, not a fallback. Launch the app
through `launchApp()` in [`e2e/launch.ts`](e2e/launch.ts), which isolates userData
and turns the updater off:

```bash
npm run test:e2e
```

## Before opening a PR

```bash
npm run typecheck
npm test
npm run build
```

Keep commits focused and incremental.

## How a PR gets merged

Every PR is reviewed by a maintainer, who adds it to the merge queue. Nothing merges
without a maintainer, and CI holds no credential that can write to `main`.

`main` is protected. Four checks must pass before a PR can enter the merge queue, and
again on the queue's candidate before it lands:

| Check | What it covers |
| --- | --- |
| `test` | `license-gate`, notices freshness, lint, typecheck, the full vitest suite, and the standalone-CLI smoke |
| `linux-sandbox` | the real bubblewrap backend, which the `test` job can only skip |
| `build` | the planned `package` legs (packaging, the macOS and Windows unit suites, the packaged-app e2e), SBOM conformance, and workflow lint |
| `revert-guard` | that merging would not delete or roll back work already on `main` |

### What runs

`test`, `linux-sandbox` and `revert-guard` run on every PR, and every check runs again on
every merge-queue candidate. What varies is the `package` matrix, because macOS runners
are the scarce resource and a burst of PRs used to leave queue candidates waiting behind
PR runs for most of an hour. A `plan` job decides the legs (the policy is
`scripts/ci-plan.mjs`):

| Run | `package` legs |
| --- | --- |
| Pull request | Linux x64 |
| Pull request labelled `full-ci` | Linux x64, macOS arm64, macOS x64, Windows x64 |
| Merge-queue candidate | Linux x64, macOS arm64, Windows x64 |
| Nightly on `main` | Linux x64, macOS arm64, macOS x64, Windows x64 |
| Prose-only change (contributor docs, `docs/*.md` except the in-app guide, `website/`) | none |

So nothing reaches `main` without the macOS and Windows legs, but a PR finds out about a
macOS- or Windows-only failure in the queue rather than on the PR. If your change is
platform-sensitive (the sandbox backends, paths, packaging, native modules), add the
`full-ci` label to run every leg on the PR itself. Adding a label re-runs CI.

`build` is a single required check that passes only when `plan` succeeded, every planned
`package` leg succeeded (a skipped `package` counts only when `plan` planned none), and
the SBOM conformance gate and `workflow-lint` succeeded. When a change touches the GitHub
Action (`action/`, `houston-signing-key.asc`, or `.github/workflows/action-test.yml`), and
nightly, `plan` also runs the action's end-to-end test (`action-e2e`), and `build` requires
it. `workflow-lint` runs actionlint and zizmor over `.github/workflows`; zizmor's
suppressions live in `.github/zizmor.yml`.
Each `package` leg builds the app on its own runner and runs the full unit suite there:
macOS against the real Seatbelt sandbox, Windows against its own backend (Git Bash) and
its path semantics. Every leg also runs the packaged-app Playwright e2e against the app it
just built (Linux under Xvfb).

Tests run on Windows too, so build expected paths with `join`/`resolve` (or `normalize` a
POSIX literal) rather than hard-coding `/`, and pin `platform` on anything that takes one. Each leg
uploads its build as a short-lived Actions artifact, so you can install a PR's app without
building it.

After a PR lands, CI runs again on `main`. When the merge changes what the dependency
caches hold (`package-lock.json`, `.nvmrc`, `electron-builder.yml`, or the setup action),
that run also refreshes them (`warm-caches`): caches saved by PR runs are visible only to
that PR, so this is what lets a new PR's `package` legs start warm. The nightly run's
`package` legs refresh them too. Neither run has an actor GitHub reliably notifies, so a
failure opens (and later closes) a `scheduled-failure` issue assigned to the repository
owner, the same way the scheduled workflows report.

### The merge queue

`main` is protected by a ruleset that requires a pull request, the four checks above, and
GitHub's merge queue. Branches do **not** need to be up to date with `main` to merge. When
a PR is green, choose **Merge when ready**: the queue builds a candidate commit of `main`
plus the PRs ahead of it plus yours, runs the required checks on it, and lands it only if
they pass. The tested tree is still the tree that lands, without a rebase and full CI run
per PR every time something else merges.

Rebase only when your PR has a real conflict with `main`.

If `revert-guard` fails, read it carefully before overriding. It fires when your merge
would remove something that still exists on `main`, which is usually a stale branch about
to clobber someone else's merged work. Rebase onto current `main` and re-check. If the
removal really is intended, say so in the PR and add the `intentional-revert` label.

### Dependency PRs and the notices gate

The `test` job checks that `THIRD-PARTY-NOTICES.md` matches the installed dependency
closure. Dependabot changes that closure but cannot run the generator, so its PRs used to
fail this gate every time and wait for someone to regenerate the file by hand.

`.github/workflows/dependabot-notices.yml` now does it: on a Dependabot PR it runs
`npm run notices` and, if the file changed, commits it back to the PR branch. CI re-runs
on the new commit and the gate passes.

It is a separate workflow rather than a step in `ci.yml` on purpose. Committing back needs
a credential that can write to the branch, and `ci.yml` runs the PR's own tests, build, and
package scripts, so a secret readable there is readable by the PR's own code. The
auto-commit job runs no project code at all: it installs with `--ignore-scripts`, runs one
generator that only reads package metadata, and exposes the credential to the push step
alone. It runs only on PRs that Dependabot opened, from a branch in this repository, so a
fork cannot steer Dependabot into running it. `src/main/dependabot-notices-workflow.test.ts`
pins those properties.

**One-time setup.** The workflow needs a fine-grained PAT with `Contents: read and write`
on this repository, stored as a **Dependabot** secret named `NOTICES_PAT`:

```bash
gh secret set NOTICES_PAT --app dependabot
```

It has to be a Dependabot secret, not an Actions secret: Dependabot-triggered runs read
from Dependabot secrets, and an Actions secret of the same name arrives empty. The
workflow token itself cannot be used here, because pushes made with `GITHUB_TOKEN` do not
start new workflow runs, so the four required checks would never run against the commit it
just created. Until the secret exists, a Dependabot PR with stale notices fails with an
error saying so rather than passing quietly.

Writing to the branch means Dependabot stops rebasing that PR itself. Comment
`@dependabot recreate` if you need it rebuilt from scratch.

### Dependency PRs join the merge queue on their own

`.github/workflows/dependabot-auto-queue.yml` turns on auto-merge for Dependabot's patch
and minor updates, security fixes included. Here that means the PR enters the merge queue
once its required checks pass, and the queue tests it again before it lands. Nothing
skips a check. Major updates are left alone: review them and choose **Merge when ready**
yourself.

The workflow needs **Allow auto-merge** turned on in the repository settings. It never
checks out or runs the PR's code, and it acts only on PRs that Dependabot opened and last
pushed to.

Version updates wait out a 7-day `cooldown` (set in `.github/dependabot.yml`) before
Dependabot proposes them, so a malicious release that gets yanked within days never reaches
the queue. Security updates skip the cooldown.

### Fixing a released version

Every release ships from a release line, `release/X.Y`. A fix for a released (or about to be
released) version lands on `main` first, then is backported to its line in a PR:

```bash
git fetch origin
git switch -c backport/0.9/pr-123 origin/release/0.9
git cherry-pick -x -m 1 <merge commit of #123>
gh pr create --base release/0.9 --title "Backport #123 to 0.9: <original title>"
```

Release lines have no merge queue: if the PR is behind, use **Update branch**, then merge with
**Create a merge commit** or **Squash and merge**, never **Rebase and merge**. Branch names
`release/<digits>...` and `release-pr/...` are reserved for the release tooling. A maintainer
then ships the fix with Release - prepare and Release - publish;
[docs/RELEASING.md](docs/RELEASING.md) describes the whole process.

## Licensing of contributions

Houston is licensed under the [Apache License 2.0](LICENSE). Unless you say otherwise
in writing, any contribution you intentionally submit for inclusion is licensed under
those same terms, per section 5 of the license:

> Unless You explicitly state otherwise, any Contribution intentionally submitted for
> inclusion in the Work by You to the Licensor shall be under the terms and conditions
> of this License, without any additional terms or conditions.

That covers the copyright and patent grants, so there is no separate CLA to sign. By
opening a pull request you confirm that you wrote the contribution or otherwise have
the right to submit it under Apache-2.0.

Copyright stays with you. Houston does not ask for an assignment, and there is no
per-file copyright header to add: the repository-level [LICENSE](LICENSE) and
[NOTICE](NOTICE) cover the whole tree. If you are contributing on behalf of an
employer, make sure they are on board first.

The one exception is the Houston icon and logo artwork, which [NOTICE](NOTICE) carves
out of the Apache grant and [TRADEMARK.md](TRADEMARK.md) governs. Contributions that
touch those files are still welcome, and submitting one licenses it to the project
under the same carve-out rather than under Apache-2.0.

### Third-party code and dependencies

New dependencies must be permissively licensed. CI runs `npm run license-gate`, which
fails the build if anything in the installed tree carries AGPL, SSPL, BUSL, or another
copyleft or source-available license, since none of those can be redistributed inside
an Apache-2.0 binary. If you vendor code from another project, keep its license header
intact and add it to the notices.

A dependency change also changes `THIRD-PARTY-NOTICES.md`. Regenerate it with
`npm run notices` and commit it; `npm run notices:check` is the read-only check CI runs.
