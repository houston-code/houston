/**
 * Install commands for Houston's optional integrations, per platform and the package
 * managers found on this machine. Settings > Tools offers each one through the
 * integrated terminal, typed in but never run: the user reads it and presses Enter.
 *
 * Every command here is fixed text (no user input is spliced in), so typing it into a
 * shell can't be steered into running something else.
 */

/** The package managers and toolchains a command may use. */
export type Installer = 'brew' | 'apt-get' | 'dnf' | 'pacman' | 'winget' | 'npm' | 'pipx' | 'go' | 'rustup'

/** Installers worth probing for, in the order they're looked up. */
export const INSTALLERS: readonly Installer[] = ['brew', 'apt-get', 'dnf', 'pacman', 'winget', 'npm', 'pipx', 'go', 'rustup']

/** What can be installed: `gh`, `rg`, a formatter (`fmt:<bin>`) or a language server (`lsp:<id>`). */
export type InstallKey = string

type Variant = { with: Installer; command: string; platforms?: NodeJS.Platform[] }

/** A system package, in each OS package manager's spelling. */
function systemPackage(names: {
  brew?: string
  apt?: string
  dnf?: string
  pacman?: string
  winget?: string
}): Variant[] {
  const out: Variant[] = []
  if (names.brew) out.push({ with: 'brew', command: `brew install ${names.brew}`, platforms: ['darwin', 'linux'] })
  if (names.winget) out.push({ with: 'winget', command: `winget install --id ${names.winget} -e`, platforms: ['win32'] })
  if (names.apt) out.push({ with: 'apt-get', command: `sudo apt-get install ${names.apt}`, platforms: ['linux'] })
  if (names.dnf) out.push({ with: 'dnf', command: `sudo dnf install ${names.dnf}`, platforms: ['linux'] })
  if (names.pacman) out.push({ with: 'pacman', command: `sudo pacman -S ${names.pacman}`, platforms: ['linux'] })
  return out
}

/** A Python command-line tool: pipx first, else a system package. */
function pythonTool(name: string): Variant[] {
  return [{ with: 'pipx', command: `pipx install ${name}` }, ...systemPackage({ brew: name })]
}

const RECIPES: Record<InstallKey, Variant[]> = {
  gh: systemPackage({ brew: 'gh', winget: 'GitHub.cli', apt: 'gh', dnf: 'gh', pacman: 'github-cli' }),
  rg: systemPackage({
    brew: 'ripgrep',
    winget: 'BurntSushi.ripgrep.MSVC',
    apt: 'ripgrep',
    dnf: 'ripgrep',
    pacman: 'ripgrep'
  }),
  'fmt:prettier': [{ with: 'npm', command: 'npm install -g prettier' }],
  'fmt:ruff': pythonTool('ruff'),
  'fmt:black': pythonTool('black'),
  'fmt:rustfmt': [{ with: 'rustup', command: 'rustup component add rustfmt' }],
  // gofmt ships with Go itself.
  'fmt:gofmt': systemPackage({ brew: 'go', winget: 'GoLang.Go', apt: 'golang-go', dnf: 'golang', pacman: 'go' }),
  'lsp:typescript': [{ with: 'npm', command: 'npm install -g typescript-language-server typescript' }],
  'lsp:python': [{ with: 'npm', command: 'npm install -g pyright' }, ...pythonTool('pyright')],
  'lsp:go': [{ with: 'go', command: 'go install golang.org/x/tools/gopls@latest' }],
  'lsp:rust': [{ with: 'rustup', command: 'rustup component add rust-analyzer' }],
  'lsp:clangd': systemPackage({ brew: 'llvm', winget: 'LLVM.LLVM', apt: 'clangd', dnf: 'clang-tools-extra', pacman: 'clang' })
}

/**
 * The command that installs `key` here: the first recipe whose installer is present
 * and that suits this platform. Null when nothing found can install it (the UI then
 * says what's needed instead of guessing).
 */
export function installCommand(key: InstallKey, platform: NodeJS.Platform, available: ReadonlySet<Installer>): string | null {
  const recipe = RECIPES[key]
  if (!recipe) return null
  const v = recipe.find((r) => available.has(r.with) && (!r.platforms || r.platforms.includes(platform)))
  return v?.command ?? null
}

/** The installers a recipe could use, for "install one of these first" when none is present. */
export function installersFor(key: InstallKey, platform: NodeJS.Platform): Installer[] {
  return (RECIPES[key] ?? []).filter((r) => !r.platforms || r.platforms.includes(platform)).map((r) => r.with)
}
