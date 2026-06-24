import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

/**
 * Base config shared by both Vitest projects (see `vitest.workspace.ts`), which
 * `extends` this file. The split mirrors the tsconfig layout: main/shared code is
 * pure Node and runs in the `node` environment, while the React renderer needs a
 * DOM and runs under `jsdom`. Keep cross-project settings (path aliases) here.
 */
export default defineConfig({
  resolve: {
    alias: {
      '@shared': resolve(__dirname, 'src/shared')
    }
  }
})
