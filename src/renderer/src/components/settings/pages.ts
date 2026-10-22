import type { AppSettings } from '@shared/types'
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
  UpdatesSection
} from './sections/app'

/** Settings pages shown in the left-hand nav. */
export type TabId =
  | 'models'
  | 'agent'
  | 'tools'
  | 'mcp'
  | 'hooks'
  | 'workspace'
  | 'general'
  | 'appearance'
  | 'keyboard'
  | 'permissions'
  | 'about'

/** The nav's headed groups, in order. */
export type PageGroup = 'AI' | 'Workspace' | 'App' | 'Security' | 'About'

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
    label: 'Providers & Models',
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
    label: 'Agent Behavior',
    group: 'AI',
    sections: [
      {
        id: 'system-prompt',
        Component: SystemPromptSection,
        keywords: ['instructions', 'custom instructions', 'prompt', 'rules for the agent'],
        values: (s) => [s.systemPromptExtra]
      },
      {
        id: 'context-window',
        Component: ContextWindowSection,
        keywords: ['compaction', 'compact', 'tokens', 'output limit', 'truncate', 'memory']
      },
      {
        id: 'loop-control',
        Component: LoopControlSection,
        keywords: ['steps', 'iterations', 'max turns', 'budget', 'cost limit', 'stall', 'loop detection', 'verify', 'tests'],
        values: (s) => [s.verifyCommand]
      },
      {
        id: 'reasoning',
        Component: ReasoningSection,
        keywords: ['thinking', 'effort', 'summary', 'verbosity']
      }
    ]
  },
  {
    id: 'tools',
    label: 'Tools',
    group: 'AI',
    sections: [
      {
        id: 'web-search',
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
        Component: LanguageServersSection,
        keywords: ['lsp', 'code intelligence', 'go to definition', 'typescript', 'pyright'],
        values: (s) => (s.lspServers ?? []).flatMap((l) => [l.id, l.command])
      },
      {
        id: 'format-on-save',
        Component: FormatOnSaveSection,
        keywords: ['prettier', 'formatter', 'gofmt', 'black', 'ruff']
      },
      {
        id: 'diagnostics-on-save',
        Component: DiagnosticsSection,
        keywords: ['lint', 'eslint', 'errors', 'type check', 'problems']
      }
    ]
  },
  {
    id: 'mcp',
    label: 'MCP Servers',
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
    label: 'Hooks',
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
    id: 'workspace',
    label: 'Workspace',
    group: 'Workspace',
    sections: [
      {
        id: 'additional-folders',
        Component: AdditionalFoldersSection,
        keywords: ['directories', 'roots', 'paths', 'monorepo', 'access']
      }
    ]
  },
  {
    id: 'general',
    label: 'General',
    group: 'App',
    sections: [
      {
        id: 'notifications',
        Component: NotificationsSection,
        keywords: ['alerts', 'desktop notifications', 'sound', 'bell']
      }
    ]
  },
  {
    id: 'appearance',
    label: 'Appearance',
    group: 'App',
    sections: [
      {
        id: 'appearance',
        Component: AppearanceSection,
        keywords: ['theme', 'dark mode', 'light mode', 'colors', 'visuals', 'html']
      }
    ]
  },
  {
    id: 'keyboard',
    label: 'Keyboard',
    group: 'App',
    sections: [
      {
        id: 'keyboard',
        Component: KeyboardSection,
        keywords: ['shortcuts', 'keybindings', 'hotkeys', 'keys', 'rebind']
      }
    ]
  },
  {
    id: 'permissions',
    label: 'Permissions',
    group: 'Security',
    sections: [
      {
        id: 'approval-mode',
        Component: ApprovalModeSection,
        keywords: ['approval policy', 'auto approve', 'full auto', 'yolo', 'plan mode', 'ask', 'confirm', 'default mode']
      },
      {
        id: 'web-reads',
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
        Component: SandboxEgressSection,
        keywords: ['network', 'internet', 'proxy', 'domains', 'firewall', 'allowlist', 'outbound'],
        values: (s) => [...(s.sandboxEgress?.allow ?? []), ...(s.sandboxEgress?.deny ?? [])]
      }
    ]
  },
  {
    id: 'about',
    label: 'About',
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

export const PAGE_GROUPS: PageGroup[] = ['AI', 'Workspace', 'App', 'Security', 'About']

/** The page that holds a given page id, falling back to the first. */
export function pageById(id: TabId): SettingsPage {
  return PAGES.find((p) => p.id === id) ?? PAGES[0]
}
