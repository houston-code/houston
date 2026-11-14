import type { ProviderConfig } from '@shared/types'
import { SMALL_MODEL_SAME_AS_CHAT, automaticSmallModel } from '@shared/smallModel'

/** The select's value for "Automatic" (no `smallModel` stored). */
const AUTOMATIC = '__automatic__'

/**
 * Which model a provider's side requests use: chat titles, compaction summaries,
 * next-message suggestions, and reading flagged web pages. `undefined` from
 * `onChange` means "Automatic" (the setting is removed).
 */
export function SmallModelField({
  provider,
  onChange
}: {
  provider: ProviderConfig
  onChange: (smallModel: string | undefined) => void
}): JSX.Element {
  const auto = automaticSmallModel(provider)
  const value =
    provider.smallModel === undefined
      ? AUTOMATIC
      : provider.smallModel === SMALL_MODEL_SAME_AS_CHAT
        ? SMALL_MODEL_SAME_AS_CHAT
        : provider.smallModel
  const listed = provider.models.map((m) => m.id)
  // Keep a stored id selectable even after it left the model list.
  const ids = provider.smallModel && !listed.includes(provider.smallModel) ? [...listed, provider.smallModel] : listed
  return (
    <label className="field">
      <span>
        Model for side tasks: chat titles, conversation summaries, suggested next messages,
        and reading web pages flagged as possible prompt injection. If it fails, the
        chat&apos;s own model takes over.
      </span>
      <select
        aria-label={`Model for side tasks (${provider.label})`}
        value={value}
        onChange={(e) => onChange(e.target.value === AUTOMATIC ? undefined : e.target.value)}
      >
        <option value={AUTOMATIC}>{auto ? `Automatic (${auto})` : "Automatic (the chat's model)"}</option>
        <option value={SMALL_MODEL_SAME_AS_CHAT}>The chat&apos;s model</option>
        {ids.map((id) => (
          <option key={id} value={id}>
            {id}
          </option>
        ))}
      </select>
    </label>
  )
}
