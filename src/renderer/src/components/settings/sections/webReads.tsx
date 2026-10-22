import { SettingsSection } from '../fields'
import type { SettingsCtx } from '../context'

/** Whether web_fetch and web_search ask before running in full auto. */
export function WebReadsSection({ ctx }: { ctx: SettingsCtx }): JSX.Element {
  const { settings, setSettings } = ctx
  return (
    <SettingsSection
      title="Web reads in full auto"
      desc={
        <>
          Whether <code>web_fetch</code> and <code>web_search</code> ask before running in full
          auto. A URL or search carrying a credential is refused either way, and other modes
          always ask.
        </>
      }
    >
      <label className="field">
        <span>Web reads</span>
        <select
          value={settings.webReads ?? 'ask'}
          onChange={(e) =>
            setSettings((s) => ({
              ...s,
              webReads: e.target.value === 'allow' ? 'allow' : 'ask'
            }))
          }
        >
          <option value="ask">Ask once per site</option>
          <option value="allow">Allow without asking</option>
        </select>
      </label>
    </SettingsSection>
  )
}
