import { describe, it, expect } from 'vitest'
import { spawnSync } from 'node:child_process'
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
    const script = `source /dev/stdin; ${fields
      .map((f) => `for v in "\${${f}[@]}"; do printf '\\t%s = %s\\n' ${f} "$v"; done`)
      .join('; ')}`
    const r = spawnSync('bash', ['-c', script], { input: out['aur/PKGBUILD'], encoding: 'utf8' })
    expect(r.stderr).toBe('')
    expect(`pkgbase = houston-bin\n${r.stdout}\npkgname = houston-bin\n`).toBe(out['aur/.SRCINFO'])
  })

  it('PKGBUILD installs the bundle and a houston wrapper', () => {
    const pkgbuild = out['aur/PKGBUILD']
    expect(pkgbuild).toContain('pkgname=houston-bin\n')
    expect(pkgbuild).toContain('/usr/lib/houston/houston-cli.cjs')
    expect(pkgbuild).toContain('"${pkgdir}/usr/bin/houston"')
  })

  it('.SRCINFO validates its inputs too', () => {
    expect(() => aurSrcinfo({ ...params, version: '1.2.3\n\tdepends = evil' })).toThrow()
  })
})
