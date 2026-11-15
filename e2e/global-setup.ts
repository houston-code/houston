import { rmSync } from 'node:fs'
import { inspectableCopy } from './fuses'
import { findPackagedApp, LAUNCH_EXECUTABLE_ENV } from './launch'

/**
 * Once per run: when a packaged app exists and its fuses refuse the Node inspector (as a
 * shipped build does), make the inspectable copy the launch tests drive (see
 * inspectableCopy in fuses.ts) and hand its path to the workers through the environment.
 * The returned function is the global teardown that removes the copy.
 */
export default function globalSetup(): (() => void) | undefined {
  const packaged = findPackagedApp()
  if (!packaged) return undefined
  const copy = inspectableCopy(packaged)
  if (!copy) return undefined
  process.env[LAUNCH_EXECUTABLE_ENV] = copy.executable
  // Windows can keep the executable locked for a moment after the last app process
  // exits (a scanner still reading it), so the removal retries rather than failing the run.
  return () => rmSync(copy.root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
}
