# Contributing to Houston

Thanks for your interest! Houston is an Electron + React + TypeScript desktop
app. This guide covers local setup and the conventions the codebase follows.

## Prerequisites

- macOS on Apple Silicon (arm64)
- Node.js 20+ (22 recommended)
- Xcode Command Line Tools (for `iconutil`/`sips` if you regenerate the icon)

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

Tests live next to the code as `*.test.ts(x)`. Vitest runs them in two projects
(see [`vitest.workspace.ts`](vitest.workspace.ts)): main-process and shared code
run under Node, while the React renderer runs under jsdom with
[Testing Library](https://testing-library.com/). Renderer component tests use
`.test.tsx` and render with `@testing-library/react`; hooks use `renderHook`.

There's also an end-to-end smoke test in [`e2e/`](e2e/) that launches the real
Electron app with Playwright and checks the UI mounts. It runs against the built
bundle, so build first:

```bash
npm run build && npm run test:e2e
```

## Before opening a PR

```bash
npm run typecheck
npm test
npm run build
```

Keep commits focused and incremental. By submitting a contribution you agree to
license it under the project's [MIT License](LICENSE).
