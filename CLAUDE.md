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
