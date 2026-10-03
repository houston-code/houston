import { useRef, useState } from 'react'
import type { ShareTarget } from '@shared/share'
import { Icon } from './Icon'
import { Popover } from './Popover'

/**
 * "Share Houston": one click shares the app with a friend. On macOS main opens a
 * native menu at the button: "Copy invite", then the system share services
 * (AirDrop, Messages, Mail, and any installed share extension). Windows/Linux have
 * no share menu, so main copies the invite and this button confirms it in a small
 * popover that also offers copy-again and email. See main/share.ts.
 *
 * `variant="rail"` is the icon-only form for the collapsed sidebar.
 */
export function ShareButton({ variant = 'full' }: { variant?: 'full' | 'rail' }): JSX.Element {
  const btnRef = useRef<HTMLButtonElement>(null)
  const [copiedOpen, setCopiedOpen] = useState(false)

  const share = async (): Promise<void> => {
    const r = btnRef.current?.getBoundingClientRect()
    const result = await window.api.shareHouston(r ? { x: r.left, y: r.bottom } : undefined)
    if (result === 'copied') setCopiedOpen(true)
  }

  const via = (target: ShareTarget): void => {
    void window.api.shareVia(target)
    setCopiedOpen(false)
  }

  return (
    <>
      {variant === 'rail' ? (
        <button
          ref={btnRef}
          className="sidebar__rail-btn"
          onClick={() => void share()}
          title="Share Houston"
          aria-label="Share Houston"
        >
          <Icon name="share" size={14} />
        </button>
      ) : (
        <button
          ref={btnRef}
          className="btn btn--sm btn--accent sidebar__share"
          onClick={() => void share()}
        >
          <Icon name="share" /> Share Houston
        </button>
      )}
      {copiedOpen && (
        <Popover
          anchorRef={btnRef}
          onClose={() => setCopiedOpen(false)}
          align="left"
          className="menu share-pop"
          role="menu"
          ariaLabel="Share Houston"
        >
          <div className="share-pop__status" role="status">
            <Icon name="check" /> Invite copied. Paste it to a friend.
          </div>
          <button role="menuitem" className="menu__item" onClick={() => via('copy')}>
            <Icon name="copy" /> Copy invite
          </button>
          <button role="menuitem" className="menu__item" onClick={() => via('email')}>
            <Icon name="mail" /> Send by email
          </button>
        </Popover>
      )}
    </>
  )
}
