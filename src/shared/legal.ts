/**
 * Legal terms versioning and document links.
 *
 * `LEGAL_VERSION` is the version the user must have accepted (stored as
 * `legalAcceptedVersion` in AppSettings). Bump it whenever the Terms of Use,
 * Privacy Policy, or License change materially enough to require re-acceptance —
 * the first-run gate then re-prompts every user on next launch.
 */
export const LEGAL_VERSION = 1

/** Base URL for the published legal documents (repo `main`). */
const DOCS_BASE = 'https://github.com/piyushvijay/houston/blob/main'

export const LICENSE_URL = `${DOCS_BASE}/LICENSE`
export const TERMS_URL = `${DOCS_BASE}/docs/TERMS.md`
export const PRIVACY_URL = `${DOCS_BASE}/docs/PRIVACY.md`

/** True when the stored acceptance is missing or older than the current terms. */
export function needsLegalAcceptance(acceptedVersion: number | undefined): boolean {
  return (acceptedVersion ?? 0) < LEGAL_VERSION
}
