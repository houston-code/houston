import {
  checkDetail,
  checkGlyph,
  checkKindLabel,
  planCheckText,
  receiptHasFailure,
  receiptSummary,
  RECEIPT_TITLE,
  type PlanProgress,
  type ReceiptCheck,
  type TurnReceipt
} from '@shared/evidence'
import { describeShell } from '../lib/taskLabel'

/**
 * What ran during a turn, under the turn's last message: one
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
        <span className="receipt__by">{RECEIPT_TITLE}</span>
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
        {receipt.plan && !receipt.plan.complete && <PlanSection plan={receipt.plan} />}
        {receipt.todoGaps && receipt.todoGaps.length > 0 && (
          <div className="receipt__gaps">
            <span className="receipt__label">Marked done with nothing recorded</span>
            <ul>
              {receipt.todoGaps.map((g, i) => (
                <li key={i}>{g}</li>
              ))}
            </ul>
          </div>
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
  // The command minus its `cd /abs/path &&` and `2>&1` scaffolding, on one line; the
  // full command is on hover.
  const short = describeShell(check.label).label
  return (
    <li className={`receipt__check receipt__check--${state}`}>
      <span className="receipt__glyph" aria-hidden="true">
        {checkGlyph(check)}
      </span>
      <span className="sr-only">{OUTCOME[state]}: </span>
      <span className="receipt__kind">{checkKindLabel(check.kind)}</span>
      <code className="receipt__cmd" title={check.label}>
        {short}
      </code>
      {detail && (
        <span className="receipt__detail" title={detail}>
          {detail}
        </span>
      )}
    </li>
  )
}

/** The accepted plan's checks and the files it named that no turn has changed yet. */
function PlanSection({ plan }: { plan: PlanProgress }): JSX.Element {
  const moreFiles = plan.filesPendingCount - plan.filesPending.length
  return (
    <div className="receipt__plan">
      <span className="receipt__label">Plan: {plan.title}</span>
      {plan.checks.length > 0 && (
        <ul className="receipt__checks">
          {plan.checks.map((c, i) => {
            const state = c.status === 'passed' ? 'ok' : c.status === 'failed' ? 'failed' : 'unknown'
            return (
              <li key={i} className={`receipt__check receipt__check--${state}`}>
                <span className="receipt__glyph" aria-hidden="true">
                  {state === 'ok' ? '✓' : state === 'failed' ? '✗' : '○'}
                </span>
                <span>{c.step}</span>
                <span className="receipt__detail">{planCheckText(c)}</span>
              </li>
            )
          })}
        </ul>
      )}
      {plan.filesPendingCount > 0 && (
        <p className="receipt__note">
          Files not changed yet: {plan.filesPending.join(', ')}
          {moreFiles > 0 ? `, and ${moreFiles} more` : ''}.
        </p>
      )}
    </div>
  )
}
