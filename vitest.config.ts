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
    // Opt-in coverage: `npm run test:coverage` selects the v8 provider and writes
    // a text summary plus HTML and lcov reports under coverage/. It is deliberately
    // NOT wired into the default `npm test` (or CI's gate) — instrumentation adds
    // runtime and we have no baseline to threshold against yet, so turning it on
    // by default would only slow every run. The excludes drop everything that
    // isn't product logic under test: generated files, config, type-only modules,
    // tests/fixtures/evals, build output, and the desktop/e2e shells.
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'lcov'],
      reportsDirectory: './coverage',
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
      ]
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
            'website/tools/**/*.test.mjs'
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
