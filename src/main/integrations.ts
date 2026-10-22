import { resolveGh, runGh } from './agent/github'
import { FORMATTERS, canRunTool, type Formatter } from './agent/format'
import { backendShellSyntax, type ShellSyntax } from './sandbox'
import type { FormatterStatus, IntegrationsInfo } from '@shared/types'
import { LspManager, type LspSettings } from './agent/lsp/manager'

/**
 * Runtime status of OPTIONAL integrations — the `gh` CLI and the format-on-save
 * backends — for the Settings "Optional integrations" hint. None of these are
 * required; this only tells the user what's available and how to turn it on.
 *
 * Deps are injectable so the pure logic is unit-testable without touching the real
 * filesystem or spawning `gh`.
 */
export interface IntegrationsDeps {
  /** Locate the `gh` binary (default: the real PATH probe). */
  resolveGh?: () => string | null
  /** Whether `gh auth status` succeeds for a resolved gh path (default: runs it). */
  ghAuthOk?: (ghPath: string) => Promise<boolean>
  /** Whether a formatter can run here (default: the real PATH probe + shell check). */
  hasBin?: (bin: string) => boolean
  /** The extension→formatters registry (default: the real one). */
  formatters?: Record<string, Formatter[]>
  /** The sandbox shell's syntax (default: the active backend's). */
  shellSyntax?: ShellSyntax
  /** Language-server status; omitted from the result when not given. */
  languageServers?: () => Pick<IntegrationsInfo, 'languageServers' | 'languageServersBlocked'>
}

/** Language-server status for these settings: each server's binary resolved on PATH (nothing is started). */
export function languageServerIntegration(
  settings: LspSettings
): Pick<IntegrationsInfo, 'languageServers' | 'languageServersBlocked'> {
  const probe = new LspManager()
  probe.configure(settings)
  const blocked = probe.blockedReason()
  return { languageServers: probe.statuses(), ...(blocked ? { languageServersBlocked: blocked } : {}) }
}

/** Default auth probe: `gh auth status` exits 0 iff at least one account is logged in. */
async function defaultGhAuthOk(ghPath: string): Promise<boolean> {
  const res = await runGh(ghPath)(['auth', 'status'], process.cwd())
  return res.ok
}

/**
 * Invert the extension→formatters registry into a deduped per-binary view, recording
 * which extensions each binary covers and whether it's installed. Sorted by binary
 * name for a stable UI order.
 */
export function formatterStatuses(
  registry: Record<string, Formatter[]>,
  hasBin: (bin: string) => boolean
): FormatterStatus[] {
  const langsByBin = new Map<string, Set<string>>()
  for (const [ext, list] of Object.entries(registry)) {
    for (const f of list) {
      const langs = langsByBin.get(f.bin) ?? new Set<string>()
      langs.add(ext)
      langsByBin.set(f.bin, langs)
    }
  }
  return [...langsByBin.entries()]
    .map(([bin, langs]) => ({ bin, installed: hasBin(bin), languages: [...langs].sort() }))
    .sort((a, b) => a.bin.localeCompare(b.bin))
}

/** Compute the optional-integrations status for the running host. */
export async function getIntegrations(deps: IntegrationsDeps = {}): Promise<IntegrationsInfo> {
  const resolve = deps.resolveGh ?? (() => resolveGh())
  const authOk = deps.ghAuthOk ?? defaultGhAuthOk
  const hasBin = deps.hasBin ?? ((b: string) => canRunTool(b))
  const registry = deps.formatters ?? FORMATTERS

  const ghPath = resolve()
  const installed = ghPath !== null
  const authenticated = installed ? await authOk(ghPath) : false

  return {
    gh: { installed, authenticated },
    formatters: formatterStatuses(registry, hasBin),
    // cmd.exe can't be handed a safely quoted formatter command (see planToolRun).
    formattersNeedGitBash: (deps.shellSyntax ?? backendShellSyntax()) === 'cmd',
    ...(deps.languageServers ? deps.languageServers() : {})
  }
}
