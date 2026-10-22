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
import { PermissionRulesSection } from './sections/permissions'
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
  KeyboardSection,
  LegalSection,
  NotificationsSection,
  UpdatesSection
} from './sections/app'

/** Settings pages shown in the left-hand nav. */
export type TabId = 'models' | 'tools' | 'workspace' | 'keyboard' | 'appearance' | 'updates' | 'legal'

export interface SettingsPage {
  id: TabId
  label: string
  /** The page's sections, top to bottom. */
  sections: SectionComponent[]
}

export const PAGES: SettingsPage[] = [
  {
    id: 'models',
    label: 'Models & Inference',
    sections: [
      ProvidersSection,
      AddProviderSection,
      SystemPromptSection,
      ContextWindowSection,
      LoopControlSection,
      ReasoningSection,
      WebSearchSection,
      ScorecardSection
    ]
  },
  {
    id: 'tools',
    label: 'Tools & Permissions',
    sections: [
      WebReadsSection,
      PermissionRulesSection,
      HooksSection,
      IntegrationsSection,
      LanguageServersSection,
      FormatOnSaveSection,
      DiagnosticsSection,
      McpServersSection
    ]
  },
  {
    id: 'workspace',
    label: 'Workspace',
    sections: [AdditionalFoldersSection, TrustedFoldersSection, SandboxEgressSection]
  },
  { id: 'keyboard', label: 'Keyboard', sections: [KeyboardSection] },
  { id: 'appearance', label: 'Appearance', sections: [AppearanceSection, NotificationsSection] },
  { id: 'updates', label: 'Updates', sections: [UpdatesSection] },
  { id: 'legal', label: 'Legal', sections: [LegalSection] }
]
