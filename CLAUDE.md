# Houston — repo guidance

## Client parity (GUI / TUI / headless)

Houston has three clients over one shared agent core: the GUI renderer, the
interactive TUI (`src/main/tui.ts`), and the one-shot headless CLI
(`src/main/headless.ts`). They all consume the same `AgentEvent` stream
(`src/shared/agent.ts`) and resolve interactive tool calls through the same
resolver pattern (`resolveApproval` / `resolveQuestion` / `resolvePlan`). Keep
them from drifting:

- **Every `AgentEvent` variant must be handled by all three consumers.** Each
  event switch ends in an exhaustiveness guard (`assertNever`, or a
  `const _: never = e`), so adding a variant to the union is a compile error until
  every client handles it. Do not defeat the guard with a catch-all `default` that
  swallows unknown events.
- **Any event the loop blocks on must be resolved by all three clients.** A
  blocking tool (approval, `ask_user`, `present_plan`) awaits its resolver; a
  client that drops the event hangs the run. The GUI resolves interactively, the
  TUI prompts, and headless auto-resolves non-interactively. The parity test in
  `tui.test.ts` (`resolves every blocking interaction`) is the runtime backstop.
- When you add an `AgentEvent` or a blocking tool, wire the GUI, the TUI, and
  headless in the same change, and add/extend the parity coverage.

## Agent-behavior goldens

`src/main/agent/golden.test.ts` pins the agent's behavior surface — the system
prompt (per client config and model family), the tool schemas sent to the model,
provider request assembly, and the `AgentEvent` stream — against golden files in
`src/main/agent/goldens/`. Any change to `prompt.ts`, tool descriptions/schemas
in `tools.ts`, or `loop.ts` request/event wiring fails this test; that failure is
the feature. Review the diff, and when the change is intentional regenerate with
`npm run goldens:update` and commit the updated goldens in the same change (the
golden diff documents the behavior change for review). Never hand-edit a golden
file, and never regenerate without reading the diff.

## Task-level evals

`src/main/agent/evals/` grades whether the harness carries a real unit of work to
a green test, where the goldens above only pin what the agent *says*. Each task is
a fixture repo with a seeded defect plus a verify command that exits non-zero until
the work is done; the suite copies it to a throwaway workspace, drives the real
`startRun`, and grades on that command's exit code — never on the transcript.

The same fixtures run under two drivers. `npm run eval` (also part of `npm test`,
so it gates every PR) uses a **scripted** fake provider that replays the plan in the
task's `script`: deterministic, offline, and free. The plan is handed to the agent,
so a scripted failure is a *harness* regression by construction — a tool that
stopped dispatching, an edit landing in the wrong place, an approval that never
resolves. `HOUSTON_EVAL_LIVE=1 npm run eval` drives a **live** model over the same
fixtures with the script ignored, several attempts per task, graded against the
per-model baseline in `evals/baselines/`; it's metered and non-deterministic, so it
never gates a PR (nightly `eval-live.yml` instead).

**Know which guard catches what — they are not interchangeable.** The goldens catch
a *shape* change (the prompt moved, a schema changed) but cannot tell you the change
made the agent worse; that's a human reading the diff, and `goldens:update` accepts
it in one command. The scripted evals catch *execution* but not judgement: replace
the system prompt with `'You are a bot.'` and all eight still pass, because the
answer is in the script. Only the live driver catches a *quality* regression, which
is why it grades against a baseline and fails rather than printing a scorecard — and
why a model with no baseline fails loudly instead of silently running ungated.
Record a baseline with `npm run eval:baseline`, review the scores, and commit it like
a golden. The tolerance absorbs exactly one flaked attempt of the default three; a
nightly that reds on model noise is one everyone learns to ignore.

**An all-zero baseline is refused on both record and load** (`evals/baseline.ts`), and
every env var is resolved through `evals/config.ts` where empty means unset. Both guards
exist because of one incident: `HOUSTON_EVAL_MODEL ?? default` let a set-but-EMPTY env var
through (`??` only catches null/undefined, and Actions' `env: ${{ inputs.x || '' }}` sets
`''` on a cron run), so the model id was empty, every call failed, and the recorder wrote
0 for all eight tasks. That file is shape-valid and completely inert: nothing can regress
below zero, so it would have reported green forever. When touching this area, keep the rule
that a misconfigured run must fail loudly rather than record or load a dead gate.

Three invariants the suite asserts, all worth preserving: every task directory is
registered exactly once; every fixture's verify command **fails** before the agent
touches it (a verify that starts green grades every future regression as a pass);
and a run whose only work was rewriting the test grades as a FAILURE, because the
test is restored from the pristine fixture before grading.

That last one pairs with a rule for authoring tasks: **the prompt states the
symptom, never the fix.** Say the test fails; don't say why, which file, or what to
change. A prompt that dictates the edit measures transcription, every model scores
1.0, the baseline saturates, and the live gate can no longer see anything short of
total breakage. The test file is the spec the agent reads (as in SWE-bench), so a
symptom-only prompt stays solvable — and it's *why* the test must be restored before
grading: once the prompt doesn't say what to fix, deleting the failing assertion is
the shortest path to green.

Adding a task: drop `tasks/<id>/` with a `repo/` fixture and a `task.ts`, register it
in `tasks/index.ts`. Keep fixtures dependency-free (plain `.mjs`, no install step), and
note that the driver can't be factored into a shared helper: `startRun` takes no
provider parameter, so injection depends on this file's `vi.mock` + deferred
`await import('../loop')`, and `vi.mock` is file-scoped.

## Product self-knowledge

Houston answers questions about its own features (slash commands, skills, hooks,
MCP, permissions, plan mode, sandboxing, settings, etc.) from `docs/houston-guide.md`.
That file is the single source of truth: `scripts/gen-guide.mjs` inlines it into
`src/main/agent/guide-content.ts`, and it is served to the agent as the built-in
`houston-guide` skill (`BUILTIN_SKILLS` in `src/main/agent/skills.ts`, merged in at
the run seam in `loop.ts`). The system prompt points the agent at that skill.

**`guide-content.ts` is generated and must never be committed** (it's in
`.gitignore`). Every consumer regenerates it first — `postinstall`, `pretypecheck`,
`prelint`, `build`, `build:cli`, and Vitest's `globalSetup`
(`scripts/vitest-global-setup.mjs`, which covers `npx vitest` on a single file too) —
so you never run `npm run gen:guide` by hand and the constant can't go stale. It was
committed until 2026-07, and because `JSON.stringify` puts the entire guide on one
~37KB line, every pair of concurrent PRs that touched the guide conflicted there.
That conflict has no hunk granularity, so resolving it by picking a side silently
drops the other PR's docs — the failure mode in "Avoiding silent-clobber merges"
below. If you ever need the constant on disk without running a script, run
`npm run gen:guide`; don't re-add it to git.

When you add or change a user-facing feature, update `docs/houston-guide.md` in the
same change; that's the whole workflow. The built-in slash commands it documents come
from `BUILTIN_COMMAND_CATALOG` in `src/shared/commands.ts` (the one source both
clients derive their menus from).

## Competitor mentions

Never name competing tools or products in any artifact in this repo — code, comments,
README, ROADMAP, docs, git commit titles and descriptions, PR text, or anywhere else.
This applies even
when the request is a feature comparison, parity table, "how does this compare to X",
or anything similar: describe the capability or feature on its own terms without naming
the competitor.

## Avoiding silent-clobber merges

A PR whose branch is based on an out-of-date `main` can, when finalized wrong, **silently
revert other PRs that merged while it was open** — deleting their files and reverting their
code as if intended. This happened once (#551 reverted #548/#549/#550: ~3,200 lines, 8
files) and CI did not catch it, because the reverted features' *tests were removed in the
same commit*, so nothing failed. The main branch stays green while shipping a regression.

The root cause is finalizing a branch by capturing a **stale working tree** on top of the
current `main` — most easily via `git reset --soft origin/main && git commit` when the tree
predates recent merges. Git records the absence of everything newer as intentional deletions.

Rules to prevent it:

- **Finalize by rebasing, never by resetting a stale tree.** Before the final push, `git
  fetch origin` and `git rebase origin/main`. A rebase replays your commits onto the real
  current `main`, so files it does not touch are preserved; a `reset --soft` + commit of a
  stale tree drops them. Never `git reset --soft origin/main` to squash unless the tree
  already contains everything on `main`.
- **Diff against the pre-merge tip, not CI.** Before pushing, `git diff --stat origin/main`
  and confirm every deletion and large removal is one you intend. Green CI is not proof —
  co-reverted tests hide the regression.
- **A rebase can re-introduce the bug.** When you rebase a fix onto a `main` that changed
  the same lines, `git rerere` may auto-replay an old resolution that re-reverts newer work.
  Disable it for the operation (`git config rerere.enabled false`) or inspect every
  auto-resolved hunk; prefer a fresh 3-way cherry-pick onto current `main` over replaying a
  hand-resolved commit.

**Automated backstop.** The `revert-guard` CI job runs `scripts/merge-revert-guard.mjs` on
every PR: it fails the check if merging would delete a file that still exists on `main`, or
roll back a large chunk of a file `main` touched recently. It runs against
`refs/pull/N/merge` — this PR already merged into `main` — so it sees the tree that merging
would actually produce, and branch protection requires a branch to be up to date before it can
merge, so that tree is the one that lands. A *deliberate* removal (dead code, a real revert) is
acknowledged with the `intentional-revert` label, which sets `ALLOW_REVERT=1`. Keep the guard's
logic and unit tests (`scripts/merge-revert-guard.test.mjs`) in sync if you change the merge
flow, and `src/main/ci-workflow.test.ts` pins that the job is wired correctly.
