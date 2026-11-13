import { describe, it, expect } from 'vitest'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { aurSrcinfo, isReleaseVersion, renderAll, renderTemplate, validate } from './render-packaging.mjs'

const params = { version: '1.2.3', sha256: 'a'.repeat(64) }

describe('isReleaseVersion', () => {
  it('accepts only plain x.y.z', () => {
    expect(isReleaseVersion('0.9.0')).toBe(true)
    expect(isReleaseVersion('0.9.0-rc.1')).toBe(false)
    expect(isReleaseVersion(undefined)).toBe(false)
  })
})

describe('validate', () => {
  it('accepts a plain release version and a hex sha256', () => {
    expect(() => validate(params)).not.toThrow()
  })

  it.each(['1.2', '1.2.3-beta', 'v1.2.3', '1.2.3"; system("x")', '', undefined])(
    'rejects version %j',
    (version) => {
      expect(() => validate({ ...params, version })).toThrow(/invalid version/)
    },
  )

  it.each(['A'.repeat(64), 'a'.repeat(63), `${'a'.repeat(63)}'`, ''])('rejects sha256 %j', (sha256) => {
    expect(() => validate({ ...params, sha256 })).toThrow(/invalid sha256/)
  })
})

describe('renderTemplate', () => {
  it('fills every placeholder', () => {
    expect(renderTemplate('v{{VERSION}} {{SHA256}} {{VERSION}}', params)).toBe(
      `v1.2.3 ${params.sha256} 1.2.3`,
    )
  })

  it('fails on a placeholder it does not know', () => {
    expect(() => renderTemplate('{{VERSION}} {{LICENSE_SHA}}', params)).toThrow(/LICENSE_SHA/)
  })
})

/**
 * Run a wrapper script with its exec line swapped for a print of NODE_COMPILE_CACHE,
 * under exactly `env` (plus PATH), and return what Node would have been given.
 */
function wrapperCache(wrapper, env) {
  const script = wrapper.replace(/^exec .*$/m, 'printf %s "${NODE_COMPILE_CACHE-unset}"')
  expect(script).not.toBe(wrapper)
  const r = spawnSync('sh', ['-c', script], { encoding: 'utf8', env: { PATH: process.env.PATH, ...env } })
  expect(r.stderr).toBe('')
  return r.stdout
}

describe('renderAll', () => {
  const out = renderAll(params)

  it('pins the release asset and hash in the Homebrew formula', () => {
    const rb = out['homebrew/houston.rb']
    expect(rb).toContain('url "https://github.com/houston-code/houston/releases/download/v1.2.3/houston-cli.cjs"')
    // Homebrew scans the version from the release URL; an explicit one fails
    // `brew audit --strict` as redundant.
    expect(rb).not.toMatch(/^\s*version /m)
    expect(rb).toContain(`sha256 "${params.sha256}"`)
    expect(rb).toContain('depends_on "node"')
  })

  it('Homebrew wrapper points Node at a per-OS compile cache unless the user set one', () => {
    const rb = out['homebrew/houston.rb']
    expect(rb).toContain('"$HOME/Library/Caches/houston/compile-cache"')
    expect(rb).toContain('"${XDG_CACHE_HOME:-$HOME/.cache}/houston/compile-cache"')
    const guard = 'if [ -z "${NODE_COMPILE_CACHE+set}" ]; then export NODE_COMPILE_CACHE="#{cache_dir}"; fi\n'
    expect(rb).toContain(guard)
    expect(rb.indexOf(guard)).toBeLessThan(rb.indexOf('exec "#{formula_opt_bin("node")}/node"'))
    // The same line as the shell sees it once Ruby fills in each OS's directory.
    for (const [dirExpr, env, expected] of [
      ['$HOME/Library/Caches/houston/compile-cache', { HOME: '/mac/u' }, '/mac/u/Library/Caches/houston/compile-cache'],
      ['${XDG_CACHE_HOME:-$HOME/.cache}/houston/compile-cache', { HOME: '/home/u' }, '/home/u/.cache/houston/compile-cache'],
    ]) {
      const wrapper = `#!/bin/bash\n${guard.replace('#{cache_dir}', dirExpr)}exec node\n`
      expect(wrapperCache(wrapper, env)).toBe(expected)
      expect(wrapperCache(wrapper, { ...env, NODE_COMPILE_CACHE: '/mine' })).toBe('/mine')
      expect(wrapperCache(wrapper, { ...env, NODE_COMPILE_CACHE: '' })).toBe('')
    }
  })

  it('pins the release asset and hash in the PKGBUILD', () => {
    const pkgbuild = out['aur/PKGBUILD']
    expect(pkgbuild).toContain("pkgver='1.2.3'\n")
    expect(pkgbuild).toContain(`sha256sums=('${params.sha256}')`)
    expect(pkgbuild).toContain("depends=('nodejs>=22')")
  })

  // makepkg --printsrcinfo needs an Arch host, so source the PKGBUILD in bash and print
  // the same fields the way it would: the two files must agree, field for field.
  it.skipIf(process.platform === 'win32')('writes a PKGBUILD that bash reads back as the .SRCINFO', () => {
    const fields = ['pkgdesc', 'pkgver', 'pkgrel', 'url', 'arch', 'license', 'depends', 'provides', 'conflicts', 'source', 'sha256sums']
    // A real file, not /dev/stdin: the Linux CI sandbox has no /dev/stdin.
    const dir = mkdtempSync(join(tmpdir(), 'houston-pkgbuild-'))
    const pkgbuild = join(dir, 'PKGBUILD')
    writeFileSync(pkgbuild, out['aur/PKGBUILD'])
    const script = `source "$1"; ${fields
      .map((f) => `for v in "\${${f}[@]}"; do printf '\\t%s = %s\\n' ${f} "$v"; done`)
      .join('; ')}`
    const r = spawnSync('bash', ['-c', script, 'bash', pkgbuild], { encoding: 'utf8' })
    rmSync(dir, { recursive: true, force: true })
    expect(r.stderr).toBe('')
    expect(`pkgbase = houston-bin\n${r.stdout}\npkgname = houston-bin\n`).toBe(out['aur/.SRCINFO'])
  })

  it('PKGBUILD installs the bundle and a houston wrapper', () => {
    const pkgbuild = out['aur/PKGBUILD']
    expect(pkgbuild).toContain('pkgname=houston-bin\n')
    expect(pkgbuild).toContain('/usr/lib/houston/houston-cli.cjs')
    expect(pkgbuild).toContain('"${pkgdir}/usr/bin/houston"')
  })

  it('PKGBUILD wrapper points Node at a compile cache unless the user set one', () => {
    const dir = mkdtempSync(join(tmpdir(), 'houston-aur-pkg-'))
    try {
      const pkgbuild = join(dir, 'PKGBUILD')
      writeFileSync(pkgbuild, out['aur/PKGBUILD'])
      const pkgdir = join(dir, 'pkg')
      mkdirSync(join(pkgdir, 'usr/bin'), { recursive: true })
      // Run the real package() with install/chmod stubbed (BSD install lacks -D), so the
      // wrapper under test is the exact text makepkg writes.
      const r = spawnSync(
        'bash',
        ['-c', 'install() { :; }; chmod() { :; }; source "$1"; pkgdir="$2"; package', 'bash', pkgbuild, pkgdir],
        { encoding: 'utf8' }
      )
      expect(r.stderr).toBe('')
      const wrapper = readFileSync(join(pkgdir, 'usr/bin/houston'), 'utf8')
      expect(wrapper.startsWith('#!/bin/sh\n')).toBe(true)
      expect(wrapper).toContain('exec /usr/bin/node /usr/lib/houston/houston-cli.cjs "$@"\n')
      expect(wrapper.indexOf('NODE_COMPILE_CACHE')).toBeLessThan(wrapper.indexOf('exec '))
      expect(wrapperCache(wrapper, { HOME: '/home/u' })).toBe('/home/u/.cache/houston/compile-cache')
      expect(wrapperCache(wrapper, { HOME: '/home/u', XDG_CACHE_HOME: '/xdg' })).toBe('/xdg/houston/compile-cache')
      expect(wrapperCache(wrapper, { HOME: '/home/u', NODE_COMPILE_CACHE: '/mine' })).toBe('/mine')
      expect(wrapperCache(wrapper, { HOME: '/home/u', NODE_COMPILE_CACHE: '' })).toBe('')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('.SRCINFO validates its inputs too', () => {
    expect(() => aurSrcinfo({ ...params, version: '1.2.3\n\tdepends = evil' })).toThrow()
  })
})
