import { useRef } from 'react'
import { useFocusTrap } from '../lib/useFocusTrap'
import { LICENSE_URL, PRIVACY_URL, TERMS_URL } from '@shared/legal'

/**
 * Blocking legal-acceptance gate: the user must accept the Terms of Use and the
 * Privacy Policy before using Houston. Unlike other modals it cannot be
 * dismissed — Escape and backdrop clicks do nothing; the only way forward is to
 * accept, and the only way out is to quit.
 *
 * The Apache-2.0 LICENSE is linked but deliberately not something to accept; see
 * the note in @shared/legal.
 *
 * Shown on first run, and again whenever LEGAL_VERSION bumps (see @shared/legal).
 * `isUpdate` distinguishes a returning user being re-prompted after a terms change
 * from a fresh first-run acceptance, so the copy reads correctly in both cases.
 *
 * The key disclaimers are stated inline so they have effect even offline; the
 * links open the full documents in the browser.
 */
export function LegalGate({
  onAccept,
  isUpdate = false
}: {
  onAccept: () => void
  isUpdate?: boolean
}): JSX.Element {
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
          <h2 id="legal-gate-title">
            {isUpdate ? 'Houston’s terms have been updated' : 'Before you use Houston'}
          </h2>
        </div>
        <div className="modal__body legal-gate__body">
          <p>
            {isUpdate
              ? 'We’ve updated Houston’s Terms of Use and Privacy Policy. Please review and accept the updated terms to continue.'
              : 'Houston is a coding agent that can read, edit, delete, and run files and commands on your device, and connect to AI models and other services that you choose. Please read and accept the terms below before continuing.'}
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
          </p>
          <p className="legal-gate__consent">
            By selecting “I Agree”, you confirm that you have read and accept the Terms
            of Use and the Privacy Policy. Houston itself is open source under the{' '}
            <a href={LICENSE_URL} target="_blank" rel="noreferrer">
              Apache License 2.0
            </a>
            , which grants you rights rather than asking anything of you.
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
