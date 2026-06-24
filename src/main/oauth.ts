import type { OAuthCredential } from './secrets'

/**
 * OAuth flow — STUB.
 *
 * This is the foundation seam for OAuth-based provider auth. The credential store
 * (`src/main/secrets.ts`) already understands the `OAuthCredential` shape and
 * `ProviderConfig.authMethod === 'oauth'` selects it, but the live interactive flow
 * is intentionally NOT implemented here.
 *
 * Why it's a stub: a real device-code or PKCE authorization-code flow needs a
 * provider-registered OAuth client ID (and, for non-PKCE servers, a client secret)
 * plus the provider's authorization/token endpoints. Those are per-provider values
 * that must be supplied by the user / app operator before anything can be wired up.
 *
 * When client IDs are available, implement the flow below and have it persist the
 * resulting tokens via `setCredential(providerId, { type: 'oauth', ... })`. Token
 * refresh should re-mint and re-persist using the stored `refresh` token.
 */

const STUB_MESSAGE =
  'OAuth login is not implemented yet: it requires a provider-registered client ID. ' +
  'Configure one and implement the device-code/PKCE flow in src/main/oauth.ts.'

/** Per-provider OAuth endpoints + client config needed to run a real flow. */
export interface OAuthClientConfig {
  /** Registered OAuth client id for this provider. */
  clientId: string
  /** Authorization endpoint (PKCE) or device-authorization endpoint (device code). */
  authorizationEndpoint: string
  /** Token endpoint that mints/refreshes access tokens. */
  tokenEndpoint: string
  /** Requested scopes. */
  scopes?: string[]
}

/**
 * Begin an interactive OAuth flow (device-code / PKCE) and resolve to the minted
 * token set. STUB — throws until a client ID is configured and the flow is built.
 */
export async function startOAuthFlow(
  _config: OAuthClientConfig
): Promise<OAuthCredential> {
  // TODO(oauth): implement device-code/PKCE flow. Steps:
  //   1. Request a device/authorization code from `authorizationEndpoint`.
  //   2. Prompt the user to authorize (open the verification URL).
  //   3. Poll/exchange at `tokenEndpoint` for { access, refresh, expires_in }.
  //   4. Return { type: 'oauth', access, refresh, expiresAt: Date.now() + expires_in*1000 }.
  throw new Error(STUB_MESSAGE)
}

/**
 * Refresh an expired access token using its refresh token. STUB — throws until the
 * flow is built.
 */
export async function refreshOAuthToken(
  _config: OAuthClientConfig,
  _credential: OAuthCredential
): Promise<OAuthCredential> {
  // TODO(oauth): POST refresh_token grant to `tokenEndpoint`, return new token set.
  throw new Error(STUB_MESSAGE)
}
