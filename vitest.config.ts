import { resolve } from 'node:path'
import react from '@vitejs/plugin-react'
import { coverageConfigDefaults, defineConfig } from 'vitest/config'

/**
 * Three Vitest projects, split by runtime so each test runs in the right place:
 *
 *  - `node`     — Electron main process + shared utilities. Pure Node, no DOM.
 *  - `renderer` — the React UI. Runs under jsdom with @testing-library, so
 *                 `.test.tsx` component tests and DOM-dependent helpers work.
 *  - `evals`    — task-level agent evals (`*.eval.ts`). Same runtime as `node`,
 *                 but its own project so `npm run eval` can select it, and so the
 *                 live driver (a real, metered provider) is always an explicit
 *                 opt-in rather than something a bare `vitest run` could trip.
 *
 * Vitest 4 removed the standalone `vitest.workspace.ts` / `defineWorkspace`, so the
 * split now lives here under `test.projects`. Each project `extends: true` to
 * inherit the shared `@shared` path alias below. The include globs are disjoint,
 * so every test file runs in exactly one project.
 */
export default defineConfig({
  resolve: {
    alias: {
      '@shared': resolve(__dirname, 'src/shared')
    }
  },
  test: {
    // Regenerates the uncommitted src/main/agent/guide-content.ts before any test
    // file is imported. See scripts/vitest-global-setup.mjs.
    globalSetup: ['./scripts/vitest-global-setup.mjs'],
    // Coverage: `npm run test:coverage` selects the v8 provider and writes a text
    // summary plus HTML and lcov reports under coverage/. A bare `npm test` stays
    // uninstrumented; CI's Linux `test` job passes --coverage so the thresholds below
    // gate every PR.
    //
    // `include` makes the denominator all product source, not just the files some
    // test happens to import: without it a module no test touches (App.tsx, the
    // preload bridge) is simply absent and the headline number is inflated. Untested
    // files now count as 0%. The excludes drop everything that isn't product logic
    // under test: generated files, config, type-only modules, tests/fixtures/evals,
    // build output, and the desktop/e2e shells.
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'lcov'],
      reportsDirectory: './coverage',
      include: ['src/**/*.{ts,tsx,mts,mjs}'],
      exclude: [
        ...coverageConfigDefaults.exclude,
        '**/*.test.{ts,tsx,mts,mjs}',
        '**/*.d.ts',
        'src/main/agent/evals/**',
        'src/main/agent/goldens/**',
        'src/main/agent/guide-content.ts',
        'src/**/test/**',
        'e2e/**',
        'website/**',
        'build/**',
        'out/**',
        'scripts/**',
        '*.config.{ts,mts,mjs,js}',
        '.claude/**'
      ],
      // A ratchet, not a target: each floor sits a few tenths of a point below the
      // coverage measured when it was set (enough to absorb run-to-run noise from
      // timing-dependent paths, about 0.05), so a PR that lowers a directory's
      // coverage fails CI. When a PR raises coverage, bump the matching floor in the
      // same change. Checked per directory because the layers differ
      // widely (shared logic is near-total, the renderer is not), and one global
      // number would let a drop in one hide behind a gain in another. src/preload has no unit tests (it is exercised by the
      // packaged-app e2e), so it carries no floor.
      thresholds: {
        'src/main/**': { statements: 87.8, branches: 82.4, functions: 83.5, lines: 90 },
        'src/renderer/**': { statements: 70, branches: 69.3, functions: 69.4, lines: 71.8 },
        'src/shared/**': { statements: 95.2, branches: 88, functions: 98.7, lines: 96.1 },
        'src/cli/**': { statements: 78.3, branches: 75.3, functions: 56.5, lines: 79 }
      }
    },
    projects: [
      {
        extends: true,
        test: {
          name: 'node',
          environment: 'node',
          include: [
            'src/main/**/*.test.ts',
            'src/cli/**/*.test.ts',
            'src/shared/**/*.test.ts',
            'scripts/**/*.test.mjs',
            'website/tools/**/*.test.mjs',
            'action/**/*.test.mjs'
          ],
          setupFiles: ['./src/main/test/setup.ts']
        }
      },
      {
        extends: true,
        plugins: [react()],
        test: {
          name: 'renderer',
          environment: 'jsdom',
          include: ['src/renderer/**/*.test.{ts,tsx}'],
          setupFiles: ['./src/renderer/test/setup.ts']
        }
      },
      {
        extends: true,
        test: {
          name: 'evals',
          environment: 'node',
          include: ['src/main/agent/evals/**/*.eval.ts'],
          setupFiles: ['./src/main/test/setup.ts']
        }
      }
    ]
  }
})
