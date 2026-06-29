import { useRef } from 'react'
import { useFocusTrap } from '../lib/useFocusTrap'
import { LICENSE_URL, PRIVACY_URL, TERMS_URL } from '@shared/legal'

/**
 * Blocking first-run gate: the user must accept the Terms of Use, Privacy Policy,
 * and License before using Houston. Unlike other modals it cannot be dismissed —
 * Escape and backdrop clicks do nothing; the only way forward is to accept, and
 * the only way out is to quit. Shown again after the legal terms version bumps.
 *
 * The key disclaimers are stated inline so they have effect even offline; the
 * links open the full documents in the browser.
 */
export function LegalGate({ onAccept }: { onAccept: () => void }): JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  // Pass a no-op so the focus trap keeps focus inside but Escape can't dismiss.
  useFocusTrap(ref, () => {})

  return (
    <div className="modal-backdrop legal-gate__backdrop">
      <div
        className="modal modal--md"
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-labelledby="legal-gate-title"
        tabIndex={-1}
      >
        <div className="modal__head">
          <h2 id="legal-gate-title">Before you use Houston</h2>
        </div>
        <div className="modal__body legal-gate__body">
          <p>
            Houston is a coding agent that can read, edit, delete, and run files and
            commands on your device, and connect to AI models and other services that
            you choose. Please read and accept the terms below before continuing.
          </p>
          <ul className="legal-gate__points">
            <li>
              <strong>As-is, no warranty.</strong> Houston is provided “as is”, without
              warranties of any kind. You use it at your own risk.
            </li>
            <li>
              <strong>No liability.</strong> To the maximum extent permitted by law, the
              publisher is not liable for any damages — including lost, deleted, or
              corrupted files or code, or harm from commands the agent runs.
            </li>
            <li>
              <strong>You are responsible.</strong> You must review and approve the agent’s
              actions, keep backups and use version control, and control what you point
              Houston at.
            </li>
            <li>
              <strong>Your data &amp; your providers.</strong> Houston stores your data
              locally and collects no telemetry. Your prompts, code, and files are sent
              only to the model and other providers you configure, under{' '}
              <em>their</em> terms, privacy policies, and model-training practices — not
              the publisher’s.
            </li>
            <li>
              <strong>Data residency is your call.</strong> Because you choose your
              providers and regions, it is your responsibility to meet any data-residency
              and data-protection obligations that apply to you.
            </li>
          </ul>
          <p className="legal-gate__links">
            Full terms:{' '}
            <a href={TERMS_URL} target="_blank" rel="noreferrer">
              Terms of Use
            </a>
            {' · '}
            <a href={PRIVACY_URL} target="_blank" rel="noreferrer">
              Privacy Policy
            </a>
            {' · '}
            <a href={LICENSE_URL} target="_blank" rel="noreferrer">
              License
            </a>
          </p>
          <p className="legal-gate__consent">
            By selecting “I Agree”, you confirm that you have read and accept the Terms
            of Use, Privacy Policy, and License.
          </p>
        </div>
        <div className="modal__foot">
          <button className="btn" onClick={() => window.close()}>
            Quit
          </button>
          <button className="btn btn--accent" onClick={onAccept}>
            I Agree
          </button>
        </div>
      </div>
    </div>
  )
}
