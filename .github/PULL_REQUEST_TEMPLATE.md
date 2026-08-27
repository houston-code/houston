<!--
  Keep the description focused on WHY. The diff already shows what changed.
  Delete any checklist line that does not apply to this PR.
-->

## What and why

<!-- What problem does this solve? Link the issue if there is one. -->

## Checklist

- [ ] Tests added or updated, and `npm test` passes locally.
- [ ] `npm run lint` and `npm run typecheck` pass.

Only if they apply:

- [ ] **Client parity.** Houston has three clients over one agent core (GUI, interactive
      terminal, headless). A new `AgentEvent` variant or a new blocking tool must be handled
      by all three in this same PR, or a client hangs. See AGENTS.md.
- [ ] **Goldens.** If this touches `prompt.ts`, tool schemas in `tools.ts`, or `loop.ts`
      request/event wiring, `golden.test.ts` will fail. That failure is the feature: read the
      diff, confirm the behavior change is intended, then regenerate with
      `npm run goldens:update` and commit the goldens here. Never hand-edit a golden.
- [ ] **User-facing feature?** Update `docs/houston-guide.md` in this PR. It is the single
      source of truth the agent answers product questions from.
      (`src/main/agent/guide-content.ts` is generated and must never be committed.)
- [ ] **New dependency?** `npm run license-gate` passes, and `THIRD-PARTY-NOTICES.md` is
      regenerated.
- [ ] No competing tools or products are named anywhere in the diff, including commit
      messages and this PR text. Describe capabilities on their own terms.

## Notes for the reviewer

<!--
  Anything non-obvious: a tradeoff you made, something you deliberately left out,
  or a deletion that looks larger than it is.

  If this PR deletes files that still exist on main, CI's revert guard will block the
  merge. That guard exists because a stale branch once silently reverted three merged
  PRs. Confirm your branch is current first; if the removal really is intended, say so
  here and add the `intentional-revert` label.
-->
