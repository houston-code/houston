# Contributing to Houston

Thanks for your interest! Houston is an Electron + React + TypeScript desktop
app. This guide covers local setup and the conventions the codebase follows.

## Prerequisites

- A supported OS: macOS 12 Monterey+ (Apple Silicon or Intel), Windows 10+ (x64), or
  Linux x64 (glibc 2.35+ — Ubuntu 22.04+ / Debian 12+ / Fedora 36+). Each platform+arch
  builds its own artifacts on its own host — native modules and the per-platform binaries
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

- `src/shared` — types + IPC channel names shared across processes. Add a new
  feature's types here first.
- `src/main` — the Node backend: providers, the agent loop, the sandbox, storage,
  and IPC handlers.
- `src/preload` — the `contextBridge` surface. Every renderer→main capability is
  one method here, named in `src/shared/constants.ts`.
- `src/renderer` — the React UI.

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

Add or update tests for non-trivial logic — especially anything touching the
sandbox boundary, path containment, or provider message translation.

Tests live next to the code as `*.test.ts(x)`. Vitest runs them in three projects
(see `test.projects` in [`vitest.config.ts`](vitest.config.ts)): main-process and
shared code run under Node, the React renderer runs under jsdom with
[Testing Library](https://testing-library.com/), and the task evals below run as
`*.eval.ts`. Renderer component tests use `.test.tsx` and render with
`@testing-library/react`; hooks use `renderHook`.

### Agent-behavior goldens

`src/main/agent/golden.test.ts` runs scripted scenarios through the real agent
loop and compares the full behavior surface — the system prompt per client
config and model family, the tool schemas advertised to the model, every
provider request, and the emitted event stream — against checked-in golden
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

The **live** driver runs the identical fixtures against a real model with the
script ignored, which is the only way to see per-model task success move. It is
non-deterministic and metered, so it never gates a PR; it runs nightly from
[`eval-live.yml`](.github/workflows/eval-live.yml) and prints a scorecard. To run
it locally, set a provider key the same way the CLI does (e.g. `ANTHROPIC_API_KEY`):

```bash
HOUSTON_EVAL_LIVE=1 HOUSTON_EVAL_MODEL=claude-opus-4-8 npm run eval
```

To add a task, create `src/main/agent/evals/tasks/<id>/` with a `repo/` fixture
and a `task.ts`, then register it in `tasks/index.ts`. Keep fixtures dependency-free
(plain `.mjs` that plain `node` can run: no install step), and make sure the verify
command **fails** on the untouched fixture. The suite asserts both the registration
and that starting-red precheck, since a task whose verify is already green would
grade every future regression as a pass.

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

Houston is proprietary software (see [LICENSE](LICENSE)), not MIT-licensed. The terms
for accepting outside contributions are being finalized; this note will be updated once
they are settled.
