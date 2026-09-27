import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it, expect } from 'vitest'

// NOTICE carves the Houston icon and logo artwork out of the Apache grant by listing each
// file. A brand file that isn't listed is, by default, Apache-2.0: anyone could copy or
// modify it. These checks keep the list complete and consistent with TRADEMARK.md.

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const notice = readFileSync(join(ROOT, 'NOTICE'), 'utf8')
const trademark = readFileSync(join(ROOT, 'TRADEMARK.md'), 'utf8')

// The indented path lines of NOTICE's "That artwork is:" block.
const listed = (() => {
  const block = notice.slice(notice.indexOf('That artwork is:'), notice.indexOf('together with any work derived'))
  return [...block.matchAll(/^ {4}(\S+)$/gm)].map((m) => m[1])
})()

// Image files under the brand locations. Product screenshots are ordinary Apache-2.0
// content, not artwork, so screens/ is not part of the carve-out.
const IMAGE = /\.(png|ico|icns|svg)$/
function images(dir) {
  const abs = join(ROOT, dir)
  if (!existsSync(abs)) return []
  return readdirSync(abs).flatMap((name) => {
    const p = join(abs, name)
    if (statSync(p).isDirectory()) return name === 'screens' ? [] : images(relative(ROOT, p))
    return IMAGE.test(name) ? [relative(ROOT, p)] : []
  })
}

describe('brand artwork carve-out', () => {
  it('lists files that exist', () => {
    expect(listed.length).toBeGreaterThan(0)
    for (const path of listed) expect(existsSync(join(ROOT, path)), path).toBe(true)
  })

  it('covers the program that draws the icon', () => {
    expect(listed).toContain('scripts/make-icon.mjs')
  })

  it('covers every icon/logo image in build/ and website/public/', () => {
    const unlisted = [...images('build'), ...images('website/public')].filter((p) => !listed.includes(p))
    // A new brand image must be added to NOTICE's list (and TRADEMARK.md), or it ships
    // under Apache-2.0 like the rest of the repo.
    expect(unlisted).toEqual([])
  })

  it('names the same files in TRADEMARK.md (apple-touch icons as a group)', () => {
    for (const path of listed) {
      if (path.includes('apple-touch-icon')) continue
      expect(trademark, path).toContain(`\`${path}\``)
    }
    expect(trademark).toContain('apple-touch')
  })
})
