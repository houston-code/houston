# Contributing to Houston

Thanks for your interest! Houston is an Electron + React + TypeScript desktop
app. This guide covers local setup and the conventions the codebase follows.

Everyone taking part is expected to follow the
[Code of Conduct](CODE_OF_CONDUCT.md). To report a vulnerability, follow
[SECURITY.md](SECURITY.md) rather than opening an issue.

## Prerequisites

- A supported OS: macOS 12 Monterey+ (Apple Silicon or Intel), Windows 10+ (x64), or
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
  (`read`/`write`/`shell`) so the approval policy applies correctly. File tools
  must stay within the workspace.

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
scripted suite still passes all eight tasks, because the answer was in the script.
The goldens do fail, but only as a text diff that says the prompt changed, and
`npm run goldens:update` accepts that in one command. Only the live driver notices
the agent got worse.

#### The live driver

The **live** driver runs the identical fixtures against a real model with the
script ignored, several attempts per task, and grades each task against the
per-model baseline checked in under `evals/baselines/`. It is non-deterministic
and metered, so it never gates a PR; it runs nightly from
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

The gate has a tolerance sized to absorb exactly one flaked attempt out of the
default three, because a live model that reds the nightly on noise is a nightly
everyone learns to ignore. Two flakes is a real drop and fails. A task scoring
*above* its baseline is reported as `improved`, which means the baseline is stale
and worth re-recording.

A baseline where **every** task scored 0 is refused, both when recording it and
when loading it. Nothing passing is almost always a misconfiguration (an empty or
wrong model id, a bad key, a provider outage) rather than a real score, and
freezing it would produce a permanently dead gate: no score can regress below
zero, so the nightly would report green forever while guarding nothing. If you hit
that refusal, read the per-task run errors in the scorecard, fix the cause, and
re-record.

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

There's also an end-to-end smoke test in [`e2e/`](e2e/) that launches the real
Electron app with Playwright and checks the UI mounts. `npm run test:e2e` builds
first, then prefers the packaged app from `npm run dist` (in `release/`) and
falls back to the `out/` bundle:

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

Every PR is reviewed and merged by a maintainer. Nothing merges automatically, and CI
holds no credential that can write to `main`.

`main` is protected. Four checks must pass before the merge button unlocks:

| Check | What it covers |
| --- | --- |
| `test` | `license-gate`, notices freshness, lint, typecheck, the full vitest suite, and the standalone-CLI smoke |
| `linux-sandbox` | the real bubblewrap backend, which the `test` job can only skip |
| `build` | Linux packaging, so a packaging regression cannot land |
| `revert-guard` | that merging would not delete or roll back work already on `main` |

Branches must also be **up to date with `main`** before merging. This is what makes the
checks meaningful: CI tests `refs/pull/N/merge`, so keeping the branch current means the
tree CI tested is the tree that lands. If `main` moves while your PR is open, GitHub will
ask you to update the branch and CI will re-run. That is working as intended, not a
hiccup.

If `revert-guard` fails, read it carefully before overriding. It fires when your merge
would remove something that still exists on `main`, which is usually a stale branch about
to clobber someone else's merged work. Rebase onto current `main` and re-check. If the
removal really is intended, say so in the PR and add the `intentional-revert` label.

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

### Third-party code and dependencies

New dependencies must be permissively licensed. CI runs `npm run license-gate`, which
fails the build if anything in the installed tree carries AGPL, SSPL, BUSL, or another
copyleft or source-available license, since none of those can be redistributed inside
an Apache-2.0 binary. If you vendor code from another project, keep its license header
intact and add it to the notices.
