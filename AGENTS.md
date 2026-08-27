# Houston — repo guidance

Notes for anyone changing this repository, human or agent. This file carries the rules
that are easy to break by accident and expensive to unbreak. [README.md](README.md) has
the architecture, [CONTRIBUTING.md](CONTRIBUTING.md) the full workflow and the reasoning
behind the guards summarized here.

## Commands

```bash
npm run typecheck      # TypeScript strict (also runs inside build)
npm test               # vitest: node + jsdom projects, plus the scripted evals
npm run build          # electron-vite build
npm run lint
npm run goldens:update # regenerate agent goldens after an intentional change
```

Run `typecheck`, `test`, and `build` before opening a PR.

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

`src/main/agent/golden.test.ts` pins the agent's behavior surface — the system prompt
(per client config and model family), the tool schemas sent to the model, provider
request assembly, and the `AgentEvent` stream — against golden files in
`src/main/agent/goldens/`. Any change to `prompt.ts`, tool descriptions or schemas in
`tools.ts`, or `loop.ts` request/event wiring fails this test, and that failure is the
feature.

- Read the diff before accepting it, then regenerate with `npm run goldens:update` and
  commit the goldens in the same change; the golden diff is how the behavior change
  gets reviewed.
- Never hand-edit a golden file, and never regenerate without reading the diff.
- On a merge conflict inside a golden, regenerate from the merged source rather than
  picking a side: resolving by hand silently reverts whichever branch you did not pick.

See [CONTRIBUTING.md](CONTRIBUTING.md#agent-behavior-goldens) for what this guard does
and does not catch.

## Task-level evals

`src/main/agent/evals/` grades whether the harness carries a real unit of work to a
green test, where the goldens above only pin what the agent *says*. Each task is a
fixture repo with a seeded defect plus a verify command that exits non-zero until the
work is done; the suite copies it to a throwaway workspace, drives the real `startRun`,
and grades on that command's exit code, never on the transcript. `npm run eval` (part
of `npm test`) uses the scripted driver and gates every PR;
`HOUSTON_EVAL_LIVE=1 npm run eval` drives a real model against the baselines in
`evals/baselines/` and runs nightly instead.

[CONTRIBUTING.md](CONTRIBUTING.md#task-level-evals) covers what each guard catches and
how to author a task. The invariants to preserve when changing this code:

- **A misconfigured run must fail loudly rather than record or load a dead gate.** An
  all-zero baseline is refused on both record and load (`evals/baseline.ts`), and every
  env var resolves through `evals/config.ts` where empty means unset. Both guards exist
  because a set-but-empty model id once produced a shape-valid baseline of all zeros:
  nothing can regress below zero, so it would have reported green forever.
- **Every fixture's verify command must fail before the agent touches it.** A verify
  that starts green grades every future regression as a pass.
- **The prompt states the symptom, never the fix.** A prompt that dictates the edit
  measures transcription, every model scores 1.0, and the live gate goes blind to
  anything short of total breakage.
- **Tests are restored from the pristine fixture before grading**, so a run whose only
  work was deleting the failing assertion grades as a failure.
- Every task directory is registered exactly once, and fixtures stay dependency-free
  (plain `.mjs`, no install step).
- The driver cannot be factored into a shared helper: `startRun` takes no provider
  parameter, so injection depends on the eval file's own `vi.mock` plus a deferred
  `await import('../loop')`, and `vi.mock` is file-scoped.

## Product self-knowledge

Houston answers questions about its own features (slash commands, skills, hooks, MCP,
permissions, plan mode, sandboxing, settings) from `docs/houston-guide.md`. That file is
the single source of truth: `scripts/gen-guide.mjs` inlines it into
`src/main/agent/guide-content.ts`, and it is served to the agent as the built-in
`houston-guide` skill (`BUILTIN_SKILLS` in `src/main/agent/skills.ts`, merged in at the
run seam in `loop.ts`). The system prompt points the agent at that skill.

When you add or change a user-facing feature, update `docs/houston-guide.md` in the same
change; that is the whole workflow. The built-in slash commands it documents come from
`BUILTIN_COMMAND_CATALOG` in `src/shared/commands.ts`, the one source both clients derive
their menus from.

**`guide-content.ts` is generated and must never be committed** (it is in `.gitignore`).
Every consumer regenerates it first — `postinstall`, `pretypecheck`, `prelint`, `build`,
`build:cli`, and Vitest's `globalSetup` — so the constant cannot go stale and you never run
`npm run gen:guide` by hand. It was committed until 2026-07, and because `JSON.stringify`
puts the whole guide on one ~37KB line, concurrent PRs conflicted there with no hunk
granularity, so resolving by picking a side dropped the other PR's docs entirely.

## Security-sensitive code

Houston executes a model's tool calls on the user's machine, so a handful of modules are
the product's actual safety boundary rather than ordinary code. Changes there need tests
for the *denied* path, not only the allowed one, and a security pass before the PR opens:

- `src/main/agent/tools.ts` — file-tool path containment (`realpathWithinRoots`). A path
  that resolves outside the workspace roots, including through a symlink or a dangling
  one, must be refused.
- `src/main/agent/permissions.ts` — permission-rule matching. Subject and pattern are
  canonicalized per kind before comparison (paths anchored to the roots, URL authority
  lowercased, shell commands dequoted) so a re-spelling of a denied subject cannot slip
  past a rule.
- `src/main/sandbox/` — the per-OS sandbox backends and their conformance suite. The
  `linux-sandbox` CI job is the only one that exercises the real bubblewrap backend; the
  `test` job can only skip it.
- `src/main/agent/egress.ts`, `redact.ts`, and `src/main/secrets.ts` — per-destination
  network consent, and the scrub that keeps credentials out of transcripts, logs, and
  subagent output.
- `src/main/agent/untrusted.ts` — fetched web content is attacker-controlled data that
  lands in a context holding file, shell, and network tools. The nonce fence and the
  classifier around it are not advisory; keep them non-optional.

`SECURITY.md` and `docs/sandboxing.md` describe the guarantees these modules are meant to
provide. If a change alters one, update them in the same PR.

## User-facing text

`docs/houston-guide.md` is deliberately excluded from the doc-only CI carve-out in
`scripts/ci-scope.mjs`, because it is compiled into the agent's prompt and pinned by the
goldens: a copy edit there is a behavior change and runs the full suite. Renderer and TUI
strings are ordinary source. Keep both in sync with the feature in the same PR.

## Avoiding silent-clobber merges

A PR whose branch is based on an out-of-date `main` can, when finalized wrong, **silently
revert other PRs that merged while it was open**, deleting their files and reverting their
code as if intended. This happened once (#551 reverted #548, #549, and #550: ~3,200 lines
across 8 files) and CI did not catch it, because the reverted features' tests were removed
in the same commit, so nothing failed. `main` stays green while shipping a regression.

The root cause is finalizing a branch by capturing a **stale working tree** on top of the
current `main`, most easily via `git reset --soft origin/main && git commit` when the tree
predates recent merges. Git records the absence of everything newer as intentional
deletions.

- **Finalize by rebasing, never by resetting a stale tree.** Before the final push,
  `git fetch origin` and `git rebase origin/main`. A rebase replays your commits onto the
  real current `main`, so files it does not touch are preserved. Never
  `git reset --soft origin/main` to squash unless the tree already contains everything on
  `main`.
- **Diff against the pre-merge tip, not CI.** Before pushing, run
  `git diff --stat origin/main` and confirm every deletion and large removal is intended.
  Green CI is not proof, because co-reverted tests hide the regression.
- **A rebase can re-introduce the bug.** Rebasing a fix onto a `main` that changed the same
  lines lets `git rerere` auto-replay an old resolution that re-reverts newer work. Disable
  it for the operation (`git config rerere.enabled false`) or inspect every auto-resolved
  hunk; prefer a fresh 3-way cherry-pick onto current `main` over replaying a hand-resolved
  commit.

**Automated backstop.** The `revert-guard` CI job runs `scripts/merge-revert-guard.mjs` on
every PR and fails if merging would delete a file that still exists on `main`, or roll back
a large chunk of a file `main` touched recently. It runs against `refs/pull/N/merge`, the
tree merging would actually produce. A deliberate removal is acknowledged with the
`intentional-revert` label. Keep the guard's logic and its unit tests
(`scripts/merge-revert-guard.test.mjs`) in sync if you change the merge flow;
`src/main/ci-workflow.test.ts` pins that the job is wired correctly. See
[CONTRIBUTING.md](CONTRIBUTING.md#how-a-pr-gets-merged) for how the required checks fit
together.
