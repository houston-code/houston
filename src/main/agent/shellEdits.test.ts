import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync, unlinkSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { changedSince, shellMayEdit, snapshotWorkingTree } from './shellEdits'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'houston-shell-edits-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function git(...args: string[]): void {
  execFileSync('git', args, { cwd: dir, stdio: 'ignore' })
}

/** A repo with two committed files. */
function repo(): void {
  git('init', '-q')
  git('config', 'user.email', 'test@example.com')
  git('config', 'user.name', 'Test')
  git('config', 'commit.gpgsign', 'false')
  writeFileSync(join(dir, 'a.txt'), 'a1\n')
  mkdirSync(join(dir, 'src'))
  writeFileSync(join(dir, 'src', 'b.ts'), 'b1\n')
  git('add', '.')
  git('commit', '-q', '-m', 'init')
}

/** Push a file's mtime into the past, so a rewrite of the same size still reads as one. */
function age(path: string): void {
  const t = new Date(Date.now() - 60_000)
  utimesSync(path, t, t)
}

describe('snapshotWorkingTree / changedSince', () => {
  it('is null outside a git work tree', async () => {
    expect(await snapshotWorkingTree(dir)).toBeNull()
    expect(await snapshotWorkingTree(join(dir, 'gone'))).toBeNull()
  })

  it('reports a tracked file edited, a new file, and a deleted one', async () => {
    repo()
    const before = await snapshotWorkingTree(dir)
    expect(before).not.toBeNull()
    writeFileSync(join(dir, 'a.txt'), 'a2 longer\n')
    writeFileSync(join(dir, 'src', 'gen.ts'), 'generated\n')
    unlinkSync(join(dir, 'src', 'b.ts'))
    expect(await changedSince(before!, dir)).toEqual(['a.txt', join('src', 'b.ts'), join('src', 'gen.ts')])
  })

  it('reports a further edit to a file that was already dirty, and its revert', async () => {
    repo()
    writeFileSync(join(dir, 'a.txt'), 'dirty\n')
    age(join(dir, 'a.txt'))
    const before = await snapshotWorkingTree(dir)
    writeFileSync(join(dir, 'a.txt'), 'dirtier\n')
    expect(await changedSince(before!, dir)).toEqual(['a.txt'])

    age(join(dir, 'a.txt'))
    const dirty = await snapshotWorkingTree(dir)
    git('checkout', '--', 'a.txt') // back to the committed content: no longer listed
    expect(await changedSince(dirty!, dir)).toEqual(['a.txt'])
  })

  it('does not count a read, a stage, or a commit of an unchanged dirty file', async () => {
    repo()
    writeFileSync(join(dir, 'a.txt'), 'dirty\n')
    age(join(dir, 'a.txt'))
    const before = await snapshotWorkingTree(dir)
    expect(await changedSince(before!, dir)).toEqual([])
    git('add', 'a.txt')
    expect(await changedSince(before!, dir)).toEqual([])
    git('commit', '-q', '-m', 'two')
    expect(await changedSince(before!, dir)).toEqual([])
  })

  it('ignores ignored files', async () => {
    repo()
    writeFileSync(join(dir, '.gitignore'), 'out/\n')
    git('add', '.gitignore')
    git('commit', '-q', '-m', 'ignore')
    const before = await snapshotWorkingTree(dir)
    mkdirSync(join(dir, 'out'))
    writeFileSync(join(dir, 'out', 'bundle.js'), 'x\n')
    expect(await changedSince(before!, dir)).toEqual([])
  })

  it('reports paths relative to a workspace below the repo top, leaving out the rest', async () => {
    repo()
    const ws = join(dir, 'src')
    const before = await snapshotWorkingTree(ws)
    writeFileSync(join(dir, 'src', 'b.ts'), 'b2 changed\n')
    writeFileSync(join(dir, 'a.txt'), 'outside the workspace\n')
    expect(await changedSince(before!, ws)).toEqual(['b.ts'])
  })

  it('does not run repository hooks or filters', async () => {
    repo()
    // A clean/smudge filter and an fsmonitor hook that would leave a marker if run.
    const marker = join(dir, 'ran')
    writeFileSync(join(dir, '.gitattributes'), '*.txt filter=evil\n')
    git('config', 'filter.evil.clean', `touch ${marker}; cat`)
    git('config', 'core.fsmonitor', `touch ${marker}`)
    const before = await snapshotWorkingTree(dir)
    writeFileSync(join(dir, 'a.txt'), 'a2 changed\n')
    await changedSince(before!, dir)
    expect(existsSync(marker)).toBe(false)
  })
})

describe('shellMayEdit', () => {
  it.each([
    'ls -la',
    'cat a.txt | head -5',
    'git status && git diff --stat',
    'grep -rn foo src 2>/dev/null',
    "sed -n '1,20p' a.ts",
    'find . -name "*.ts"',
    'cd src && ls',
    'FOO=1 printenv FOO',
    'git log --oneline -5 >/dev/null 2>&1'
  ])('%j only reads', (cmd) => {
    expect(shellMayEdit(cmd)).toBe(false)
  })

  it.each([
    "sed -i 's/a/b/' a.ts",
    'sed --in-place -e s/a/b/ a.ts',
    'git apply fix.patch',
    'git checkout -- a.ts',
    'echo hi > a.txt',
    'cat <<EOF >> a.txt',
    'find . -name "*.orig" -delete',
    'sort -o out.txt in.txt',
    'npm run codegen',
    'python gen.py',
    'ls $(cat list)',
    'echo x | tee a.txt',
    'rm a.txt',
    'git'
  ])('%j may write', (cmd) => {
    expect(shellMayEdit(cmd)).toBe(true)
  })
})
