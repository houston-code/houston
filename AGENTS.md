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
- **A prompt Houston writes for the user is never shown as their words.** Build it
  with a constructor in `src/shared/promptInvocation.ts` (`commandTurn`, `agentTurn`,
  `shipTurn`, `spawnedTurn`) and send it as an invoked turn (`onInvoke` in the GUI,
  the `prompt` slash result in the TUI); the message carries `invokedAs` and both
  clients render that. A message the loop injects on its own goes through
  `systemNoteMessage()`. `promptVisibility.guard.test.ts` inventories every place a
  user turn is created and fails on a new one until it is classified.

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

## Model knowledge

Everything Houston infers from a model id (price, context window, vision and
reasoning, the Claude request-shape gates, display-order families) lives in
`src/shared/model-facts.ts`, grouped by provider. To support a new model, edit its
provider's section there, add the id to the corpus in
`src/main/providers/model-knowledge.test.ts`, and regenerate
`src/main/providers/goldens/model-knowledge.json` with `-u`; the golden diff is the review
surface for what changed. `model-coverage.test.ts` fails any default or curated cloud-host
model that lacks a price, context window, named display family, tool calling or reasoning
mode, or isn't pinned in that golden. The weekly `model-drift.yml` workflow lists each
provider's models and keeps one "New models available" issue of releases Houston doesn't ship
yet; to stop flagging one deliberately, add it with a reason to
`src/main/providers/model-drift-ignore.json`. Seeding it as a default is separate: `src/shared/defaults.ts`
plus a scoped `backfillDefaultModels` step in `src/main/store.ts`'s `migrate()`.

## Task-level evals

`src/main/agent/evals/` grades whether the harness carries a real unit of work to a
green test, where the goldens above only pin what the agent *says*. Each task is a
fixture repo with a seeded defect plus a verify command that exits non-zero until the
work is done; the suite copies it to a throwaway workspace, drives the real `startRun`,
and grades on that command's exit code, never on the transcript. `npm run eval` (part
of `npm test`) uses the scripted driver and gates every PR;
`HOUSTON_EVAL_LIVE=1 npm run eval` drives a real model against the baselines in
`evals/baselines/` and runs weekly instead. Changing a provider's `defaultModel` in
`src/shared/defaults.ts` needs a baseline for the new model in the same PR, or the scheduled
run reds (it scores the Anthropic default).

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
  lowercased, shell commands dequoted and `$'...'` decoded) so a re-spelling of a denied
  subject cannot slip past a rule. An allow reads a shell command the other way: a
  quoted `*`, `~`, `$`, or space stays distinct from a bare one, and an empty `''` word
  from no word at all, so approving a literal never approves the expansion. Words split
  only on unquoted space, tab, and newline, as in bash: quoted or escaped whitespace is
  kept as written when matched and when "Always allow" saves a rule, so approving
  `find . -delete \ ` never allows `find . -delete`. A deny or ask still collapses all
  whitespace. An allow pattern ending in a lone backslash (one an earlier version saved
  after trimming an escaped space) matches nothing. The
  workspace-escape check and the `cd` skip read a command's words as bash builds them
  (`"cd"k` is `cdk`, `$'/etc'` is `/etc`), so quoting can't hide a path or pass a
  program off as `cd`. The escape check also ends a word at an unquoted operator and
  reads every command substitution that runs as a command, quoted or not (`echo
  x>/etc/y`, `"$(cat /etc/passwd)"`), as it does a string handed to a shell (`bash -c`,
  `eval`, `ssh host '...'`) and a path glued to a one-letter option (`-f/etc/x`), while
  text that never runs (a single-quoted string, a here-document body, a commit message)
  is not read as a command. It reads the word a `${x:-word}`-style default stands for
  (`${x:-/etc/passwd}`) and bash's other tilde forms (`~root`, `~+/..`, `~-`, a `~`
  after a `:` in an assignment). The skip passes only a `cd` or `pushd` whose words name
  a directory in the workspace: a bare `cd`, `cd -`, `popd`, `~+`, a `$`, a glob, or a
  brace (`.[.]` and `{..,}` are `..`) stays gated, and so does a relative name while
  `CDPATH` is set. A command holding a line continuation (backslash-newline) is read
  twice, split as written and with its continuations joined: a deny fires on either
  reading and an allow must cover both, so splitting a word across lines dodges neither.
- `src/main/sandbox/` — the per-OS sandbox backends and their conformance suite. The
  `linux-sandbox` CI job is the only one that exercises the real bubblewrap backend; the
  `test` job can only skip it.
- `src/main/agent/egress.ts`, `redact.ts`, and `src/main/secrets.ts` — per-destination
  network consent, and the scrub that keeps credentials out of transcripts, logs, and
  subagent output.
- `src/main/agent/untrusted.ts` — text outsiders wrote (fetched pages, web search results,
  GitHub issue, pull request, and CI text, MCP results) is attacker-controlled data that lands
  in a context holding file, shell, and network tools. The nonce fence and the classifier
  around it are not advisory; keep them non-optional, and route any new tool that returns
  such text through `presentUntrusted` / `presentUntrustedInline`.

`SECURITY.md` and `docs/sandboxing.md` describe the guarantees these modules are meant to
provide. If a change alters one, update them in the same PR.

## User-facing text

`docs/houston-guide.md` is compiled into the agent's prompt and pinned by the goldens: a
copy edit there is a behavior change, not a doc tweak. Renderer and TUI strings are
ordinary source. Keep both in sync with the feature in the same PR.

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
tree merging would actually produce, and compares it with that merge's own first parent,
the base GitHub built it on. Files the base gained after the merge was built (common while
CI waits in a queue, and for the upper PRs of a stack) therefore don't read as deletions.
A deliberate removal is acknowledged with the
`intentional-revert` label. On Dependabot PRs the generated `package-lock.json` and
`THIRD-PARTY-NOTICES.md` are exempt from the recent-content rule, since an update that
prunes packages shrinks both legitimately. Keep the guard's logic and its unit tests
(`scripts/merge-revert-guard.test.mjs`) in sync if you change the merge flow;
`src/main/ci-workflow.test.ts` pins that the job is wired correctly. See
[CONTRIBUTING.md](CONTRIBUTING.md#how-a-pr-gets-merged) for how the required checks fit
together.

**Releases ship from release lines.** `release/X.Y` branches and `release-pr/vX.Y.Z`
branches belong to the release workflows: never push to them directly, never rebase-merge
into a line, and don't name other branches that way. A fix for a released version lands on
`main` first and is backported by PR. The rules live in `scripts/release-source.mjs` (with
`scripts/release-source.test.mjs` exercising them on a real repository);
[docs/RELEASING.md](docs/RELEASING.md) describes the process.
