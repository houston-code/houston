import { describe, it, expect } from 'vitest'
import { checkTrustedPublishing, expectedPublisher, workflowCommandData } from './check-npm-trusted-publishing.mjs'

const env = {
  ACTIONS_ID_TOKEN_REQUEST_URL: 'https://token.actions.example/id?api-version=2.0',
  ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'request-token',
  GITHUB_REPOSITORY: 'houston-code/houston',
  GITHUB_WORKFLOW_REF: 'houston-code/houston/.github/workflows/release-publish.yml@refs/heads/main',
  PUBLISH_ENVIRONMENT: 'release',
}

const json = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body })

/** A fetch that serves the GitHub ID token, then answers the npm exchange with `exchange`. */
function fakeFetch(exchange, idResponse = json(200, { value: 'id-token' })) {
  const calls = []
  const fetch = async (url, init) => {
    calls.push({ url, init })
    return String(url).startsWith('https://token.actions.example/') ? idResponse : exchange
  }
  return { fetch, calls }
}

describe('checkTrustedPublishing', () => {
  it('passes when npm accepts the exchange, asking GitHub for an npm-audience token', async () => {
    const { fetch, calls } = fakeFetch(json(201, { token: 'npm-secret' }))
    await expect(checkTrustedPublishing({ env, fetch })).resolves.toBeUndefined()
    expect(new URL(calls[0].url).searchParams.get('audience')).toBe('npm:registry.npmjs.org')
    expect(new URL(calls[0].url).searchParams.get('api-version')).toBe('2.0')
    expect(calls[0].init.headers.Authorization).toBe('Bearer request-token')
    expect(calls[1].url).toBe('https://registry.npmjs.org/-/npm/v1/oidc/token/exchange/package/@houston-code%2fcli')
    expect(calls[1].init).toMatchObject({ method: 'POST', headers: { Authorization: 'Bearer id-token' } })
  })

  it("fails with the registry's reason and the settings to check", async () => {
    const { fetch } = fakeFetch(json(404, { message: 'No matching trusted publisher found' }))
    const err = await checkTrustedPublishing({ env, fetch }).catch((e) => e)
    expect(err.message).toContain('HTTP 404: No matching trusted publisher found')
    expect(err.message).toContain(
      'repository houston-code/houston, workflow release-publish.yml, environment release',
    )
  })

  it('still reports the status when the error body is not JSON', async () => {
    const { fetch } = fakeFetch({ ok: false, status: 500, json: async () => { throw new SyntaxError('html') } })
    await expect(checkTrustedPublishing({ env, fetch })).rejects.toThrow(/HTTP 500\)/)
  })

  it('never puts the exchanged npm token in an error', async () => {
    const { fetch } = fakeFetch(json(403, { message: 'forbidden', token: 'npm-secret' }))
    const err = await checkTrustedPublishing({ env, fetch }).catch((e) => e)
    expect(err.message).not.toContain('npm-secret')
  })

  it('explains a job without id-token permission', async () => {
    const { fetch, calls } = fakeFetch(json(201, {}))
    const noOidc = { ...env, ACTIONS_ID_TOKEN_REQUEST_TOKEN: undefined }
    await expect(checkTrustedPublishing({ env: noOidc, fetch })).rejects.toThrow(/id-token: write/)
    expect(calls).toHaveLength(0)
  })

  it('fails when GitHub returns no ID token', async () => {
    const { fetch, calls } = fakeFetch(json(201, {}), json(403, {}))
    await expect(checkTrustedPublishing({ env, fetch })).rejects.toThrow(/GitHub OIDC token \(HTTP 403\)/)
    expect(calls).toHaveLength(1)
  })
})

describe('expectedPublisher', () => {
  it('names the workflow file, not its path or ref', () => {
    expect(expectedPublisher(env)).toBe('repository houston-code/houston, workflow release-publish.yml, environment release')
  })

  it('marks what the environment did not provide', () => {
    expect(expectedPublisher({})).toBe('repository (unknown), workflow (unknown), environment (none)')
  })
})

describe('workflowCommandData', () => {
  it('keeps a multi-line message on the one ::error:: line', () => {
    expect(workflowCommandData('bad\n::add-mask::x 100%\r')).toBe('bad%0A::add-mask::x 100%25%0D')
  })
})
