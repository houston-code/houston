import type { AppSettings } from '@shared/types'
import type { ResettableKey } from '@shared/settingsPortable'
import { PAGE_LABELS, type TabId } from './pageIds'
import type { SectionComponent } from './context'
import {
  AddProviderSection,
  ContextWindowSection,
  LoopControlSection,
  ProvidersSection,
  ReasoningSection,
  ScorecardSection,
  SystemPromptSection,
  WebSearchSection
} from './sections/models'
import { ApprovalModeSection, PermissionRulesSection } from './sections/permissions'
import { WebReadsSection } from './sections/webReads'
import {
  DiagnosticsSection,
  FormatOnSaveSection,
  HooksSection,
  IntegrationsSection,
  LanguageServersSection
} from './sections/tools'
import { McpServersSection } from './sections/mcp'
import { ProjectHooksSection, ProjectMcpSection } from './sections/project'
import { AdditionalFoldersSection, SandboxEgressSection, TrustedFoldersSection } from './sections/workspace'
import {
  AppearanceSection,
  DiagnosticsCheckSection,
  KeyboardSection,
  LegalSection,
  NotificationsSection,
  PreferencesSection,
  UpdatesSection
} from './sections/app'

export type { TabId } from './pageIds'

/**
 * The nav's groups. Every group shown under a heading has several pages; About
 * is not a group of settings at all and sits apart at the foot of the nav.
 */
export type PageGroup = 'AI' | 'App' | 'Security' | 'About'

/**
 * One section on a page, plus what settings search matches it on beyond its own
 * rendered text (title, description, labels, hints, which search reads from the
 * page itself): other words people use for it, and the user's own values that
 * live in inputs rather than text (provider names, model ids, rule patterns).
 */
export interface SectionEntry {
  id: string
  Component: SectionComponent
  keywords?: string[]
  values?: (s: AppSettings) => Array<string | undefined>
  /** The preferences this section sets, for its "Modified" mark and Reset. */
  keys?: ResettableKey[]
}

export interface SettingsPage {
  id: TabId
  label: string
  group: PageGroup
  /** The page's sections, top to bottom. */
  sections: SectionEntry[]
}

export const PAGES: SettingsPage[] = [
  {
    id: 'models',
    label: PAGE_LABELS.models,
    group: 'AI',
    sections: [
      {
        id: 'providers',
        Component: ProvidersSection,
        keywords: ['api key', 'token', 'credentials', 'login', 'sign in', 'llm', 'endpoint', 'base url', 'region'],
        values: (s) => s.providers.flatMap((p) => [p.label, p.kind, p.baseUrl, ...p.models.map((m) => m.id)])
      },
      {
        id: 'add-provider',
        Component: AddProviderSection,
        keywords: ['new provider', 'custom endpoint', 'local model', 'self-hosted', 'ollama', 'openai compatible', 'host']
      },
      {
        id: 'scorecard',
        Component: ScorecardSection,
        keywords: ['stats', 'statistics', 'usage', 'cost', 'model comparison']
      }
    ]
  },
  {
    id: 'agent',
    label: PAGE_LABELS.agent,
    group: 'AI',
    sections: [
      {
        id: 'system-prompt',
        keys: ['systemPromptExtra'],
        Component: SystemPromptSection,
        keywords: ['instructions', 'custom instructions', 'prompt', 'rules for the agent'],
        values: (s) => [s.systemPromptExtra]
      },
      {
        id: 'context-window',
        keys: ['compactionThreshold', 'shellOutputMaxBytes'],
        Component: ContextWindowSection,
        keywords: ['compaction', 'compact', 'tokens', 'output limit', 'truncate', 'memory']
      },
      {
        id: 'loop-control',
        keys: ['maxIterations', 'autoExtendTurns', 'maxIterationsCeiling', 'costCeilingUsd', 'stallDetection', 'verifyOnStop', 'verifyCommand', 'subagentHistoryMb'],
        Component: LoopControlSection,
        keywords: ['steps', 'iterations', 'max turns', 'budget', 'cost limit', 'stall', 'loop detection', 'verify', 'tests'],
        values: (s) => [s.verifyCommand]
      },
      {
        id: 'reasoning',
        keys: ['reasoningSummary', 'verbosity'],
        Component: ReasoningSection,
        keywords: ['thinking', 'effort', 'summary', 'verbosity']
      }
    ]
  },
  {
    id: 'tools',
    label: PAGE_LABELS.tools,
    group: 'AI',
    sections: [
      {
        id: 'web-search',
        keys: ['searchProvider'],
        Component: WebSearchSection,
        keywords: ['internet', 'search engine', 'api key', 'browse'],
        values: (s) => [s.searchProvider]
      },
      {
        id: 'integrations',
        Component: IntegrationsSection,
        keywords: ['github', 'gh', 'cli', 'installed', 'prettier', 'formatter']
      },
      {
        id: 'language-servers',
        keys: ['lspEnabled'],
        Component: LanguageServersSection,
        keywords: ['lsp', 'code intelligence', 'go to definition', 'typescript', 'pyright'],
        values: (s) => (s.lspServers ?? []).flatMap((l) => [l.id, l.command])
      },
      {
        id: 'format-on-save',
        keys: ['formatOnSave'],
        Component: FormatOnSaveSection,
        keywords: ['prettier', 'formatter', 'gofmt', 'black', 'ruff']
      },
      {
        id: 'diagnostics-on-save',
        keys: ['diagnosticsOnSave'],
        Component: DiagnosticsSection,
        keywords: ['lint', 'eslint', 'errors', 'type check', 'problems']
      }
    ]
  },
  {
    id: 'mcp',
    label: PAGE_LABELS.mcp,
    group: 'AI',
    sections: [
      {
        id: 'mcp-servers',
        Component: McpServersSection,
        keywords: ['model context protocol', 'connectors', 'plugins', 'oauth', 'integrations', 'server'],
        values: (s) => (s.mcpServers ?? []).flatMap((m) => [m.id, m.url, m.command])
      },
      {
        id: 'project-mcp-servers',
        Component: ProjectMcpSection,
        keywords: ['project', 'repository', 'trusted', 'settings.json']
      }
    ]
  },
  {
    id: 'hooks',
    label: PAGE_LABELS.hooks,
    group: 'AI',
    sections: [
      {
        id: 'hooks',
        Component: HooksSection,
        keywords: ['automation', 'scripts', 'pre tool use', 'post tool use', 'events', 'commands'],
        values: (s) => (s.hooks ?? []).flatMap((h) => [h.command, h.matcher])
      },
      {
        id: 'project-hooks',
        Component: ProjectHooksSection,
        keywords: ['project', 'repository', 'trusted', 'settings.json']
      }
    ]
  },
  {
    id: 'general',
    label: PAGE_LABELS.general,
    group: 'App',
    sections: [
      {
        id: 'notifications',
        keys: ['desktopNotifications', 'appBadge'],
        Component: NotificationsSection,
        keywords: ['alerts', 'desktop notifications', 'sound', 'bell', 'badge', 'dock', 'taskbar', 'unread']
      },
      {
        id: 'preferences',
        Component: PreferencesSection,
        keywords: ['export', 'import', 'backup', 'restore', 'reset', 'defaults', 'sync', 'migrate']
      }
    ]
  },
  {
    id: 'appearance',
    label: PAGE_LABELS.appearance,
    group: 'App',
    sections: [
      {
        id: 'appearance',
        keys: ['theme', 'htmlVisuals'],
        Component: AppearanceSection,
        keywords: ['theme', 'dark mode', 'light mode', 'colors', 'visuals', 'html']
      }
    ]
  },
  {
    id: 'keyboard',
    label: PAGE_LABELS.keyboard,
    group: 'App',
    sections: [
      {
        id: 'keyboard',
        keys: ['keybindings'],
        Component: KeyboardSection,
        keywords: ['shortcuts', 'keybindings', 'hotkeys', 'keys', 'rebind']
      }
    ]
  },
  {
    id: 'permissions',
    label: PAGE_LABELS.permissions,
    group: 'Security',
    sections: [
      {
        id: 'approval-mode',
        Component: ApprovalModeSection,
        keywords: ['approval policy', 'auto approve', 'full auto', 'yolo', 'plan mode', 'ask', 'confirm', 'default mode']
      },
      {
        id: 'web-reads',
        keys: ['webReads'],
        Component: WebReadsSection,
        keywords: ['web fetch', 'web search', 'full auto', 'internet', 'browse', 'urls', 'sites']
      },
      {
        id: 'permission-rules',
        Component: PermissionRulesSection,
        keywords: ['rules', 'allow', 'deny', 'ask', 'allowlist', 'blocklist', 'security', 'approve', 'always allow'],
        values: (s) => (s.permissionRules ?? []).flatMap((r) => [r.tool, r.match])
      },
      {
        id: 'trusted-folders',
        Component: TrustedFoldersSection,
        keywords: ['trust', 'project config', 'untrusted', 'security']
      },
      {
        id: 'sandbox-egress',
        keys: ['sandboxEgress'],
        Component: SandboxEgressSection,
        keywords: ['network', 'internet', 'proxy', 'domains', 'firewall', 'allowlist', 'outbound'],
        values: (s) => [...(s.sandboxEgress?.allow ?? []), ...(s.sandboxEgress?.deny ?? [])]
      }
    ]
  },
  {
    id: 'workspace',
    label: PAGE_LABELS.workspace,
    group: 'Security',
    sections: [
      {
        id: 'additional-folders',
        Component: AdditionalFoldersSection,
        keywords: ['directories', 'roots', 'paths', 'monorepo', 'access']
      }
    ]
  },
  {
    id: 'about',
    label: PAGE_LABELS.about,
    group: 'About',
    sections: [
      {
        id: 'updates',
        Component: UpdatesSection,
        keywords: ['version', 'upgrade', 'release', 'check for updates']
      },
      {
        id: 'diagnostics',
        Component: DiagnosticsCheckSection,
        keywords: ['doctor', 'health check', 'troubleshoot', 'debug', 'setup']
      },
      {
        id: 'legal',
        Component: LegalSection,
        keywords: ['privacy', 'license', 'terms', 'open source', 'apache']
      }
    ]
  }
]

/** The headed groups, top to bottom (About is the nav's footer). */
export const PAGE_GROUPS: PageGroup[] = ['AI', 'App', 'Security']

/** The page that holds a given page id, falling back to the first. */
export function pageById(id: TabId): SettingsPage {
  return PAGES.find((p) => p.id === id) ?? PAGES[0]
}
