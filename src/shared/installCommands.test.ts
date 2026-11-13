import { describe, expect, it } from 'vitest'
import { installCommand, installersFor, type Installer } from './installCommands'

const have = (...xs: Installer[]): Set<Installer> => new Set(xs)

describe('installCommand', () => {
  it('picks the platform package manager that is present', () => {
    expect(installCommand('gh', 'darwin', have('brew'))).toBe('brew install gh')
    expect(installCommand('gh', 'win32', have('winget', 'npm'))).toBe('winget install --id GitHub.cli -e')
    expect(installCommand('rg', 'linux', have('apt-get'))).toBe('sudo apt-get install ripgrep')
    expect(installCommand('rg', 'linux', have('pacman'))).toBe('sudo pacman -S ripgrep')
    expect(installCommand('gh', 'linux', have('dnf'))).toBe('sudo dnf install gh')
  })

  it('never offers a package manager on a platform it does not belong to', () => {
    expect(installCommand('gh', 'darwin', have('apt-get', 'winget'))).toBeNull()
    expect(installCommand('gh', 'win32', have('brew'))).toBeNull()
  })

  it('uses toolchains for formatters and language servers', () => {
    expect(installCommand('fmt:prettier', 'linux', have('npm'))).toBe('npm install -g prettier')
    expect(installCommand('fmt:ruff', 'darwin', have('pipx', 'brew'))).toBe('pipx install ruff')
    expect(installCommand('fmt:ruff', 'darwin', have('brew'))).toBe('brew install ruff')
    expect(installCommand('fmt:rustfmt', 'win32', have('rustup'))).toBe('rustup component add rustfmt')
    expect(installCommand('lsp:go', 'linux', have('go'))).toBe('go install golang.org/x/tools/gopls@latest')
    expect(installCommand('lsp:typescript', 'darwin', have('npm'))).toBe('npm install -g typescript-language-server typescript')
  })

  it('returns null when nothing here can install it, or for an unknown item', () => {
    expect(installCommand('fmt:prettier', 'linux', have('brew'))).toBeNull()
    expect(installCommand('nope', 'linux', have('brew', 'npm'))).toBeNull()
  })

  it('names the installers that would work', () => {
    expect(installersFor('gh', 'win32')).toEqual(['winget'])
    expect(installersFor('fmt:black', 'linux')).toEqual(['pipx', 'brew'])
  })

  it('holds only fixed text: no line breaks or shell chaining in any command', () => {
    const all: Installer[] = ['brew', 'apt-get', 'dnf', 'pacman', 'winget', 'npm', 'pipx', 'go', 'rustup']
    const keys = ['gh', 'rg', 'fmt:prettier', 'fmt:ruff', 'fmt:black', 'fmt:rustfmt', 'fmt:gofmt', 'lsp:typescript', 'lsp:python', 'lsp:go', 'lsp:rust', 'lsp:clangd']
    for (const platform of ['darwin', 'linux', 'win32'] as NodeJS.Platform[]) {
      for (const k of keys) {
        const cmd = installCommand(k, platform, new Set(all))
        if (cmd) expect(cmd).not.toMatch(/[\r\n;&|`$]/)
      }
    }
  })
})
