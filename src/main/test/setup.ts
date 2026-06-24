import { join } from 'node:path'

/**
 * Setup for the `node` (main-process) test project.
 *
 * Main-process modules `import … from 'electron'`, and electron's package entry
 * (`node_modules/electron/index.js`) resolves the packaged binary at *require*
 * time: if `path.txt` points at a `dist/` binary that's missing, it shells out
 * to `install.js` to download it. On a cold or partially-extracted
 * `node_modules` (e.g. CI's `npm ci` → `npm test`), the first run's test workers
 * each trigger that on-demand install concurrently and race the extraction —
 * `File exists (os error 17)` → `Electron failed to install correctly` — which
 * flaked the first cold `npm test`.
 *
 * `ELECTRON_OVERRIDE_DIST_PATH` makes that entry return a path immediately,
 * before any existence check or download, so requiring `electron` can never
 * touch the binary. These unit tests never use the real Electron runtime (they
 * stub `app` / `safeStorage` where they need it, and otherwise only import the
 * module for its type-level surface), so the value is just a placeholder path.
 */
process.env.ELECTRON_OVERRIDE_DIST_PATH ||= join(process.cwd(), 'node_modules', 'electron', 'dist')
