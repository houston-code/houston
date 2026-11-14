import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync, unlinkSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'

// The git subcommand of every git process the code under test starts, in order (the
// filter-driver probe is `config`).
const h = vi.hoisted(() => ({ spawned: [] as string[] }))
vi.mock('node:child_process', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:child_process')>()
  return {
    ...real,
    execFile: ((file: string, args: string[], ...rest: unknown[]) => {
      if (/(^|\/)git$/.test(file)) {
        h.spawned.push(args.find((a, i) => !a.startsWith('-') && args[i - 1] !== '-c') ?? '')
      }
      return (real.execFile as (...a: unknown[]) => unknown)(file, args, ...rest)
    }) as typeof real.execFile
  }
})

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

  it('does not run a filter the command planted between the two snapshots', async () => {
    repo()
    const before = await snapshotWorkingTree(dir)
    // What a sandboxed command could leave behind for the read after it.
    const marker = join(dir, 'ran')
    writeFileSync(join(dir, '.gitattributes'), '*.txt filter=evil\n')
    git('config', 'filter.evil.clean', `touch ${marker}; cat`)
    // Same size, so git reads the content (through the filter) to tell whether it changed.
    writeFileSync(join(dir, 'a.txt'), 'a9\n')
    expect(await changedSince(before!, dir)).toEqual(['.gitattributes', 'a.txt'])
    expect(existsSync(marker)).toBe(false)
  })

  it('asks for the top level once: the read after the command reuses it', async () => {
    repo()
    h.spawned.length = 0
    const before = await snapshotWorkingTree(dir)
    expect(h.spawned.sort()).toEqual(['config', 'rev-parse', 'status'])
    h.spawned.length = 0
    writeFileSync(join(dir, 'a.txt'), 'a2 changed\n')
    expect(await changedSince(before!, dir)).toEqual(['a.txt'])
    // The filter-driver probe runs again; rev-parse does not.
    expect(h.spawned).toEqual(['config', 'status'])
  })

  it('reports nothing once the repository is gone or another one is found', async () => {
    // A repository nested in another: with its .git removed, git finds the outer one.
    repo()
    const inner = join(dir, 'inner')
    mkdirSync(inner)
    execFileSync('git', ['init', '-q'], { cwd: inner, stdio: 'ignore' })
    writeFileSync(join(inner, 'x.txt'), 'x\n')
    const before = await snapshotWorkingTree(inner)
    expect(before?.entries.has('x.txt')).toBe(true)
    rmSync(join(inner, '.git'), { recursive: true, force: true })
    writeFileSync(join(inner, 'x.txt'), 'x changed\n')
    expect(await changedSince(before!, inner)).toEqual([])

    // `git init` in a workspace below the top level makes the workspace its own top.
    const ws = join(dir, 'src')
    const fromSrc = await snapshotWorkingTree(ws)
    execFileSync('git', ['init', '-q'], { cwd: ws, stdio: 'ignore' })
    writeFileSync(join(ws, 'b.ts'), 'b2 changed\n')
    expect(await changedSince(fromSrc!, ws)).toEqual([])

    // The workspace removed outright, tracked files and all.
    const gone = join(dir, 'gone')
    mkdirSync(gone)
    writeFileSync(join(gone, 'c.txt'), 'c\n')
    git('add', 'gone')
    git('commit', '-q', '-m', 'gone')
    const fromGone = await snapshotWorkingTree(gone)
    expect(fromGone).not.toBeNull()
    rmSync(gone, { recursive: true, force: true })
    expect(await changedSince(fromGone!, gone)).toEqual([])
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
