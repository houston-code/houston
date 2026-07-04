/**
 * Secret redaction for content that leaves the agent's control boundary — tool
 * results (which flow to the model, the renderer, and the on-disk transcript) and
 * log lines. Two layers are applied, in order:
 *
 *   1. Pattern redaction. Well-known token FORMATS (Anthropic/OpenAI/GitHub/AWS/…)
 *      are matched by shape, so a third-party secret the agent surfaces from the
 *      user's own files — one we hold no stored copy of — is still caught. Kept to
 *      high-precision prefixes only; no entropy guessing, which is noisy on the
 *      code-heavy output agents routinely produce.
 *
 *   2. Known-value redaction. The exact secret strings THIS install holds — provider
 *      API keys, OAuth access/refresh tokens, and custom auth-header values (see
 *      `collectSecretValues` in ../secrets.ts) — are replaced wherever they appear,
 *      whatever their shape. This is the load-bearing layer: it stops an agent that
 *      reads an env var or a config file from exfiltrating *this app's own*
 *      credentials by echoing them into a tool result. Zero false positives — only
 *      values we already know to be secret are matched.
 *
 * Running patterns first means a stored key that also matches a known format gets the
 * more informative label (`[redacted:anthropic-key]` over a bare `[redacted:secret]`),
 * while the known-value pass still covers everything the patterns miss.
 *
 * Redaction is one-way and lossy by design: model, UI, and transcript all see a
 * `[redacted:*]` marker in place of the secret. Because the model never receives the
 * plaintext, it can't re-emit it in its own prose, so scrubbing tool results also
 * transitively protects streamed assistant text — no separate streaming pass needed.
 *
 * Pure and Electron-free, so the engine's host boundary (see ../agentHost.ts) stays
 * intact and this is trivially unit-testable.
 */

const marker = (label: string): string => `[redacted:${label}]`

/**
 * Shortest known secret worth matching. Below this an exact-string replace risks
 * clobbering incidental collisions in prose for no real protection. Callers that know
 * a value's provenance (../secrets.ts) apply their own, stricter filter before handing
 * values here; this is only a defensive floor.
 */
const MIN_KNOWN_SECRET_LEN = 5

interface SecretPattern {
  label: string
  re: RegExp
}

/**
 * Ordered most-specific-prefix first, so `sk-ant-…` is labeled `anthropic-key` before
 * the looser `sk-…` OpenAI rule can claim it. Every RegExp MUST carry the `g` flag —
 * `String.replace` only replaces all matches with a global regex (and resets the
 * regex's `lastIndex` around each call, so reusing these module-level values is safe).
 */
const PATTERNS: SecretPattern[] = [
  // Anthropic API keys: `sk-ant-…`.
  { label: 'anthropic-key', re: /sk-ant-[A-Za-z0-9_-]{16,}/g },
  // OpenAI project keys: the `sk-proj-` prefix is distinctive enough to allow `-`/`_`
  // in the body. Must precede the classic rule (which would stop at the first `-`).
  { label: 'openai-key', re: /sk-proj-[A-Za-z0-9_-]{20,}/g },
  // OpenAI classic keys: `sk-` + a long UNBROKEN alphanumeric run. Requiring ≥40 with
  // no separators keeps hyphenated code (e.g. a `sk-loading-spinner…` CSS class) from
  // matching, while real ~48-char keys still do.
  { label: 'openai-key', re: /sk-[A-Za-z0-9]{40,}/g },
  // GitHub tokens: OAuth/app/user/server/refresh family (`gho_`/`ghp_`/`ghu_`/…).
  { label: 'github-token', re: /gh[oprsu]_[A-Za-z0-9]{20,}/g },
  // GitHub fine-grained personal access tokens.
  { label: 'github-token', re: /github_pat_[A-Za-z0-9_]{20,}/g },
  // AWS access key id.
  { label: 'aws-access-key-id', re: /\bAKIA[0-9A-Z]{16}\b/g },
  // Google API key.
  { label: 'google-api-key', re: /AIza[0-9A-Za-z_-]{35}/g },
  // Slack tokens (`xoxb-`/`xoxp-`/`xoxa-`/…).
  { label: 'slack-token', re: /xox[aboprs]-[A-Za-z0-9-]{10,}/g },
  // PEM private-key blocks of any type (RSA/EC/OPENSSH/…), including the payload.
  {
    label: 'private-key',
    re: /-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----[\s\S]*?-----END (?:[A-Z0-9 ]+ )?PRIVATE KEY-----/g
  }
]

/** Replace every well-known secret FORMAT in `text` with a labeled marker. */
function redactPatterns(text: string): string {
  let out = text
  for (const { label, re } of PATTERNS) out = out.replace(re, marker(label))
  return out
}

/** Pre-filter and order known values once: dedupe, drop too-short, longest first. */
function prepareKnownValues(values: readonly string[]): string[] {
  return [...new Set(values)]
    .filter((v) => v.length >= MIN_KNOWN_SECRET_LEN)
    .sort((a, b) => b.length - a.length)
}

/**
 * Build a redactor bound to a fixed set of known secret values. The values are
 * deduped, filtered, and sorted once here so each call is just the scans — use this
 * (over {@link redactSecrets}) on hot paths that reuse the same secret set, e.g. every
 * tool result in a run.
 *
 * Known values are matched longest-first so a secret that contains a shorter secret as
 * a substring is replaced as a whole rather than leaving a dangling fragment.
 */
export function createSecretRedactor(knownValues: readonly string[]): (text: string) => string {
  const values = prepareKnownValues(knownValues)
  return (text: string): string => {
    if (!text) return text
    let out = redactPatterns(text)
    for (const v of values) {
      // split/join avoids regex-escaping arbitrary secret bytes; `includes` guards the
      // allocation so untouched output (the common case) stays cheap.
      if (out.includes(v)) out = out.split(v).join(marker('secret'))
    }
    return out
  }
}

/**
 * One-shot redaction. Convenience wrapper over {@link createSecretRedactor} for
 * callers that don't reuse a secret set (tests, the occasional log line). Prefer the
 * factory when redacting many strings against the same values.
 */
export function redactSecrets(text: string, knownValues: readonly string[] = []): string {
  if (!text) return text
  return createSecretRedactor(knownValues)(text)
}
