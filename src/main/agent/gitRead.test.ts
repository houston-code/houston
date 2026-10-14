import { describe, it, expect } from 'vitest'
import { uncommittedDiffBase, type GitTry } from './gitRead'

/** A GitTry answering from a map keyed by the joined args; unknown args fail. */
const fake =
  (answers: Record<string, string>): GitTry =>
  async (args) =>
    answers[args.join(' ')] ?? null

describe('uncommittedDiffBase', () => {
  it('uses HEAD when it resolves to a commit', async () => {
    expect(await uncommittedDiffBase(fake({ 'rev-parse --verify -q HEAD^{commit}': 'abc\n' }))).toBe(
      'HEAD'
    )
  })

  it('uses the SHA-1 empty tree on an unborn HEAD', async () => {
    const base = await uncommittedDiffBase(fake({ 'rev-parse --show-object-format': 'sha1\n' }))
    expect(base).toBe('4b825dc642cb6eb9a060e54bf8d69288fbee4904')
  })

  it('uses the SHA-256 empty tree in a SHA-256 repo', async () => {
    const base = await uncommittedDiffBase(fake({ 'rev-parse --show-object-format': 'sha256\n' }))
    expect(base).toBe('6ef19b41225c5369f1c104d45d8d85efa9b057b53b14b4b9b939dd74decc5321')
  })

  it('assumes SHA-1 when git is too old to report the object format', async () => {
    expect(await uncommittedDiffBase(fake({}))).toBe('4b825dc642cb6eb9a060e54bf8d69288fbee4904')
  })

  it('falls back to HEAD for an unknown object format', async () => {
    expect(await uncommittedDiffBase(fake({ 'rev-parse --show-object-format': 'sha512\n' }))).toBe('HEAD')
  })
})
