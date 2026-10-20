import {
  checkDetail,
  checkGlyph,
  checkKindLabel,
  receiptHasFailure,
  receiptSummary,
  type ReceiptCheck,
  type TurnReceipt
} from '@shared/evidence'

/**
 * What Houston recorded running during a turn, under the turn's last message: one
 * summary line, expandable to each check and the files changed. Styled as Houston's
 * own row, not part of the model's markdown, because the point is that the model
 * didn't write it. Commands are model-written, so everything renders as plain text.
 */
export function Receipt({ receipt }: { receipt: TurnReceipt }): JSX.Element {
  const failed = receiptHasFailure(receipt)
  const moreFiles = receipt.filesChangedCount - receipt.filesChanged.length
  return (
    <details className={`receipt${failed ? ' receipt--failed' : ''}`}>
      <summary className="receipt__summary">
        <span className="receipt__by">Recorded by Houston</span>
        <span className="receipt__text">{receiptSummary(receipt)}</span>
      </summary>
      <div className="receipt__body">
        {receipt.checks.length > 0 && (
          <ul className="receipt__checks">
            {receipt.checks.map((c, i) => (
              <CheckRow key={i} check={c} />
            ))}
          </ul>
        )}
        {(receipt.checksOmitted ?? 0) > 0 && (
          <p className="receipt__note">
            Plus {receipt.checksOmitted} earlier check{receipt.checksOmitted === 1 ? '' : 's'}.
          </p>
        )}
        {receipt.otherCommands > 0 && (
          <p className="receipt__note">
            Plus {receipt.otherCommands} other command{receipt.otherCommands === 1 ? '' : 's'}.
          </p>
        )}
        {receipt.filesChanged.length > 0 && (
          <div className="receipt__files">
            <span className="receipt__label">Files changed</span>
            <ul>
              {receipt.filesChanged.map((f) => (
                <li key={f}>
                  <code>{f}</code>
                </li>
              ))}
            </ul>
            {moreFiles > 0 && <p className="receipt__note">And {moreFiles} more.</p>}
          </div>
        )}
      </div>
    </details>
  )
}

const OUTCOME = { ok: 'passed', failed: 'failed', unknown: 'outcome unknown' } as const

function CheckRow({ check }: { check: ReceiptCheck }): JSX.Element {
  const state = check.ok === true ? 'ok' : check.ok === false ? 'failed' : 'unknown'
  const detail = checkDetail(check)
  return (
    <li className={`receipt__check receipt__check--${state}`}>
      <span className="receipt__glyph" aria-hidden="true">
        {checkGlyph(check)}
      </span>
      <span className="sr-only">{OUTCOME[state]}: </span>
      <span className="receipt__kind">{checkKindLabel(check.kind)}</span>
      <code className="receipt__cmd">{check.label}</code>
      {detail && <span className="receipt__detail">{detail}</span>}
    </li>
  )
}
