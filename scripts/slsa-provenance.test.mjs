import { describe, it, expect } from 'vitest'
import { buildPredicate, buildStatement, subjectsFromSums } from './slsa-provenance.mjs'

const env = {
  GITHUB_SERVER_URL: 'https://github.com',
  GITHUB_REPOSITORY: 'houston-code/houston',
  GITHUB_REF: 'refs/heads/main',
  GITHUB_SHA: 'abc123def456',
  GITHUB_RUN_ID: '42',
  GITHUB_RUN_ATTEMPT: '2',
  GITHUB_EVENT_NAME: 'workflow_dispatch'
}

describe('buildPredicate (SLSA v1.0)', () => {
  it('sets the builder id to the release workflow at the ref', () => {
    expect(buildPredicate(env).runDetails.builder.id).toBe(
      'https://github.com/houston-code/houston/.github/workflows/release-publish.yml@refs/heads/main'
    )
  })

  it('records the source repo + commit as a resolved dependency', () => {
    const dep = buildPredicate(env).buildDefinition.resolvedDependencies[0]
    expect(dep.uri).toBe('git+https://github.com/houston-code/houston@refs/heads/main')
    expect(dep.digest.gitCommit).toBe('abc123def456')
  })

  it('records the run invocation id (run + attempt)', () => {
    expect(buildPredicate(env).runDetails.metadata.invocationId).toBe(
      'https://github.com/houston-code/houston/actions/runs/42/attempts/2'
    )
  })

  it('defaults the run attempt to 1 when absent', () => {
    expect(buildPredicate({ ...env, GITHUB_RUN_ATTEMPT: undefined }).runDetails.metadata.invocationId).toContain(
      '/attempts/1'
    )
  })

  it('has the required SLSA v1.0 top-level shape', () => {
    const p = buildPredicate(env)
    expect(p.buildDefinition.buildType).toBeTruthy()
    expect(p.buildDefinition.externalParameters.workflow.path).toBe('.github/workflows/release-publish.yml')
    expect(p.runDetails.builder.id).toBeTruthy()
    // Must serialize to valid JSON (cosign reads it as a predicate file).
    expect(() => JSON.parse(JSON.stringify(p))).not.toThrow()
  })
})

describe('subjectsFromSums + buildStatement (one statement for the release)', () => {
  const A = 'a'.repeat(64)
  const B = 'b'.repeat(64)

  it('turns every SHA256SUMS line into a subject', () => {
    expect(subjectsFromSums(`${A}  Houston-1.2.0-arm64.dmg\n${B} *houston-cli.cjs\n\n`)).toEqual([
      { name: 'Houston-1.2.0-arm64.dmg', digest: { sha256: A } },
      { name: 'houston-cli.cjs', digest: { sha256: B } },
    ])
  })

  it('rejects a malformed line, a duplicate name, or an empty manifest', () => {
    expect(() => subjectsFromSums(`${A}  a.dmg\nnot a checksum line\n`)).toThrow('not a sha256sum line')
    expect(() => subjectsFromSums(`${A.slice(1)}  short.dmg\n`)).toThrow('not a sha256sum line')
    expect(() => subjectsFromSums(`${A}  a.dmg\n${B}  a.dmg\n`)).toThrow('duplicate entry for a.dmg')
    expect(() => subjectsFromSums('\n')).toThrow('no entries')
  })

  it('wraps the subjects and the SLSA predicate in an in-toto v1 statement', () => {
    const predicate = buildPredicate({ GITHUB_REPOSITORY: 'houston-code/houston', GITHUB_SHA: 'abc', GITHUB_REF: 'refs/heads/main' })
    const st = buildStatement([{ name: 'x', digest: { sha256: A } }], predicate)
    expect(st._type).toBe('https://in-toto.io/Statement/v1')
    expect(st.predicateType).toBe('https://slsa.dev/provenance/v1')
    expect(st.subject).toEqual([{ name: 'x', digest: { sha256: A } }])
    expect(st.predicate.buildDefinition.resolvedDependencies[0].digest.gitCommit).toBe('abc')
  })
})
