import type { InstallMethod, UpgradeHint } from '../main/install-method'
import type { UpdateCheckResult } from '../main/update-check'
import { stripControlChars } from '../main/tui-wrap'

/**
 * `houston update [--yes]`: check for a newer release now and print the one command
 * that upgrades this copy, for how it was installed. With `--yes` it also runs that
 * command, but only where the package manager upgrades a per-user install by itself
 * (npm, bun, Homebrew). It never adds `sudo`: an install that needs it fails with the
 * package manager's own message, and the person decides. The install script, the AUR
 * and a source checkout get the command to run themselves; the commands are fixed
 * strings (see `upgradeHint`), so nothing from the network chooses what runs.
 */

export const UPDATE_USAGE = `Usage: houston update [--yes]
  Checks for a newer Houston and prints the command that upgrades this install.
  --yes   run that command too (npm, bun and Homebrew installs; never with sudo)
`

/** One program run: no shell, the arguments as given. */
export interface UpgradeStep {
  program: string
  args: string[]
}

/**
 * The steps `--yes` runs for an install method, or null where Houston only says what
 * to run. Each matches `upgradeHint(method).fix` word for word (a test holds them
 * together), so what is printed is what runs.
 */
export function upgradeSteps(method: InstallMethod): UpgradeStep[] | null {
  switch (method) {
    case 'npm':
      return [{ program: 'npm', args: ['i', '-g', '@houston-code/cli@latest'] }]
    case 'bun':
      return [{ program: 'bun', args: ['add', '-g', '@houston-code/cli@latest'] }]
    case 'homebrew':
      return [
        { program: 'brew', args: ['update'] },
        { program: 'brew', args: ['upgrade', 'houston'] }
      ]
    default:
      return null
  }
}

export interface UpdateCliDeps {
  version: string
  method: InstallMethod
  hint: UpgradeHint
  check: () => Promise<UpdateCheckResult>
  /** Run one step with the terminal attached; resolves to its exit code. */
  run: (step: UpgradeStep) => Promise<number>
  out: (s: string) => void
  err: (s: string) => void
}

/** Route `houston update [--yes]`. Returns the exit code. */
export async function runUpdateCommand(args: string[], deps: UpdateCliDeps): Promise<number> {
  let yes = false
  for (const a of args) {
    if (a === '--yes') yes = true
    else if (a === '-h' || a === '--help') {
      deps.out(UPDATE_USAGE)
      return 0
    } else {
      deps.err(`houston: update takes no ${a.startsWith('-') ? `option ${stripControlChars(a)}` : `argument "${stripControlChars(a)}"`}\n${UPDATE_USAGE}`)
      return 2
    }
  }

  const result = await deps.check()
  if (result.status === 'current') {
    deps.out(`Houston ${deps.version} is the latest release.\n`)
    return 0
  }
  if (result.status === 'newer') {
    const { latest, headline } = result.update
    deps.out(`Houston ${latest} is available (you have ${deps.version}).${headline ? ` ${headline}` : ''}\n`)
  } else {
    deps.out(
      deps.version === 'dev' || deps.version === '0.0.0'
        ? 'This is a development build, so there is no release to compare it with.\n'
        : "Couldn't reach the release feed to see whether a newer Houston is out.\n"
    )
  }

  const steps = upgradeSteps(deps.method)
  if (!yes || !steps) {
    deps.out(`${capitalize(deps.hint.line)}\n`)
    if (yes && !steps) deps.out('--yes upgrades only npm, bun and Homebrew installs; for this one, follow the line above.\n')
    return 0
  }
  // With no answer from the feed (rate limited, say) the package manager still knows
  // what is newest, so the steps run; only a known-current install has nothing to do.
  for (const step of steps) {
    deps.out(`$ ${[step.program, ...step.args].join(' ')}\n`)
    let code: number
    try {
      code = await deps.run(step)
    } catch (e) {
      deps.err(`houston: couldn't run ${step.program}: ${(e as Error).message}\n`)
      return 1
    }
    if (code !== 0) {
      deps.err(
        `houston: ${step.program} exited with ${code}. If it needs permissions, fix the install folder's ownership rather than running it with sudo.\n`
      )
      return 1
    }
  }
  deps.out(`Updated. Run houston -v to check the version.\n`)
  return 0
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1)
}
