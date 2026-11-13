import { useEffect, useState } from 'react'
import type { AppSettings, EnvKeyOffer } from '@shared/types'
import { Icon } from './Icon'
import { ipcErrorMessage } from './ConnectModel'
import { SecureStorageNotice, secureStorageBlocked } from './SecureStorageNotice'

/**
 * Offers an API key found in the app's environment (ANTHROPIC_API_KEY,
 * OPENAI_API_KEY, GEMINI_API_KEY) for a provider with no stored key, once, at
 * startup. The desktop app never uses an environment key on its own, so the same
 * key otherwise has to be entered again here. "Use it" checks the key with the
 * provider and stores it in the secure store; "Not now" stops this notice asking
 * about that provider (the Connect panel still offers it). Only the provider, the
 * variable's name and the key's last four characters are ever shown.
 */
export function EnvKeyNotice({
  onImported
}: {
  /** Fresh settings once a key is stored, and which provider it was for. */
  onImported: (settings: AppSettings, providerId: string) => void
}): JSX.Element | null {
  const [offers, setOffers] = useState<EnvKeyOffer[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [storageBlocked, setStorageBlocked] = useState<string | null>(null)

  useEffect(() => {
    let live = true
    Promise.resolve()
      .then(() => window.api.getEnvKeyOffers('startup'))
      .then((o) => {
        if (live && Array.isArray(o)) setOffers(o)
      })
      .catch(() => {
        // Non-fatal: no offer rather than a broken banner.
      })
    return () => {
      live = false
    }
  }, [])

  // One provider at a time; the next shows once this one is answered.
  const offer = offers[0]
  if (!offer) return null

  const next = (): void => {
    setError(null)
    setStorageBlocked(null)
    setOffers((o) => o.slice(1))
  }

  const accept = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      const fresh = await window.api.importEnvKey(offer.providerId)
      onImported(fresh, offer.providerId)
      next()
    } catch (e) {
      const platform = await secureStorageBlocked()
      if (platform) setStorageBlocked(platform)
      else setError(`Couldn't use that key: ${ipcErrorMessage(e)}`)
    } finally {
      setBusy(false)
    }
  }

  const notNow = async (): Promise<void> => {
    setBusy(true)
    try {
      await window.api.dismissEnvKeyOffers([offer.providerId])
    } catch {
      // Still hide it for this session; it may ask again next launch.
    } finally {
      setBusy(false)
      next()
    }
  }

  return (
    <section className="rules-notice env-key-notice" role="region" aria-labelledby="env-key-notice-title">
      <span className="rules-notice__icon" aria-hidden="true">
        <Icon name="shield" size={16} />
      </span>
      <div className="rules-notice__body">
        <p className="rules-notice__title" id="env-key-notice-title">
          Use the {offer.providerLabel} key from your environment?
        </p>
        <p className="rules-notice__text">
          <code>{offer.envVar}</code> holds a key ending in <code>{offer.last4}</code>. Houston can check
          it and save it in this computer&rsquo;s secure store, so you don&rsquo;t have to enter it here.
          Nothing is saved unless you choose Use it.
        </p>
        {error && (
          <p className="rules-notice__error" role="alert">
            {error}
          </p>
        )}
        {storageBlocked && <SecureStorageNotice platform={storageBlocked} />}
        <div className="rules-notice__actions">
          <button type="button" className="btn btn--sm btn--accent" onClick={() => void accept()} disabled={busy}>
            {busy ? 'Checking…' : 'Use it'}
          </button>
          <button type="button" className="btn btn--sm" onClick={() => void notNow()} disabled={busy}>
            Not now
          </button>
        </div>
      </div>
    </section>
  )
}
