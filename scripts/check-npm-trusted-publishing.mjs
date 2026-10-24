// Check that npm trusted publishing will authenticate this workflow, before `npm publish`.
//
// npm publish tries the OIDC token exchange itself, but on any failure it logs the reason
// only at verbose level and carries on unauthenticated, so the job dies with a bare
// ENEEDAUTH ("You need to authorize this machine using `npm adduser`"). That hides the real
// cause, which is almost always the package's Trusted Publisher settings on npmjs.com not
// matching this repository, workflow file or environment. This does the same exchange
// first and fails with the registry's own message.
//
//   node scripts/check-npm-trusted-publishing.mjs [--package @houston-code/cli]
//
// Needs `permissions: id-token: write` (GitHub sets ACTIONS_ID_TOKEN_REQUEST_URL/_TOKEN).
// The npm token the exchange returns is discarded and never printed; npm publish does its
// own exchange with a fresh GitHub ID token.
//
// The pure `checkTrustedPublishing({ env, fetch, pkg })` is unit-tested.

import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PACKAGE_NAME } from './stage-npm-cli.mjs'

const REGISTRY = 'https://registry.npmjs.org'

/** The settings an npmjs.com Trusted Publisher entry must hold for this workflow's run. */
export function expectedPublisher(env) {
  const workflow = (env.GITHUB_WORKFLOW_REF ?? '').split('@')[0].split('/').pop() || '(unknown)'
  return `repository ${env.GITHUB_REPOSITORY ?? '(unknown)'}, workflow ${workflow}, environment ${env.PUBLISH_ENVIRONMENT || '(none)'}`
}

/** Escapes text for a `::error::` line, so a registry message can't start a workflow command of its own. */
export function workflowCommandData(text) {
  return text.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A')
}

/** Resolves when the registry accepts this run's OIDC token for `pkg`; throws with the reason otherwise. */
export async function checkTrustedPublishing({ env, fetch, pkg = PACKAGE_NAME }) {
  const requestUrl = env.ACTIONS_ID_TOKEN_REQUEST_URL
  const requestToken = env.ACTIONS_ID_TOKEN_REQUEST_TOKEN
  if (!requestUrl || !requestToken) {
    throw new Error('no GitHub OIDC token available: the job needs `permissions: id-token: write`')
  }

  const url = new URL(requestUrl)
  url.searchParams.append('audience', `npm:${new URL(REGISTRY).hostname}`)
  const idRes = await fetch(url.href, {
    headers: { Accept: 'application/json', Authorization: `Bearer ${requestToken}` },
  })
  const idToken = idRes.ok ? (await idRes.json())?.value : undefined
  if (!idToken) throw new Error(`could not get a GitHub OIDC token (HTTP ${idRes.status})`)

  const escaped = pkg.replace('/', '%2f')
  const res = await fetch(`${REGISTRY}/-/npm/v1/oidc/token/exchange/package/${escaped}`, {
    method: 'POST',
    headers: { Accept: 'application/json', Authorization: `Bearer ${idToken}` },
  })
  // Only the error body's `message` is ever read; a success body holds a publish token.
  if (res.ok) return
  let message = ''
  try {
    message = (await res.json())?.message ?? ''
  } catch {
    // A non-JSON error body: the status alone is all there is to report.
  }
  throw new Error(
    `npm rejected trusted publishing for ${pkg} (HTTP ${res.status}${message ? `: ${message}` : ''}). ` +
      `On npmjs.com, open the package's Settings > Trusted Publisher and check it names ${expectedPublisher(env)}.`,
  )
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2)
  const pkg = args[0] === '--package' && args[1] ? args[1] : PACKAGE_NAME
  try {
    await checkTrustedPublishing({ env: process.env, fetch, pkg })
    console.log(`npm accepts this workflow as a trusted publisher of ${pkg}.`)
  } catch (err) {
    console.log(`::error::${workflowCommandData(err.message)}`)
    process.exit(1)
  }
}
