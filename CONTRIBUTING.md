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

Tests live next to the code as `*.test.ts(x)`. Vitest runs them in two projects
(see `test.projects` in [`vitest.config.ts`](vitest.config.ts)): main-process and
shared code run under Node, while the React renderer runs under jsdom with
[Testing Library](https://testing-library.com/). Renderer component tests use
`.test.tsx` and render with `@testing-library/react`; hooks use `renderHook`.

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
