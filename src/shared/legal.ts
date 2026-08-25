/**
 * Legal terms versioning and document links.
 *
 * `LEGAL_VERSION` is the version the user must have accepted (stored as
 * `legalAcceptedVersion` in AppSettings). Bump it whenever the Terms of Use or
 * Privacy Policy change materially enough to require re-acceptance — the
 * first-run gate then re-prompts every user on next launch.
 *
 * The LICENSE is deliberately NOT part of what the gate asks users to accept.
 * Houston is Apache-2.0: the license grants rights to redistribute and modify
 * rather than imposing conditions on merely running the app, so there is nothing
 * for an end user to agree to. `LICENSE_URL` stays exported so the gate and
 * Settings can still link to it for reference.
 *
 * Version history:
 *   1 — initial Terms of Use, Privacy Policy, and proprietary license.
 *   2 — relicensed under Apache-2.0; the Terms' license section was rewritten
 *       and the license dropped out of the acceptance flow.
 */
export const LEGAL_VERSION = 2

/** Base URL for the published legal documents (repo `main`). */
const DOCS_BASE = 'https://github.com/piyushvijay/houston/blob/main'

export const LICENSE_URL = `${DOCS_BASE}/LICENSE`
export const TERMS_URL = `${DOCS_BASE}/docs/TERMS.md`
export const PRIVACY_URL = `${DOCS_BASE}/docs/PRIVACY.md`

/** True when the stored acceptance is missing or older than the current terms. */
export function needsLegalAcceptance(acceptedVersion: number | undefined): boolean {
  return (acceptedVersion ?? 0) < LEGAL_VERSION
}
