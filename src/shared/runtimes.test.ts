import { describe, expect, it } from 'vitest'
import {
  installSuggestion,
  missingRuntime,
  missingRuntimeHint,
  runtimeById,
  runtimeMissingLine,
  shellExitCode
} from './runtimes'

describe('missingRuntime', () => {
  it.each([
    ['/bin/bash: line 1: node: command not found', 'node'],
    ['bash: npm: command not found', 'node'],
    ['zsh: command not found: python3', 'python'],
    ['sh: 1: go: not found', 'go'],
    ['env: node: No such file or directory', 'node'],
    ["env: ‘node’: No such file or directory", 'node'],
    ['/bin/bash: line 3: cargo: command not found', 'rust'],
    ['bash: bunx: command not found', 'bun']
  ])('detects %s', (output, id) => {
    expect(missingRuntime(output, 127)?.id).toBe(id)
  })

  it('detects the Windows cmd.exe message with its exit code 9009', () => {
    const out = "'node' is not recognized as an internal or external command,\r\noperable program or batch file."
    expect(missingRuntime(out, 9009)?.id).toBe('node')
    expect(missingRuntime(out, 1)).toBeNull()
  })

  it('requires exit status 127', () => {
    expect(missingRuntime('/bin/bash: line 1: node: command not found', 1)).toBeNull()
    expect(missingRuntime('/bin/bash: line 1: node: command not found', null)).toBeNull()
  })

  it('ignores commands that are not runtimes', () => {
    expect(missingRuntime('bash: frobnicate: command not found', 127)).toBeNull()
    expect(missingRuntime('', 127)).toBeNull()
  })

  it('reports the first runtime named when several are missing', () => {
    const out = 'bash: python3: command not found\nbash: node: command not found'
    expect(missingRuntime(out, 127)?.id).toBe('python')
  })

  it('does not match a runtime name that is only part of a word', () => {
    expect(missingRuntime('bash: nodemon: command not found', 127)).toBeNull()
  })
})

describe('shellExitCode', () => {
  it('reads the last exit-code trailer', () => {
    expect(shellExitCode('out\n[exit code: 0]\nmore\n[exit code: 127]')).toBe(127)
    expect(shellExitCode('no trailer')).toBeNull()
  })
})

describe('installSuggestion', () => {
  const node = runtimeById('node')
  it('uses Homebrew on macOS when present', () => {
    expect(installSuggestion(node, { platform: 'darwin', hasBrew: true })).toEqual({
      command: 'brew install node',
      url: node.url
    })
  })

  it('falls back to the download page on macOS without Homebrew, and on Linux', () => {
    expect(installSuggestion(node, { platform: 'darwin', hasBrew: false })).toEqual({ url: node.url })
    expect(installSuggestion(node, { platform: 'linux', hasBrew: false })).toEqual({ url: node.url })
  })

  it('uses winget on Windows', () => {
    expect(installSuggestion(node, { platform: 'win32', hasBrew: false }).command).toBe(
      'winget install --id OpenJS.NodeJS.LTS -e'
    )
  })

  it('uses the official installer for Rust on POSIX', () => {
    expect(installSuggestion(runtimeById('rust'), { platform: 'linux', hasBrew: false }).command).toMatch(
      /^curl .*sh\.rustup\.rs \| sh$/
    )
  })
})

describe('user and model text', () => {
  it('tells the model not to install system packages itself', () => {
    const hint = missingRuntimeHint(runtimeById('node'))
    expect(hint).toMatch(/Node\.js is not installed/)
    expect(hint).toMatch(/Do not install system packages yourself/)
  })

  it('formats the terminal line with and without a command, free of em dashes', () => {
    const withCmd = runtimeMissingLine({ label: 'Node.js', installCommand: 'brew install node', url: 'u' })
    expect(withCmd).toContain('brew install node')
    expect(runtimeMissingLine({ label: 'Node.js', url: 'https://x' })).toContain('https://x')
    expect(withCmd).not.toContain('—')
    expect(missingRuntimeHint(runtimeById('go'))).not.toContain('—')
  })
})
