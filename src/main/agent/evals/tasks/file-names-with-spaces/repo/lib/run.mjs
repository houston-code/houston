import { execSync } from 'node:child_process'

/** Run a command line, returning its stdout. Throws with stderr on a non-zero exit. */
export function run(command) {
  return execSync(command, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
}
