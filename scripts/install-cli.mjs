import { chmodSync, existsSync, lstatSync, mkdirSync, rmSync, symlinkSync } from 'node:fs'
import { delimiter, dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Put the standalone CLI on your PATH as a bare `houston` command, so
 * `houston -i` launches the interactive terminal the way `houston -p` scripts a
 * one-shot run — no `node out/cli/houston-cli.cjs …` prefix.
 *
 * This symlinks the already-built bundle (out/cli/houston-cli.cjs, produced by
 * scripts/build-cli.mjs) into a bin directory rather than copying it, so a later
 * `npm run build:cli` is picked up with no reinstall. It deliberately does NOT
 * go through `npm link`/`npm i -g .`: that would install the whole Electron app
 * globally and fire its `postinstall` (electron-rebuild) — heavy and pointless
 * for a headless box. `npm link` still works via the package `bin` field for
 * anyone who prefers it.
 *
 * POSIX only (macOS/Linux). On Windows use `npm link` (npm writes a `.cmd`
 * shim) or invoke the bundle directly.
 */

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const CLI_ARTIFACT = resolve(root, 'out/cli/houston-cli.cjs')
const LINK_NAME = 'houston'

/** Expand a leading `~` to `home`, then resolve to an absolute path. */
export function resolveTarget(input, home) {
  let p = input
  if (p === '~') p = home
  else if (p.startsWith('~/')) p = join(home, p.slice(2))
  return isAbsolute(p) ? p : resolve(p)
}

/**
 * Decide which directory the `houston` symlink goes in. An explicit override
 * wins; otherwise default to ~/.local/bin, the conventional per-user bin dir.
 *
 * This is deterministic on purpose. The earlier heuristic picked the first of
 * several candidates that happened to be on PATH, so it chose different dirs
 * depending on the exact PATH the installer inherited — a login shell and an
 * `npm run` child can expose different PATHs, so the same machine could resolve
 * to ~/.local/bin one time and ~/bin the next. That surprised users and didn't
 * match the documented default. We still report whether the dir is on PATH so
 * the caller can print the add-to-PATH hint. Pure — takes the environment as
 * input so it's unit-testable.
 *
 * @returns {{ dir: string, onPath: boolean }}
 */
export function chooseBinDir({ home, pathValue = '', override } = {}) {
  const entries = pathValue.split(delimiter).filter(Boolean)
  const dir = override ? resolveTarget(override, home) : join(home, '.local', 'bin')
  return { dir, onPath: entries.includes(dir) }
}

/** The shell line that puts `dir` on PATH, for the "not on PATH yet" hint. */
export function pathHint(dir) {
  return `export PATH="${dir}:$PATH"`
}

function isSymlink(p) {
  try {
    return lstatSync(p).isSymbolicLink()
  } catch {
    return false
  }
}

function fail(message) {
  console.error(message)
  process.exit(1)
}

function main(argv) {
  if (argv.includes('-h') || argv.includes('--help')) {
    console.log(
      `Install the Houston CLI as \`${LINK_NAME}\` on your PATH.\n\n` +
        `Usage: node scripts/install-cli.mjs [--dir <bin-dir>]\n\n` +
        `Prefer \`npm run install:cli\`, which builds the bundle first. Symlinks\n` +
        `out/cli/houston-cli.cjs into a bin directory (default: ~/.local/bin) so you\n` +
        `can run \`${LINK_NAME} -i\`. Re-run any time; it replaces the existing link.`
    )
    return
  }

  if (process.platform === 'win32') {
    fail(
      'Automatic install is POSIX-only. On Windows, run `npm link` (npm writes a ' +
        '`houston.cmd` shim from the package `bin`), or invoke the bundle directly: ' +
        '`node out\\cli\\houston-cli.cjs -i`.'
    )
  }

  if (!existsSync(CLI_ARTIFACT)) {
    fail(
      `CLI not built yet. Run \`npm run install:cli\` (which builds first), or ` +
        `\`npm run build:cli\` then re-run this.\nExpected: ${CLI_ARTIFACT}`
    )
  }

  const dirIdx = argv.indexOf('--dir')
  const override = dirIdx !== -1 ? argv[dirIdx + 1] : undefined
  if (dirIdx !== -1 && !override) fail('--dir needs a path argument.')

  const home = process.env.HOME || process.env.USERPROFILE || ''
  if (!home) fail('Could not resolve your home directory (HOME is unset).')

  const { dir, onPath } = chooseBinDir({ home, pathValue: process.env.PATH, override })
  mkdirSync(dir, { recursive: true })

  const link = join(dir, LINK_NAME)
  // Idempotent: drop any existing link/file (incl. a dangling symlink) first.
  if (isSymlink(link) || existsSync(link)) rmSync(link, { force: true })
  symlinkSync(CLI_ARTIFACT, link)
  chmodSync(CLI_ARTIFACT, 0o755)

  console.log(`Linked ${link} -> ${CLI_ARTIFACT}`)
  if (onPath) {
    console.log(`\nRun it:  ${LINK_NAME}`)
  } else {
    console.log(
      `\n${dir} isn't on your PATH yet. Add it (then restart your shell):\n` +
        `  ${pathHint(dir)}\n\nThen:  ${LINK_NAME}`
    )
  }
}

// Run only when invoked directly, so the pure helpers can be imported by tests.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2))
}
