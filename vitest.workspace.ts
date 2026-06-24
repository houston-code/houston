import react from '@vitejs/plugin-react'
import { defineWorkspace } from 'vitest/config'

/**
 * Two Vitest projects, split by runtime so each test runs in the right place:
 *
 *  - `node`     — Electron main process + shared utilities. Pure Node, no DOM.
 *  - `renderer` — the React UI. Runs under jsdom with @testing-library, so
 *                 `.test.tsx` component tests and DOM-dependent helpers work.
 *
 * Both `extends` the base `vitest.config.ts` for the shared `@shared` alias. The
 * include globs are disjoint, so every test file runs in exactly one project.
 */
export default defineWorkspace([
  {
    extends: './vitest.config.ts',
    test: {
      name: 'node',
      environment: 'node',
      include: ['src/main/**/*.test.ts', 'src/shared/**/*.test.ts']
    }
  },
  {
    extends: './vitest.config.ts',
    plugins: [react()],
    test: {
      name: 'renderer',
      environment: 'jsdom',
      include: ['src/renderer/**/*.test.{ts,tsx}'],
      setupFiles: ['./src/renderer/test/setup.ts']
    }
  }
])
