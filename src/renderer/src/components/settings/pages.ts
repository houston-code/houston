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

export interface SettingsPage {
  id: TabId
  label: string
  group: PageGroup
  /** The page's sections, top to bottom. */
  sections: SectionComponent[]
}

export const PAGES: SettingsPage[] = [
  {
    id: 'models',
    label: 'Providers & Models',
    group: 'AI',
    sections: [ProvidersSection, AddProviderSection, ScorecardSection]
  },
  {
    id: 'agent',
    label: 'Agent Behavior',
    group: 'AI',
    sections: [SystemPromptSection, ContextWindowSection, LoopControlSection, ReasoningSection]
  },
  {
    id: 'tools',
    label: 'Tools',
    group: 'AI',
    sections: [
      WebSearchSection,
      IntegrationsSection,
      LanguageServersSection,
      FormatOnSaveSection,
      DiagnosticsSection
    ]
  },
  { id: 'mcp', label: 'MCP Servers', group: 'AI', sections: [McpServersSection] },
  { id: 'hooks', label: 'Hooks', group: 'AI', sections: [HooksSection] },
  { id: 'workspace', label: 'Workspace', group: 'Workspace', sections: [AdditionalFoldersSection] },
  { id: 'general', label: 'General', group: 'App', sections: [NotificationsSection] },
  { id: 'appearance', label: 'Appearance', group: 'App', sections: [AppearanceSection] },
  { id: 'keyboard', label: 'Keyboard', group: 'App', sections: [KeyboardSection] },
  {
    id: 'permissions',
    label: 'Permissions',
    group: 'Security',
    sections: [ApprovalModeSection, WebReadsSection, PermissionRulesSection, TrustedFoldersSection, SandboxEgressSection]
  },
  {
    id: 'about',
    label: 'About',
    group: 'About',
    sections: [UpdatesSection, DiagnosticsCheckSection, LegalSection]
  }
]

export const PAGE_GROUPS: PageGroup[] = ['AI', 'Workspace', 'App', 'Security', 'About']

/** The page that holds a given page id, falling back to the first. */
export function pageById(id: TabId): SettingsPage {
  return PAGES.find((p) => p.id === id) ?? PAGES[0]
}
