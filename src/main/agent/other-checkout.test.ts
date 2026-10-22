import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { otherCheckout, otherCheckoutHint } from './other-checkout'

describe('otherCheckout (real repo)', () => {
  let root: string
  let main: string
  let wtA: string
  let wtB: string
  let unrelated: string
  const git = (args: string[], cwd: string): void => {
    execFileSync('git', ['-c', 'user.email=t@example.com', '-c', 'user.name=Test', ...args], { cwd, stdio: 'pipe' })
  }

  beforeAll(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'houston-other-checkout-')))
    main = join(root, 'repo')
    mkdirSync(main)
    git(['init', '-q', '-b', 'main'], main)
    mkdirSync(join(main, 'src'))
    writeFileSync(join(main, 'src', 'a.txt'), 'a\n')
    git(['add', '.'], main)
    git(['commit', '-qm', 'init'], main)
    // Nested under the main checkout, like the app's own worktrees, and a sibling.
    wtA = join(main, '.houston', 'worktrees', 'a')
    wtB = join(root, 'wt-b')
    git(['worktree', 'add', '-q', '-b', 'a', wtA], main)
    git(['worktree', 'add', '-q', '-b', 'b', wtB], main)
    unrelated = join(root, 'other')
    mkdirSync(unrelated)
    git(['init', '-q'], unrelated)
  }, 30_000)

  afterAll(() => rmSync(root, { recursive: true, force: true }))

  it('flags the main checkout from a linked worktree, including a subdirectory of it', async () => {
    expect(await otherCheckout(wtA, [wtA], main)).toEqual({ root: main, main: true })
    expect(await otherCheckout(wtA, [wtA], join(main, 'src'))).toEqual({ root: main, main: true })
  })

  it('flags a sibling linked worktree', async () => {
    expect(await otherCheckout(wtA, [wtA], wtB)).toEqual({ root: wtB, main: false })
  })

  it('flags a linked worktree from the main checkout', async () => {
    expect(await otherCheckout(main, [main], wtB)).toEqual({ root: wtB, main: false })
  })

  it('says nothing inside the workspace or an added root', async () => {
    expect(await otherCheckout(wtA, [wtA], wtA)).toBeNull()
    expect(await otherCheckout(wtA, [wtA], join(wtA, 'src'))).toBeNull()
    expect(await otherCheckout(wtA, [wtA, wtB], wtB)).toBeNull()
  })

  it('says nothing outside any repository or in an unrelated one', async () => {
    expect(await otherCheckout(wtA, [wtA], tmpdir())).toBeNull()
    expect(await otherCheckout(wtA, [wtA], unrelated)).toBeNull()
  })

  it('says nothing when the workspace is not a repository', async () => {
    expect(await otherCheckout(unrelated + '-missing', [unrelated + '-missing'], main)).toBeNull()
  })

  it('tolerates a corrupt .git pointer', async () => {
    const broken = join(root, 'broken')
    mkdirSync(broken, { recursive: true })
    writeFileSync(join(broken, '.git'), 'not a pointer\n')
    expect(await otherCheckout(wtA, [wtA], broken)).toBeNull()
  })
})

describe('otherCheckoutHint', () => {
  it('names the checkout and how to get back', () => {
    const s = otherCheckoutHint('/repo/src', { root: '/repo', main: true }, '/repo/.houston/worktrees/a')
    expect(s).toContain("the repository's main checkout (\"/repo\")")
    expect(s).toContain('cd "/repo/.houston/worktrees/a"')
    expect(otherCheckoutHint('/wt', { root: '/wt', main: false }, '/ws')).toContain('another worktree of this repository')
  })
})
