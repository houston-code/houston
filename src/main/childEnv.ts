/**
 * Sanitizing the environment Houston hands to child processes it spawns on the
 * user's behalf — sandboxed `run_shell` commands and MCP stdio servers.
 *
 * A GUI-launched Houston inherits the full environment of whatever shell started
 * it, which routinely holds exported credentials (AWS keys, `GH_TOKEN`, assorted
 * `*_API_KEY`s). Spreading that environment wholesale into a child means a
 * prompt-injected model with shell + network can `env | curl` those secrets
 * straight out, and a malicious or compromised MCP server receives every one of
 * them on startup. Houston hands provider keys to SDKs via constructor params,
 * never through a child's environment — and the standalone CLI's env-supplied
 * keys (ANTHROPIC_API_KEY, HOUSTON_API_KEY_<ID>, …) are `_KEY`-shaped, so the
 * filter below withholds them from children too. This is defense-in-depth
 * against credentials sitting in Houston's own environment, not a fix for an
 * active key leak — but it's cheap to close.
 *
 * The filter is a denylist rather than a strict allowlist on purpose: the sandbox
 * runs arbitrary developer commands (npm/go/cargo/git test + build suites) that
 * legitimately read a long, unpredictable tail of config vars (`NODE_ENV`, `CI`,
 * `DATABASE_URL`, proxy settings, custom app config …). A strict allowlist would
 * silently break those. Dropping only credential-shaped names removes the leak
 * while leaving ordinary configuration intact.
 */

/**
 * Names whose *substring* marks the var as credential-bearing. Matched
 * case-insensitively anywhere in the name, so `AWS_SECRET_ACCESS_KEY`,
 * `AWS_ACCESS_KEY_ID`, `NPM_TOKEN`, `DB_PASSWORD`, `STRIPE_CREDENTIAL`,
 * `SOME_AUTH`, `SENDGRID_APIKEY`, `GPG_PASSPHRASE`, and `SESSION_COOKIE` all hit.
 */
const SECRET_NAME_PATTERN = /(_KEY|_TOKEN|_SECRET|PASSWORD|PASSWD|PASSPHRASE|CREDENTIAL|_AUTH|APIKEY|COOKIE)/i

/**
 * Credential-shaped *suffixes*, matched only at the end of the name because as
 * substrings they would hit ordinary config: `_PAT` (a personal access token,
 * `GITHUB_PAT`) is a prefix of every `*_PATH`; `_PASS` (`SMTP_PASS`) of
 * `*_PASSTHROUGH`; `_SESSION` (`TWITCH_SESSION`; `*_SESSION_TOKEN` already ends in
 * `_TOKEN`) of `XDG_SESSION_TYPE` and `DBUS_SESSION_BUS_ADDRESS`, which desktop
 * tools need. `_PWD` is `MYSQL_PWD`, and plain `PWD`/`OLDPWD` have no underscore.
 * A DSN (`SENTRY_DSN`, `DATABASE_DSN`) embeds its credentials by design.
 */
const SECRET_NAME_SUFFIX_PATTERN = /(_PAT|_PASS|_PWD|_SESSION|(^|_)DSN)$/i

/**
 * Whole namespaces to drop regardless of the pattern. The AWS SDK/CLI reads its
 * credentials AND its non-secret config (`AWS_REGION`, `AWS_PROFILE`) from the
 * `AWS_` namespace; dropping the lot is the conservative choice — with the
 * credentials gone, an in-sandbox `aws` call has to be given fresh ones anyway.
 */
const SECRET_NAME_PREFIXES = ['AWS_']

/**
 * Exact names to drop that the pattern would otherwise miss. `GH_TOKEN` /
 * `GITHUB_TOKEN` already match `_TOKEN`; they're listed explicitly as documented
 * belt-and-suspenders for the most common exfiltration targets.
 */
const SECRET_NAMES = new Set(['GH_TOKEN', 'GITHUB_TOKEN'])

/**
 * Names that match {@link SECRET_NAME_PATTERN} but are NOT leakable secrets and
 * whose removal breaks real workflows. `SSH_AUTH_SOCK` is a filesystem path to the
 * ssh-agent's unix socket (git-over-ssh needs it); the private key itself never
 * transits the environment, so it can't be `curl`-ed out — keep it.
 */
const KEEP_EXCEPTIONS = new Set(['SSH_AUTH_SOCK'])

/** Whether an env var name should be withheld from a spawned child (see module doc). */
export function isSecretEnvName(name: string): boolean {
  if (KEEP_EXCEPTIONS.has(name)) return false
  if (SECRET_NAMES.has(name)) return true
  if (SECRET_NAME_PREFIXES.some((p) => name.startsWith(p))) return true
  return SECRET_NAME_PATTERN.test(name) || SECRET_NAME_SUFFIX_PATTERN.test(name)
}

/**
 * Names whose value is a URL that may carry credentials in its userinfo
 * (`DATABASE_URL=postgres://user:pass@db/app`, `REDIS_URL`, `AMQP_URI`). These are
 * kept, since test suites and dev servers read them to find their services, but the
 * userinfo is cut out (see {@link stripUrlUserinfo}): a child that needs the
 * password has to be given it explicitly. Proxy variables (`HTTP_PROXY`, …) are not
 * `_URL`-shaped and are left alone: a sandboxed command under the egress allowlist
 * gets the egress proxy's own values in their place, and an MCP server behind an
 * authenticating proxy needs them to reach anything.
 */
const URL_VALUED_NAME = /(^|_)(URL|URI)$/i

/**
 * A URL with its userinfo (`user:pass@`) removed, or the value unchanged when it has
 * none. The authority is what lies between `scheme://` and the first `/`, `?`, or
 * `#`; its last `@` ends the userinfo (an unescaped `@` in a password is common in
 * hand-written values). Done on the string rather than with `URL`, which rejects or
 * rewrites forms these vars routinely hold (`postgres://u:p@h1,h2/db`, a scheme
 * `URL` doesn't know).
 */
export function stripUrlUserinfo(value: string): string {
  const m = value.match(/^([a-z][a-z0-9+.-]*:\/\/)([^/?#]*)/i)
  if (!m) return value
  const at = m[2].lastIndexOf('@')
  if (at < 0) return value
  return m[1] + m[2].slice(at + 1) + value.slice(m[0].length)
}

/**
 * A copy of `baseEnv` with every credential-bearing var (see
 * {@link isSecretEnvName}) removed, safe to hand to a child process. `PATH`,
 * `HOME`, `TMPDIR`, `LANG`/`LC_*`, `SHELL`, and ordinary configuration all
 * survive; only credential-shaped names are dropped, and the userinfo of a
 * `*_URL` / `*_URI` value is cut out (the var is kept). `undefined` entries are
 * skipped so the result is a clean string map.
 */
export function sanitizeChildEnv(baseEnv: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {}
  for (const [key, value] of Object.entries(baseEnv)) {
    if (value === undefined) continue
    if (isSecretEnvName(key)) continue
    out[key] = URL_VALUED_NAME.test(key) ? stripUrlUserinfo(value) : value
  }
  return out
}
