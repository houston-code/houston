import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  authServerMetadataUrls,
  canonicalResourceUri,
  discoverAuthServer,
  isAllowedEndpointUrl,
  parseResourceMetadataUrl,
  pkcePair,
  protectedResourceMetadataUrls,
  refreshMcpOAuth,
  registerClient,
  runMcpOAuthFlow,
  tokensNeedRefresh,
  type FetchFn,
  type McpOAuthTokens
} from './oauth'

describe('pkcePair', () => {
  it('produces a base64url verifier whose S256 hash is the challenge', () => {
    const { verifier, challenge } = pkcePair()
    expect(verifier).toMatch(/^[A-Za-z0-9_-]{43}$/)
    const expected = createHash('sha256')
      .update(verifier)
      .digest('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '')
    expect(challenge).toBe(expected)
  })

  it('is random per call', () => {
    expect(pkcePair().verifier).not.toBe(pkcePair().verifier)
  })
})

describe('canonicalResourceUri', () => {
  it('keeps the path and drops fragments', () => {
    expect(canonicalResourceUri('https://Example.com/mcp#frag')).toBe('https://example.com/mcp')
  })

  it('drops a bare trailing slash', () => {
    expect(canonicalResourceUri('https://example.com/')).toBe('https://example.com')
  })
})

describe('parseResourceMetadataUrl', () => {
  it('extracts the resource_metadata URL from a Bearer challenge', () => {
    expect(
      parseResourceMetadataUrl('Bearer realm="mcp", resource_metadata="https://x/.well-known/oauth-protected-resource"')
    ).toBe('https://x/.well-known/oauth-protected-resource')
  })

  it('returns null for a missing header or parameter', () => {
    expect(parseResourceMetadataUrl(null)).toBeNull()
    expect(parseResourceMetadataUrl('Bearer realm="mcp"')).toBeNull()
  })
})

describe('well-known URL candidates', () => {
  it('tries the path-inserted protected-resource form first', () => {
    expect(protectedResourceMetadataUrls('https://x.com/mcp')).toEqual([
      'https://x.com/.well-known/oauth-protected-resource/mcp',
      'https://x.com/.well-known/oauth-protected-resource'
    ])
  })

  it('collapses to the root form for a path-less server', () => {
    expect(protectedResourceMetadataUrls('https://x.com/')).toEqual([
      'https://x.com/.well-known/oauth-protected-resource'
    ])
  })

  it('orders AS metadata per the spec: RFC 8414 before OpenID discovery', () => {
    expect(authServerMetadataUrls('https://as.com/tenant')).toEqual([
      'https://as.com/.well-known/oauth-authorization-server/tenant',
      'https://as.com/.well-known/oauth-authorization-server',
      'https://as.com/.well-known/openid-configuration/tenant',
      'https://as.com/tenant/.well-known/openid-configuration'
    ])
    expect(authServerMetadataUrls('https://as.com')).toEqual([
      'https://as.com/.well-known/oauth-authorization-server',
      'https://as.com/.well-known/openid-configuration'
    ])
  })
})

describe('isAllowedEndpointUrl', () => {
  it('allows https anywhere and http only on loopback', () => {
    expect(isAllowedEndpointUrl('https://as.example.com/authorize')).toBe(true)
    expect(isAllowedEndpointUrl('http://127.0.0.1:8080/authorize')).toBe(true)
    expect(isAllowedEndpointUrl('http://localhost/token')).toBe(true)
    expect(isAllowedEndpointUrl('http://as.example.com/authorize')).toBe(false)
    expect(isAllowedEndpointUrl('javascript:alert(1)')).toBe(false)
    expect(isAllowedEndpointUrl('not a url')).toBe(false)
  })
})

describe('tokensNeedRefresh', () => {
  const base: McpOAuthTokens = { access: 'a', clientId: 'c', tokenEndpoint: 'https://as/token' }

  it('is false without an expiry', () => {
    expect(tokensNeedRefresh(base)).toBe(false)
  })

  it('is true within the expiry margin', () => {
    expect(tokensNeedRefresh({ ...base, expiresAt: 1_000_000 }, 1_000_000 - 30_000)).toBe(true)
    expect(tokensNeedRefresh({ ...base, expiresAt: 1_000_000 }, 1_000_000 - 120_000)).toBe(false)
  })
})

/** A scriptable fetch: exact-URL handlers, 404 otherwise. Records every request. */
function fakeFetch(
  handlers: Record<string, (init?: RequestInit) => Response | Promise<Response>>
): { fetch: FetchFn; requests: Array<{ url: string; body?: string }> } {
  const requests: Array<{ url: string; body?: string }> = []
  const fetch: FetchFn = async (url, init) => {
    requests.push({ url, body: typeof init?.body === 'string' ? init.body : undefined })
    const handler = handlers[url]
    if (!handler) return new Response('not found', { status: 404 })
    return handler(init)
  }
  return { fetch, requests }
}

const json = (obj: unknown, init: ResponseInit = {}): Response =>
  new Response(JSON.stringify(obj), { status: 200, headers: { 'content-type': 'application/json' }, ...init })

describe('discoverAuthServer', () => {
  it('follows the 401 challenge to resource metadata, then AS metadata', async () => {
    const { fetch } = fakeFetch({
      'https://mcp.example.com/mcp': () =>
        new Response('', {
          status: 401,
          headers: { 'www-authenticate': 'Bearer resource_metadata="https://mcp.example.com/.well-known/oauth-protected-resource/mcp"' }
        }),
      'https://mcp.example.com/.well-known/oauth-protected-resource/mcp': () =>
        json({ resource: 'https://mcp.example.com/mcp', authorization_servers: ['https://auth.example.com'], scopes_supported: ['mcp:read', 'mcp:write'] }),
      'https://auth.example.com/.well-known/oauth-authorization-server': () =>
        json({
          authorization_endpoint: 'https://auth.example.com/authorize',
          token_endpoint: 'https://auth.example.com/token',
          registration_endpoint: 'https://auth.example.com/register'
        })
    })
    const info = await discoverAuthServer('https://mcp.example.com/mcp', fetch)
    expect(info).toEqual({
      authorizationEndpoint: 'https://auth.example.com/authorize',
      tokenEndpoint: 'https://auth.example.com/token',
      registrationEndpoint: 'https://auth.example.com/register',
      scopes: ['mcp:read', 'mcp:write'],
      resource: 'https://mcp.example.com/mcp'
    })
  })

  it('falls back to well-known resource metadata when the challenge has none', async () => {
    const { fetch } = fakeFetch({
      'https://m.com/mcp': () => new Response('', { status: 401 }),
      'https://m.com/.well-known/oauth-protected-resource/mcp': () =>
        json({ authorization_servers: ['https://as.com'] }),
      'https://as.com/.well-known/oauth-authorization-server': () =>
        json({ authorization_endpoint: 'https://as.com/a', token_endpoint: 'https://as.com/t' })
    })
    const info = await discoverAuthServer('https://m.com/mcp', fetch)
    expect(info.authorizationEndpoint).toBe('https://as.com/a')
    expect(info.registrationEndpoint).toBeUndefined()
  })

  it('defaults the issuer to the server origin when no resource metadata exists', async () => {
    const { fetch } = fakeFetch({
      'https://m.com/.well-known/oauth-authorization-server': () =>
        json({ authorization_endpoint: 'https://m.com/a', token_endpoint: 'https://m.com/t' })
    })
    const info = await discoverAuthServer('https://m.com/mcp', fetch)
    expect(info.tokenEndpoint).toBe('https://m.com/t')
  })

  it('degrades to the default endpoint paths when there is no metadata at all', async () => {
    const { fetch } = fakeFetch({})
    const info = await discoverAuthServer('https://m.com/mcp', fetch)
    expect(info).toEqual({
      authorizationEndpoint: 'https://m.com/authorize',
      tokenEndpoint: 'https://m.com/token',
      registrationEndpoint: 'https://m.com/register',
      scopes: undefined,
      resource: 'https://m.com/mcp'
    })
  })

  it('refuses an authorization server advertising non-https endpoints', async () => {
    const { fetch } = fakeFetch({
      'https://m.com/.well-known/oauth-authorization-server': () =>
        json({ authorization_endpoint: 'http://evil.com/a', token_endpoint: 'https://m.com/t' })
    })
    await expect(discoverAuthServer('https://m.com/mcp', fetch)).rejects.toThrow(/non-https/)
  })
})

describe('registerClient', () => {
  const info = {
    authorizationEndpoint: 'https://as/a',
    tokenEndpoint: 'https://as/t',
    registrationEndpoint: 'https://as/register',
    resource: 'https://m.com/mcp'
  }

  it('registers a public client and returns its id', async () => {
    const { fetch, requests } = fakeFetch({
      'https://as/register': () => json({ client_id: 'cid-1' }, { status: 201 })
    })
    expect(await registerClient(info, 'http://127.0.0.1:7777/callback', fetch)).toEqual({
      clientId: 'cid-1',
      clientSecret: undefined
    })
    const sent = JSON.parse(requests[0].body!) as Record<string, unknown>
    expect(sent.redirect_uris).toEqual(['http://127.0.0.1:7777/callback'])
    expect(sent.token_endpoint_auth_method).toBe('none')
    expect(sent.grant_types).toEqual(['authorization_code', 'refresh_token'])
  })

  it('explains itself when the server offers no registration endpoint', async () => {
    await expect(
      registerClient({ ...info, registrationEndpoint: undefined }, 'http://127.0.0.1:1/callback')
    ).rejects.toThrow(/dynamic client registration/)
  })

  it('surfaces the server error detail on a rejected registration', async () => {
    const { fetch } = fakeFetch({
      'https://as/register': () => json({ error: 'invalid_redirect_uri', error_description: 'loopback only' }, { status: 400 })
    })
    await expect(registerClient(info, 'http://127.0.0.1:1/callback', fetch)).rejects.toThrow(/loopback only/)
  })
})

describe('refreshMcpOAuth', () => {
  const tokens: McpOAuthTokens = {
    access: 'old-access',
    refresh: 'refresh-1',
    clientId: 'cid',
    tokenEndpoint: 'https://as/token',
    resource: 'https://m.com/mcp'
  }

  it('mints a new access token and keeps an unrotated refresh token', async () => {
    const { fetch, requests } = fakeFetch({
      'https://as/token': () => json({ access_token: 'new-access', token_type: 'Bearer', expires_in: 3600 })
    })
    const before = Date.now()
    const fresh = await refreshMcpOAuth(tokens, fetch)
    expect(fresh.access).toBe('new-access')
    expect(fresh.refresh).toBe('refresh-1')
    expect(fresh.expiresAt).toBeGreaterThanOrEqual(before + 3_599_000)
    const body = new URLSearchParams(requests[0].body)
    expect(body.get('grant_type')).toBe('refresh_token')
    expect(body.get('refresh_token')).toBe('refresh-1')
    expect(body.get('client_id')).toBe('cid')
    expect(body.get('resource')).toBe('https://m.com/mcp')
  })

  it('adopts a rotated refresh token', async () => {
    const { fetch } = fakeFetch({
      'https://as/token': () => json({ access_token: 'a2', refresh_token: 'refresh-2' })
    })
    expect((await refreshMcpOAuth(tokens, fetch)).refresh).toBe('refresh-2')
  })

  it('demands an interactive sign-in when there is no refresh token', async () => {
    await expect(refreshMcpOAuth({ ...tokens, refresh: undefined })).rejects.toThrow(/sign in again/i)
  })

  it('surfaces token-endpoint errors', async () => {
    const { fetch } = fakeFetch({
      'https://as/token': () => json({ error: 'invalid_grant' }, { status: 400 })
    })
    await expect(refreshMcpOAuth(tokens, fetch)).rejects.toThrow(/invalid_grant/)
  })
})

describe('runMcpOAuthFlow', () => {
  /** Full happy path: fake AS + a fake "browser" that follows the redirect. */
  it('discovers, registers, authorizes via the loopback redirect, and exchanges the code', async () => {
    let authorizeUrl: URL | undefined
    const { fetch, requests } = fakeFetch({
      'https://m.com/mcp': () =>
        new Response('', {
          status: 401,
          headers: { 'www-authenticate': 'Bearer resource_metadata="https://m.com/.well-known/oauth-protected-resource/mcp"' }
        }),
      'https://m.com/.well-known/oauth-protected-resource/mcp': () =>
        json({ authorization_servers: ['https://as.com'], scopes_supported: ['mcp'] }),
      'https://as.com/.well-known/oauth-authorization-server': () =>
        json({
          authorization_endpoint: 'https://as.com/authorize',
          token_endpoint: 'https://as.com/token',
          registration_endpoint: 'https://as.com/register'
        }),
      'https://as.com/register': () => json({ client_id: 'cid-9' }, { status: 201 }),
      'https://as.com/token': () =>
        json({ access_token: 'at-1', refresh_token: 'rt-1', token_type: 'bearer', expires_in: 120, scope: 'mcp' })
    })

    const statuses: string[] = []
    const tokens = await runMcpOAuthFlow('https://m.com/mcp', {
      fetchFn: fetch,
      onStatus: (m) => statuses.push(m),
      openUrl: (url) => {
        authorizeUrl = new URL(url)
        // Simulate the browser: land on the loopback redirect with code + state.
        const redirect = new URL(authorizeUrl.searchParams.get('redirect_uri')!)
        redirect.searchParams.set('code', 'code-42')
        redirect.searchParams.set('state', authorizeUrl.searchParams.get('state')!)
        void globalThis.fetch(redirect).catch(() => {})
        return true
      }
    })

    expect(tokens.access).toBe('at-1')
    expect(tokens.refresh).toBe('rt-1')
    expect(tokens.clientId).toBe('cid-9')
    expect(tokens.tokenEndpoint).toBe('https://as.com/token')
    expect(tokens.resource).toBe('https://m.com/mcp')
    expect(tokens.scope).toBe('mcp')
    expect(tokens.expiresAt).toBeGreaterThan(Date.now())

    // The authorize URL carried PKCE, state, and the resource indicator.
    expect(authorizeUrl!.origin + authorizeUrl!.pathname).toBe('https://as.com/authorize')
    expect(authorizeUrl!.searchParams.get('code_challenge_method')).toBe('S256')
    expect(authorizeUrl!.searchParams.get('code_challenge')).toBeTruthy()
    expect(authorizeUrl!.searchParams.get('resource')).toBe('https://m.com/mcp')
    expect(authorizeUrl!.searchParams.get('scope')).toBe('mcp')

    // The token exchange sent the code, verifier, and resource.
    const exchange = new URLSearchParams(requests.find((r) => r.url === 'https://as.com/token')!.body)
    expect(exchange.get('grant_type')).toBe('authorization_code')
    expect(exchange.get('code')).toBe('code-42')
    expect(exchange.get('code_verifier')).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(exchange.get('resource')).toBe('https://m.com/mcp')

    expect(statuses.some((s) => s.includes('browser'))).toBe(true)
  })

  it('rejects a redirect whose state does not match', async () => {
    const { fetch } = fakeFetch({
      'https://as.com/.well-known/oauth-authorization-server': () =>
        json({
          authorization_endpoint: 'https://as.com/authorize',
          token_endpoint: 'https://as.com/token',
          registration_endpoint: 'https://as.com/register'
        }),
      'https://m.com/.well-known/oauth-protected-resource/mcp': () =>
        json({ authorization_servers: ['https://as.com'] }),
      'https://as.com/register': () => json({ client_id: 'cid' })
    })
    await expect(
      runMcpOAuthFlow('https://m.com/mcp', {
        fetchFn: fetch,
        openUrl: (url) => {
          const redirect = new URL(new URL(url).searchParams.get('redirect_uri')!)
          redirect.searchParams.set('code', 'c')
          redirect.searchParams.set('state', 'WRONG')
          void globalThis.fetch(redirect).catch(() => {})
          return true
        }
      })
    ).rejects.toThrow(/code\/state/)
  })

  it('surfaces an authorization denial', async () => {
    const { fetch } = fakeFetch({
      'https://m.com/.well-known/oauth-protected-resource/mcp': () =>
        json({ authorization_servers: ['https://as.com'] }),
      'https://as.com/.well-known/oauth-authorization-server': () =>
        json({
          authorization_endpoint: 'https://as.com/authorize',
          token_endpoint: 'https://as.com/token',
          registration_endpoint: 'https://as.com/register'
        }),
      'https://as.com/register': () => json({ client_id: 'cid' })
    })
    await expect(
      runMcpOAuthFlow('https://m.com/mcp', {
        fetchFn: fetch,
        openUrl: (url) => {
          const redirect = new URL(new URL(url).searchParams.get('redirect_uri')!)
          redirect.searchParams.set('error', 'access_denied')
          redirect.searchParams.set('error_description', 'user said no')
          void globalThis.fetch(redirect).catch(() => {})
          return true
        }
      })
    ).rejects.toThrow(/user said no/)
  })

  it('times out when the browser redirect never lands', async () => {
    const { fetch } = fakeFetch({
      'https://m.com/.well-known/oauth-protected-resource/mcp': () =>
        json({ authorization_servers: ['https://as.com'] }),
      'https://as.com/.well-known/oauth-authorization-server': () =>
        json({
          authorization_endpoint: 'https://as.com/authorize',
          token_endpoint: 'https://as.com/token',
          registration_endpoint: 'https://as.com/register'
        }),
      'https://as.com/register': () => json({ client_id: 'cid' })
    })
    await expect(
      runMcpOAuthFlow('https://m.com/mcp', { fetchFn: fetch, openUrl: () => true, timeoutMs: 50 })
    ).rejects.toThrow(/[Tt]imed out/)
  })

  it('refuses a non-http(s) server URL outright', async () => {
    await expect(runMcpOAuthFlow('file:///etc/passwd')).rejects.toThrow(/Not a remote MCP server URL/)
  })
})
