#!/usr/bin/env node
// Emit a SLSA v1.0 build-provenance predicate (https://slsa.dev/provenance/v1) describing
// HOW a release artifact was built, from the GitHub Actions environment. `cosign attest-blob`
// wraps this into a per-artifact in-toto attestation — it sets the subject to each blob's
// digest — and signs it keyless via Fulcio + Rekor, the same trust path as the cosign
// signatures. This complements the signatures (integrity + signer identity) with structured
// build metadata: the builder is this workflow, plus the source repo + commit it was built
// from.
//
// Usage in CI: node scripts/slsa-provenance.mjs > slsa-predicate.json

import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'

/** Build the SLSA v1.0 provenance predicate from the GitHub Actions environment. */
export function buildPredicate(env = process.env) {
  const server = env.GITHUB_SERVER_URL || 'https://github.com'
  const repo = env.GITHUB_REPOSITORY || ''
  const ref = env.GITHUB_REF || ''
  const sha = env.GITHUB_SHA || ''
  const repoUrl = `${server}/${repo}`
  const workflowPath = '.github/workflows/release-publish.yml'
  return {
    buildDefinition: {
      buildType: `${repoUrl}/release-publish`,
      externalParameters: {
        workflow: { ref, repository: repoUrl, path: workflowPath }
      },
      internalParameters: {
        github: {
          event_name: env.GITHUB_EVENT_NAME || '',
          runner_environment: 'github-hosted'
        }
      },
      resolvedDependencies: [{ uri: `git+${repoUrl}@${ref}`, digest: { gitCommit: sha } }]
    },
    runDetails: {
      builder: { id: `${repoUrl}/${workflowPath}@${ref}` },
      metadata: {
        invocationId: `${repoUrl}/actions/runs/${env.GITHUB_RUN_ID || ''}/attempts/${env.GITHUB_RUN_ATTEMPT || '1'}`
      }
    }
  }
}

function main() {
  process.stdout.write(JSON.stringify(buildPredicate(), null, 2) + '\n')
}

// Run only when invoked directly, so the test can import the helper cleanly.
if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main()
}
