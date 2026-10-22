import type { AppSettings, ApprovalPolicy, SelectedModel } from '@shared/types'
import type { ConversationMeta, ReasoningEffort } from '@shared/agent'
import { DEFAULT_REASONING_EFFORT, reconcileSelectedModel } from '@shared/defaults'

/**
 * The settings one chat keeps for itself. The saved settings' `selected`,
 * `reasoningEffort` and `approvalPolicy` are only the defaults a new chat starts
 * from; once a chat exists, changing these changes that chat alone.
 */
export interface ChatSettings {
  selected: SelectedModel | null
  reasoningEffort: ReasoningEffort
  approvalPolicy: ApprovalPolicy
}

/** What a new chat starts with: the saved defaults. */
export function defaultChatSettings(saved: AppSettings): ChatSettings {
  return {
    selected: saved.selected,
    reasoningEffort: saved.reasoningEffort ?? DEFAULT_REASONING_EFFORT,
    approvalPolicy: saved.approvalPolicy
  }
}

/**
 * A chat's own settings, filled from the defaults where it has none (a chat from
 * before these were stored per chat). The chat's model is kept only while it still
 * exists in settings; otherwise it moves to another model of the same provider, or to
 * the default model, and `modelChanged` says so the user can be told.
 */
export function chatSettingsFor(
  conv: Pick<ConversationMeta, 'providerId' | 'model' | 'reasoningEffort' | 'approvalPolicy'>,
  saved: AppSettings
): { settings: ChatSettings; modelChanged: boolean } {
  const defaults = defaultChatSettings(saved)
  const own = conv.providerId && conv.model ? { providerId: conv.providerId, model: conv.model } : null
  const reconciled = reconcileSelectedModel(saved.providers, own)
  const selected = reconciled ?? defaults.selected
  const modelChanged =
    own !== null && (selected?.providerId !== own.providerId || selected?.model !== own.model)
  return {
    settings: {
      selected,
      reasoningEffort: conv.reasoningEffort ?? defaults.reasoningEffort,
      approvalPolicy: conv.approvalPolicy ?? defaults.approvalPolicy
    },
    modelChanged
  }
}

/**
 * The settings as the open chat sees them: the saved settings with the chat's own
 * model, reasoning effort and approval policy laid over them. For reading only;
 * never save the result, or one chat's values would become everyone's defaults.
 */
export function withChatSettings(saved: AppSettings, chat: ChatSettings | null): AppSettings {
  if (!chat) return saved
  return {
    ...saved,
    selected: chat.selected,
    reasoningEffort: chat.reasoningEffort,
    approvalPolicy: chat.approvalPolicy
  }
}

/** Whether a chat's settings differ from the defaults (offer "Use as default" only then). */
export function differsFromDefaults(chat: ChatSettings, saved: AppSettings): boolean {
  const d = defaultChatSettings(saved)
  return (
    chat.selected?.providerId !== d.selected?.providerId ||
    chat.selected?.model !== d.selected?.model ||
    chat.reasoningEffort !== d.reasoningEffort ||
    chat.approvalPolicy !== d.approvalPolicy
  )
}
