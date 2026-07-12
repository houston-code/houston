import { describe, it, expect } from 'vitest'
import { buildPredicate } from './slsa-provenance.mjs'

const env = {
  GITHUB_SERVER_URL: 'https://github.com',
  GITHUB_REPOSITORY: 'piyushvijay/houston',
  GITHUB_REF: 'refs/heads/main',
  GITHUB_SHA: 'abc123def456',
  GITHUB_RUN_ID: '42',
  GITHUB_RUN_ATTEMPT: '2',
  GITHUB_EVENT_NAME: 'workflow_dispatch'
}

describe('buildPredicate (SLSA v1.0)', () => {
  it('sets the builder id to the release workflow at the ref', () => {
    expect(buildPredicate(env).runDetails.builder.id).toBe(
      'https://github.com/piyushvijay/houston/.github/workflows/release-publish.yml@refs/heads/main'
    )
  })

  it('records the source repo + commit as a resolved dependency', () => {
    const dep = buildPredicate(env).buildDefinition.resolvedDependencies[0]
    expect(dep.uri).toBe('git+https://github.com/piyushvijay/houston@refs/heads/main')
    expect(dep.digest.gitCommit).toBe('abc123def456')
  })

  it('records the run invocation id (run + attempt)', () => {
    expect(buildPredicate(env).runDetails.metadata.invocationId).toBe(
      'https://github.com/piyushvijay/houston/actions/runs/42/attempts/2'
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
