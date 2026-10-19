/**
 * Secret redaction for content that leaves the agent's control boundary — tool
 * results (which flow to the model, the renderer, and the on-disk transcript) and
 * log lines. Two layers are applied, in order:
 *
 *   1. Pattern redaction. Well-known token FORMATS (Anthropic/OpenAI/GitHub/AWS/…)
 *      are matched by shape, so a third-party secret the agent surfaces from the
 *      user's own files — one we hold no stored copy of — is still caught. Kept to
 *      high-precision prefixes only; no entropy guessing, which is noisy on the
 *      code-heavy output agents routinely produce. Shapeless secrets (a hex session
 *      key, a password) are caught by CONTEXT instead: a dotenv-style
 *      `SESSION_SECRET=…` line, as `cat .env`, `env`, or `grep` prints it, has its
 *      value masked when the variable's NAME says it is a secret (see
 *      {@link redactEnvLine}).
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
  // AWS access key ids: `AKIA` long-lived, `ASIA` temporary — the shape SSO, IAM roles,
  // and STS mint, so it is what an assumed-role session leaves in the environment. The
  // AWS *secret* access key is 40 unprefixed base64 chars with no distinguishing shape;
  // patterning it would match ordinary code and prose, so it is deliberately left out.
  { label: 'aws-access-key-id', re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  // Google API key.
  { label: 'google-api-key', re: /AIza[0-9A-Za-z_-]{35}/g },
  // Google OAuth tokens: the `ya29.` access token and the `1//` refresh token, both of
  // which `gcloud auth application-default login` writes to
  // ~/.config/gcloud/application_default_credentials.json. The `\b` on the refresh rule
  // is load-bearing: without it a doubled slash in a URL path (`…/v1//some-long-segment`)
  // would match.
  { label: 'google-oauth-token', re: /\bya29\.[A-Za-z0-9_-]{20,}/g },
  { label: 'google-oauth-token', re: /\b1\/\/[A-Za-z0-9_-]{20,}/g },
  // Slack tokens (`xoxb-`/`xoxp-`/`xoxa-`/…).
  { label: 'slack-token', re: /xox[aboprs]-[A-Za-z0-9-]{10,}/g },
  // PEM private-key blocks of any type (RSA/EC/OPENSSH/…), including the payload.
  {
    label: 'private-key',
    re: /-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----[\s\S]*?-----END (?:[A-Z0-9 ]+ )?PRIVATE KEY-----/g
  }
]

/** A variable name that says its value is a credential. Matched on the upper-cased name. */
const SECRET_NAME =
  /(SECRET|TOKEN|PASSWORD|PASSWD|PASSPHRASE|API_?KEY|PRIVATE_?KEY|ACCESS_?KEY|SIGNING_?KEY|ENCRYPTION_?KEY|CREDENTIALS?)/

/**
 * Names that mention a secret but hold something else about it: where it lives, how
 * long it lasts, what it is called (`TOKEN_URL`, `JWT_SECRET_FILE`, `TOKEN_TTL`).
 */
const NOT_A_SECRET_VALUE =
  /_(URL|URI|ENDPOINT|HOST|PORT|PATH|FILE|DIR|TTL|EXPIRY|EXPIRES|EXPIRES_IN|HEADER|NAME|TYPE|LENGTH|ALGORITHM|ALG|MODE|ENABLED|REGION|ID)$/

/**
 * What may precede the name on the line: an optional `grep`-style `path:` / `path:12:` /
 * `12:` / `12-` prefix, indentation, and `export `. Tested only against the short text
 * before the name, anchored at both ends.
 */
const ASSIGNMENT_PREFIX = /^(?:[^\s:=]+:)?(?:\d+[:-])?[ \t]*(?:export[ \t]+)?$/

const isIdentChar = (c: number): boolean =>
  (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95

/**
 * Mask the value of one dotenv-style `NAME=value` line, as a dotenv file, `env` /
 * `printenv`, a shell `export`, or `grep -n` prints it, when the NAME says it is a
 * secret. The name stays visible, so the agent can still say which variable holds the
 * secret and in which file. No spaces around `=`: that is the dotenv and shell shape,
 * and it keeps `token = get_token()` style code out. Left alone: empty values,
 * references to another variable (`$OTHER`, `${OTHER}`), values already masked by a
 * format rule, and code-shaped right-hand sides (`TOKEN=get_token()`).
 *
 * Parsed by hand rather than with one line regex: tool output can carry megabyte-long
 * lines, and a single regex over prefix, name, value and comment backtracks badly on
 * them. Every step here is linear in the line.
 */
function redactEnvLine(line: string): string {
  const eq = line.indexOf('=')
  if (eq <= 0) return line
  let start = eq
  while (start > 0 && isIdentChar(line.charCodeAt(start - 1))) start--
  const name = line.slice(start, eq)
  const first = name.charCodeAt(0)
  if (!name || (first >= 48 && first <= 57)) return line
  const upper = name.toUpperCase()
  if (!SECRET_NAME.test(upper) || NOT_A_SECRET_VALUE.test(upper)) return line
  const prefix = line.slice(0, start)
  if (!ASSIGNMENT_PREFIX.test(prefix)) return line

  let rest = line.slice(eq + 1)
  const cr = rest.endsWith('\r') ? '\r' : ''
  if (cr) rest = rest.slice(0, -1)
  let raw: string
  const q = rest[0]
  const close = q === '"' || q === "'" ? rest.indexOf(q, 1) : -1
  if (close > 0) {
    raw = rest.slice(0, close + 1)
  } else {
    // A ` #` (whitespace, then #) starts a trailing comment; a bare `#` is part of the value.
    let comment = -1
    for (let k = rest.indexOf('#'); k > 0; k = rest.indexOf('#', k + 1)) {
      const before = rest[k - 1]
      if (before === ' ' || before === '\t') {
        comment = k
        break
      }
    }
    raw = (comment < 0 ? rest : rest.slice(0, comment)).trimEnd()
  }
  const tail = rest.slice(raw.length)
  const value = (close > 0 ? raw.slice(1, -1) : raw).trim()
  if (!value || value.startsWith('$') || value.includes('[redacted:')) return line
  if (/^[A-Za-z_][\w.]*\(/.test(value)) return line
  return `${prefix}${name}=${marker('env-secret')}${tail}${cr}`
}

/** Apply {@link redactEnvLine} to every line of `text`. */
function redactEnvAssignments(text: string): string {
  if (!text.includes('=')) return text
  const lines = text.split('\n')
  let changed = false
  for (let i = 0; i < lines.length; i++) {
    const next = redactEnvLine(lines[i])
    if (next !== lines[i]) {
      lines[i] = next
      changed = true
    }
  }
  return changed ? lines.join('\n') : text
}

/** Replace every well-known secret FORMAT, and every secret-named env value, in `text`. */
function redactPatterns(text: string): string {
  let out = text
  for (const { label, re } of PATTERNS) out = out.replace(re, marker(label))
  return redactEnvAssignments(out)
}

/**
 * How many redaction markers in `text` sit where a value goes: right after `=` or `:`,
 * optionally quoted (`SECRET=[redacted:…]`, `"token": "[redacted:…]"`). Code that merely
 * mentions a marker (`expect(x).toBe('[redacted:secret]')`) doesn't count.
 */
function countValueMarkers(text: string): number {
  return text.match(/[=:][ \t]*["']?\[redacted:[a-z0-9-]+\]/g)?.length ?? 0
}

/**
 * Refuse a file write that would put a redaction marker where a value goes. The agent
 * only ever sees secrets as `[redacted:…]`, so writing back what it read (a whole
 * `.env` via write_file, or an edit that reuses a masked line) would replace the
 * user's real secret with the marker text. Compares against the file's current
 * content, so a file that already holds such markers (redaction tests, fixtures) can
 * still be edited. Throws with guidance; returns nothing when the write is safe.
 */
export function assertNoRedactedValues(before: string, after: string): void {
  if (countValueMarkers(after) <= countValueMarkers(before)) return
  throw new Error(
    'This write would replace a secret with a [redacted:…] placeholder. Secrets are hidden ' +
      'from you, so the placeholder is not the real value. Leave those lines out of the edit ' +
      '(change only the lines you need with edit_file), or ask the user to set the value.'
  )
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

/**
 * Detect — rather than mask — a secret in `text`, returning the first match's label
 * (e.g. `anthropic-key`, or `secret` for a known stored value) or null when clean.
 * Uses the SAME two layers as {@link createSecretRedactor}: well-known token FORMATS
 * first (so a third-party key we hold no copy of is still caught), then this install's
 * own stored values.
 *
 * This powers egress-side credential masking: before Houston sends an agent-authored
 * string OUT over the network (a `web_fetch` URL, a `web_search` query), the caller
 * refuses the call when a credential is present, so a compromised or prompt-injected
 * agent can't exfiltrate a key by pasting it into a request. Redaction protects the
 * INBOUND direction (tool results → model/UI/disk); this protects the OUTBOUND one.
 */
export function findSecret(text: string, knownValues: readonly string[] = []): string | null {
  if (!text) return null
  for (const { label, re } of PATTERNS) {
    // These module-level regexes carry the `g` flag, so `test` advances `lastIndex`;
    // reset it first so a prior call's leftover position can't skip an early match.
    re.lastIndex = 0
    if (re.test(text)) return label
  }
  for (const v of prepareKnownValues(knownValues)) {
    if (text.includes(v)) return 'secret'
  }
  return null
}
