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
fixtures with the script ignored, scoring real per-model task success; it's metered
and non-deterministic, so it never gates a PR (nightly `eval-live.yml` instead). A
task that fails live but passes scripted is a model-capability signal, not a bug.

Two invariants the suite asserts, both worth preserving: every task directory is
registered exactly once, and every fixture's verify command **fails** before the
agent touches it. The second is the load-bearing one — a verify that starts green
grades every future regression as a pass.

Adding a task: drop `tasks/<id>/` with a `repo/` fixture and a `task.ts`, register it
in `tasks/index.ts`. Keep fixtures dependency-free (plain `.mjs`, no install step), and
note that the driver can't be factored into a shared helper: `startRun` takes no
provider parameter, so injection depends on this file's `vi.mock` + deferred
`await import('../loop')`, and `vi.mock` is file-scoped.

## Product self-knowledge

Houston answers questions about its own features (slash commands, skills, hooks,
MCP, permissions, plan mode, sandboxing, settings, etc.) from `docs/houston-guide.md`.
That file is the single source of truth: `scripts/gen-guide.mjs` inlines it into
`src/main/agent/guide-content.ts` (which runs automatically before `build` and
`build:cli`), and it is served to the agent as the built-in `houston-guide` skill
(`BUILTIN_SKILLS` in `src/main/agent/skills.ts`, merged in at the run seam in
`loop.ts`). The system prompt points the agent at that skill.

When you add or change a user-facing feature, update `docs/houston-guide.md` in the
same change and run `npm run gen:guide`. A test in `src/main/agent/skills.test.ts`
fails if the doc and the generated constant drift, so a stale guide is caught in CI.
The built-in slash commands it documents come from `BUILTIN_COMMAND_CATALOG` in
`src/shared/commands.ts` (the one source both clients derive their menus from).

## Competitor mentions

Never name competing tools or products in any artifact in this repo — code, comments,
README, ROADMAP, docs, git commit titles and descriptions, PR text, or anywhere else.
This applies even
when the request is a feature comparison, parity table, "how does this compare to X",
or anything similar: describe the capability or feature on its own terms without naming
the competitor.
