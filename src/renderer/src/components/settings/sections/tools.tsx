import { useEffect, useState } from 'react'
import type { Hook, IntegrationsInfo } from '@shared/types'
import { LspServersField, SettingsSection } from '../fields'
import type { SettingsCtx } from '../context'

/** Shell commands run at points in the agent loop. */
export function HooksSection({ ctx }: { ctx: SettingsCtx }): JSX.Element {
  const { settings, setSettings } = ctx
  const hooks = settings.hooks ?? []
  const setHooks = (next: Hook[]): void => setSettings((s) => ({ ...s, hooks: next }))
  const addHook = (): void =>
    setHooks([...hooks, { event: 'PostToolUse', matcher: 'edit_file', command: '' }])
  const patchHook = (i: number, patch: Partial<Hook>): void =>
    setHooks(hooks.map((h, idx) => (idx === i ? { ...h, ...patch } : h)))
  const removeHook = (i: number): void => setHooks(hooks.filter((_, idx) => idx !== i))

  return (
    <SettingsSection
      title="Hooks"
      desc={
        <>
          Shell commands run at points in the agent loop (sandboxed to the project, no
          network). <strong>PreToolUse</strong> runs before a tool, and a non-zero exit
          blocks it; <strong>PostToolUse</strong> runs after, and its output is shown to
          the agent. <strong>UserPromptSubmit</strong> / <strong>SessionStart</strong> /{' '}
          <strong>Stop</strong> / <strong>PreCompact</strong> run around the turn (a Stop
          hook that exits non-zero makes the agent keep working). Context is in{' '}
          <code>$HOUSTON_TOOL_NAME</code> / <code>$HOUSTON_TOOL_INPUT</code> /{' '}
          <code>$HOUSTON_USER_PROMPT</code> (a value over 16 KB is in a temp file named
          by the same variable with <code>_FILE</code> added). A hook can also print a
          JSON directive (
          <code>{'{ decision, reason, additionalContext, updatedInput }'}</code>) on
          stdout to steer the loop.
        </>
      }
    >
      {hooks.map((h, i) => (
        <div className="rule" key={i}>
          <select
            value={h.event}
            onChange={(e) => patchHook(i, { event: e.target.value as Hook['event'] })}
          >
            <option value="PreToolUse">Pre</option>
            <option value="PostToolUse">Post</option>
            <option value="UserPromptSubmit">Prompt</option>
            <option value="SessionStart">Session</option>
            <option value="Stop">Stop</option>
            <option value="PreCompact">Compact</option>
          </select>
          <input
            list="tool-names"
            className="rule__tool"
            placeholder="tool (or *)"
            value={h.matcher}
            onChange={(e) => patchHook(i, { matcher: e.target.value.trim() })}
          />
          <input
            className="rule__match"
            placeholder="shell command, e.g. npm run format"
            value={h.command}
            onChange={(e) => patchHook(i, { command: e.target.value })}
          />
          <button className="btn btn--sm btn--danger" onClick={() => removeHook(i)}>
            ✕
          </button>
        </div>
      ))}
      <button className="btn btn--sm" onClick={addHook}>
        + Add hook
      </button>
    </SettingsSection>
  )
}

/** Status of the optional extras on this machine (gh, formatters, language servers). */
export function IntegrationsSection(): JSX.Element {
  // Optional-integrations status (gh CLI + formatters), shown as a hint in the Tools tab.
  const [integrations, setIntegrations] = useState<IntegrationsInfo | null>(null)
  useEffect(() => {
    void window.api.getIntegrations().then(setIntegrations)
  }, [])

  // Tone for the optional-integration status pills. While still loading we use a
  // neutral accent pill so "Checking…" doesn't masquerade as an amber warning.
  const ghTone =
    integrations == null
      ? 'accent'
      : integrations.gh.installed && integrations.gh.authenticated
        ? 'ok'
        : 'warn'
  const formatterTone =
    integrations != null &&
    !integrations.formattersNeedGitBash &&
    integrations.formatters.some((f) => f.installed)
      ? 'ok'
      : 'warn'

  const lspFound = integrations?.languageServers?.filter((l) => l.path) ?? []
  const lspTone = integrations != null && !integrations.languageServersBlocked && lspFound.length > 0 ? 'ok' : 'warn'

  return (
    <SettingsSection
      title="Optional integrations"
      desc="These extras are optional. Houston works without them. Status on this machine:"
    >
      <div className="integration">
        <span className="integration__name">
          GitHub CLI (<code>gh</code>)
        </span>
        <span
          className={`integration__status pill integration__status--${ghTone} pill--${ghTone}`}
        >
          {integrations == null
            ? 'Checking…'
            : !integrations.gh.installed
              ? 'Not found'
              : integrations.gh.authenticated
                ? 'Installed & signed in'
                : 'Installed, not signed in'}
        </span>
      </div>
      {integrations != null &&
        !(integrations.gh.installed && integrations.gh.authenticated) && (
          <p className="field__hint">
            Enables the <code>gh_*</code> GitHub tools (pull requests, issues, checks).{' '}
            {!integrations.gh.installed ? (
              <>
                Install it from{' '}
                <a href="https://cli.github.com" target="_blank" rel="noreferrer">
                  cli.github.com
                </a>{' '}
                and run <code>gh auth login</code>.
              </>
            ) : (
              <>
                Run <code>gh auth login</code> to sign in.
              </>
            )}
          </p>
        )}
      {integrations != null && (
        <>
          <div className="integration">
            <span className="integration__name">Formatters (format on save)</span>
            <span
              className={`integration__status pill integration__status--${formatterTone} pill--${formatterTone}`}
            >
              {integrations.formattersNeedGitBash ? (
                'Needs Git for Windows'
              ) : (
                <>
                  {integrations.formatters.filter((f) => f.installed).length} of{' '}
                  {integrations.formatters.length} found
                </>
              )}
            </span>
          </div>
          {integrations.formattersNeedGitBash ? (
            <p className="field__hint">
              Format on save and post-edit diagnostics need Git for Windows (Git
              Bash). Install it from{' '}
              <a href="https://gitforwindows.org" target="_blank" rel="noreferrer">
                gitforwindows.org
              </a>
              , then restart Houston.
            </p>
          ) : (
            <p className="field__hint">
              {integrations.formatters.map((f, i) => (
                <span key={f.bin}>
                  {i > 0 && ', '}
                  <code>{f.bin}</code> {f.installed ? '✓' : '✗'}
                </span>
              ))}
              . Install the ones you want on your <code>PATH</code>; the matching formatter
              runs only when present.
            </p>
          )}
        </>
      )}
      {integrations?.languageServers && (
        <>
          <div className="integration">
            <span className="integration__name">Language servers (code intelligence)</span>
            <span
              className={`integration__status pill integration__status--${lspTone} pill--${lspTone}`}
            >
              {integrations.languageServersBlocked === 'disabled'
                ? 'Off'
                : integrations.languageServersBlocked === 'needs-git-bash'
                  ? 'Needs Git for Windows'
                  : integrations.languageServersBlocked === 'unsandboxed'
                    ? 'Off: no sandbox'
                    : `${lspFound.length} of ${integrations.languageServers.length} found`}
            </span>
          </div>
          <p className="field__hint">
            {integrations.languageServers.map((l, i) => (
              <span key={l.id}>
                {i > 0 && ', '}
                <code>{l.id}</code> {l.path ? '✓' : '✗'}
              </span>
            ))}
            . A language server gives the agent type-aware diagnostics after each edit and
            go-to-definition, references, and rename. Install the ones you want on your{' '}
            <code>PATH</code> (a project&apos;s own <code>node_modules/.bin</code> also
            counts), for example{' '}
            <code>npm install -g typescript-language-server typescript</code>.
          </p>
        </>
      )}
    </SettingsSection>
  )
}

export function LanguageServersSection({ ctx }: { ctx: SettingsCtx }): JSX.Element {
  const { settings, setSettings } = ctx
  return (
    <SettingsSection title="Language servers">
      <label className="field">
        <span>Run language servers</span>
        <select
          value={
            settings.lspEnabled === undefined ? 'auto' : settings.lspEnabled ? 'on' : 'off'
          }
          onChange={(e) => {
            const v = e.target.value
            setSettings((s) => ({
              ...s,
              lspEnabled: v === 'auto' ? undefined : v === 'on'
            }))
          }}
        >
          <option value="auto">Automatic: when the sandbox can confine them</option>
          <option value="on">Always, even without a sandbox</option>
          <option value="off">Never</option>
        </select>
      </label>
      <p className="field__hint">
        Servers start on demand, one per language and project, run sandboxed with no
        network, and stop after ten idle minutes. A server can run code from the project
        (a TypeScript plugin, a Rust build script), which is why Automatic keeps them off
        on a host with no sandbox.
      </p>
      <LspServersField
        servers={settings.lspServers}
        onChange={(list) => setSettings((s) => ({ ...s, lspServers: list.length ? list : undefined }))}
      />
      <p className="field__hint">
        Optional. Each entry needs <code>id</code>, <code>command</code> (a name on{' '}
        <code>PATH</code> or an absolute path), and <code>extensions</code>; add{' '}
        <code>args</code>, <code>languageId</code>, or <code>rootMarkers</code> as needed.
        Reusing a built-in id (<code>typescript</code>, <code>python</code>,{' '}
        <code>go</code>, <code>rust</code>, <code>clangd</code>) replaces it.
      </p>
    </SettingsSection>
  )
}

export function FormatOnSaveSection({ ctx }: { ctx: SettingsCtx }): JSX.Element {
  const { settings, setSettings } = ctx
  return (
    <SettingsSection title="Format on save">
      <label className="field field--checkbox">
        <input
          type="checkbox"
          checked={settings.formatOnSave ?? false}
          onChange={(e) =>
            setSettings((s) => ({ ...s, formatOnSave: e.target.checked }))
          }
        />
        <span>
          After the agent writes a file, run the matching formatter on it (Prettier for
          JS/TS/JSON/CSS/Markdown, <code>gofmt</code>, <code>rustfmt</code>,{' '}
          <code>ruff</code>/<code>black</code> for Python). Only runs when the formatter
          is installed (see <em>Optional integrations</em> above); off by default.
        </span>
      </label>
    </SettingsSection>
  )
}

export function DiagnosticsSection({ ctx }: { ctx: SettingsCtx }): JSX.Element {
  const { settings, setSettings } = ctx
  return (
    <SettingsSection title="Diagnostics on save">
      <label className="field">
        <span>After the agent writes a file</span>
        <select
          value={
            settings.diagnosticsOnSave === undefined
              ? 'auto'
              : settings.diagnosticsOnSave
                ? 'on'
                : 'off'
          }
          onChange={(e) => {
            const v = e.target.value
            setSettings((s) => ({
              ...s,
              diagnosticsOnSave: v === 'auto' ? undefined : v === 'on'
            }))
          }}
        >
          <option value="auto">Check with a language server when one covers the file</option>
          <option value="on">Language server, or else a fast checker</option>
          <option value="off">Don&apos;t check</option>
        </select>
      </label>
      <p className="field__hint">
        Shows the agent the problems its edit introduced (errors, and a few warnings) so
        it can fix them in the same turn. Problems the file already had are left out.
        The fast checkers are <code>eslint</code> for JS/TS, <code>ruff</code>/
        <code>pyflakes</code> for Python, and <code>gofmt</code> for Go, used for files
        no language server covers. Read-only: never edits the file.
      </p>
    </SettingsSection>
  )
}
