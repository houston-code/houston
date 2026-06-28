import type { Provider } from '@shared/agent'
import { runSubAgent, type SubAgentOptions } from './subagent'
import { gitDiff, isSafeGitRef, type GitExec, type WorkspaceDiff } from './git'

/**
 * Adversarial, multi-agent review of a change. The motivation
 * is that a reviewer sharing the author's context inherits the author's blind
 * spots, so each reviewer runs in a *fresh, separate context* (its own subagent
 * loop) and is told to look for problems, not to praise the change. We review
 * across three independent dimensions in parallel, then run a skeptical
 * verification pass — also in a fresh context — that re-checks every candidate
 * finding against the real code and drops the false positives. Everything here is
 * read-only (the subagents can only read/list/glob/search), so a review needs no
 * approvals and can't change anything: the parent agent fixes what it confirms.
 */

export const REVIEW_DIMENSIONS = ['correctness', 'security', 'quality'] as const
export type ReviewDimension = (typeof REVIEW_DIMENSIONS)[number]

/**
 * Verification depth. `normal` runs a single verifier over all candidate findings
 * (fast, cheap). `high` verifies each finding independently with several skeptics
 * and keeps only the majority-confirmed ones (more thorough, more model calls) —
 * diversity catches false positives one verifier, anchored on the candidate list,
 * can miss.
 */
export const REVIEW_EFFORTS = ['normal', 'high'] as const
export type ReviewEffort = (typeof REVIEW_EFFORTS)[number]

/** Cap the diff embedded in each prompt; reviewers read the files for the rest. */
const MAX_DIFF_CHARS = 50_000

/** Independent skeptics per finding, and the confirmations needed, in high effort. */
const VOTES_PER_FINDING = 3
const VOTES_TO_CONFIRM = 2
/** Bound the high-effort fan-out so a huge finding list can't spawn unbounded calls. */
const MAX_VERIFIED_FINDINGS = 20

const DIMENSION_FOCUS: Record<ReviewDimension, string> = {
  correctness:
    'logic errors, off-by-one mistakes, inverted or wrong conditions, unhandled edge cases (null/undefined/empty/error paths), broken invariants, incorrect API or library usage, race conditions, resource leaks, and regressions in existing behavior',
  security:
    'injection (command, SQL, path traversal), SSRF and unsafe outbound requests, missing authentication/authorization checks, secret or credential leakage, unsafe deserialization, missing input validation at trust boundaries, unsafe file permissions, and the rest of the OWASP top 10',
  quality:
    'unnecessary complexity, logic duplicated instead of reusing existing helpers, dead or unreachable code, poor or inconsistent naming, weak error handling, and missing test coverage for new logic — judged against the conventions of the surrounding code'
}

/** The adversarial system prompt for a single-dimension reviewer. */
export function reviewerSystem(dimension: ReviewDimension): string {
  return `You are a meticulous, adversarial code reviewer focused on ${dimension.toUpperCase()}. Another agent just made a change and you are reviewing it in a fresh context. Your job is to find real problems, not to praise the change — assume it is guilty until proven innocent, but only report problems you can point to in the actual code.

Look specifically for: ${DIMENSION_FOCUS[dimension]}.

The change is given as a diff, but a diff lacks surrounding context — read the actual files (read_file, search_files, glob, list_dir) to confirm each suspicion before reporting it. A finding you cannot ground in the real code is noise; leave it out.

Report each finding as its own block:
- [SEVERITY: critical|high|medium|low] path:line — one-line problem statement
  Why it's a real problem: ...
  Suggested fix: ...

List the most severe findings first. If you find no real ${dimension} problems, reply with exactly: No issues found.`
}

/** The user turn handed to a single-dimension reviewer. */
export function reviewerPrompt(dimension: ReviewDimension, diff: string): string {
  return `Review the following change for ${dimension} issues only. Read the real files for context before judging.

${diff}`
}

/** The adversarial system prompt for the verification pass. */
export function verifierSystem(): string {
  return `You are a skeptical verification reviewer working in a fresh context. You are given a change (as a diff) and a list of CANDIDATE findings raised by other reviewers. Many candidates are false positives — wrong, already handled elsewhere in the code, not actually reachable, or based on a misreading of the diff without its surrounding context.

For EACH candidate, independently verify it against the actual code (read the files) and decide CONFIRMED or REJECTED. Reject anything you cannot reproduce or are unsure about — a false alarm wastes the author's time, so when in doubt, drop it. When several candidates describe the same underlying problem (same file, line, and root cause — reviewers of different dimensions often overlap), merge them into a single finding rather than repeating it.

Output only the CONFIRMED findings, most severe first, each as:
- [SEVERITY] path:line — problem statement
  Fix: ...
  Verified: how you confirmed it against the code.

End with a one-line tally: "Confirmed N of M candidate findings." If none survive, reply with exactly: No confirmed issues.`
}

/** The user turn handed to the verifier. */
export function verifierPrompt(diff: string, candidates: string): string {
  return `Change under review:

${diff}

Candidate findings to verify:

${candidates}`
}

/** The system prompt for a single-finding skeptic (high-effort verification). */
export function skepticSystem(): string {
  return `You are a skeptical verifier checking ONE candidate finding from a code review, in a fresh context. Decide whether it describes a real, reproducible problem in the actual code — not a misreading, not something already handled elsewhere, not a hypothetical.

Read the referenced files (read_file, search_files, glob, list_dir) to check; do not trust the finding's wording. Be conservative: if you cannot reproduce the problem or are unsure, REJECT — a false alarm wastes the author's time.

Reply with CONFIRMED or REJECTED as the very first word, then one sentence of justification.`
}

/** The user turn handed to a single-finding skeptic. */
export function skepticPrompt(finding: string): string {
  return `Candidate finding:

${finding}

Verify it against the actual code in the project, then answer CONFIRMED or REJECTED.`
}

/**
 * Compose the review input from a workspace diff: the (size-capped) tracked diff
 * plus a list of new untracked files for the reviewer to read in full. Returns ''
 * when there is nothing to review. Pure.
 */
export function formatReviewInput(d: WorkspaceDiff): string {
  const parts: string[] = []
  if (d.diff) {
    const body =
      d.diff.length > MAX_DIFF_CHARS
        ? `${d.diff.slice(0, MAX_DIFF_CHARS)}\n[diff truncated at ${MAX_DIFF_CHARS} chars — read the files directly for the rest]`
        : d.diff
    parts.push(`Diff of changes to tracked files (git diff):\n\n${body}`)
  }
  if (d.untracked.length) {
    const list = d.untracked.map((f) => `- ${f}`).join('\n')
    parts.push(`New (untracked) files — read them in full to review their contents:\n${list}`)
  }
  return parts.join('\n\n')
}

/** runSubAgent wraps provider failures, aborts, and step-limit hits in bracketed notes. */
function isErrorReport(report: string): boolean {
  return report.trim() === '' || /^\s*\[subagent (error|aborted|reached)/i.test(report)
}

/** A reviewer that found nothing replies with exactly this phrase. */
function isClean(report: string): boolean {
  return /^\s*no issues found\.?\s*$/i.test(report)
}

const SEVERITY_RANK: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3 }

/** A single candidate finding split out of the reviewers' reports. */
export interface ParsedFinding {
  dimension: string
  severity: string
  /** The finding's full text block (bullet + its continuation lines). */
  text: string
}

/** Lowest severity rank is most severe; unknown severities sort last. */
function severityOf(text: string): string {
  const m = text.match(/\[(?:severity:\s*)?(critical|high|medium|low)/i)
  return m ? m[1].toLowerCase() : 'low'
}

/**
 * Split the concatenated reviewer reports into individual findings. A finding
 * starts at a `- [SEVERITY...]` bullet and runs until the next bullet or the next
 * `### <dimension> findings` header. Tolerant: returns [] when nothing parses,
 * which the caller treats as a signal to fall back to whole-report verification.
 */
export function parseFindings(candidateText: string): ParsedFinding[] {
  const findings: ParsedFinding[] = []
  let dimension = 'review'
  let current: string[] | null = null
  const flush = (): void => {
    if (current) {
      const text = current.join('\n').trim()
      if (text) findings.push({ dimension, severity: severityOf(text), text })
    }
    current = null
  }
  for (const line of candidateText.split('\n')) {
    const header = line.match(/^###\s+(\w+)\s+findings/i)
    if (header) {
      flush()
      dimension = header[1].toLowerCase()
    } else if (/^\s*-\s*\[/.test(line)) {
      flush()
      current = [line]
    } else if (current) {
      current.push(line)
    }
  }
  flush()
  return findings
}

/** A skeptic confirms a finding only when its reply opens with CONFIRMED. */
function isConfirmed(verdict: string): boolean {
  const firstLine = verdict.split('\n').map((l) => l.trim()).find(Boolean) ?? ''
  return /^confirmed\b/i.test(firstLine)
}

/**
 * A review path filter must be a relative path that stays inside the workspace —
 * no absolute paths and no `..` segments climbing out. (git pathspecs after `--`
 * are already safe from option injection; this guards against escaping the repo.)
 */
export function isSafeReviewPath(p: string): boolean {
  if (typeof p !== 'string' || p.trim() === '') return false
  if (p.startsWith('/') || /^[A-Za-z]:[\\/]/.test(p)) return false // absolute (incl. Windows)
  return !p.split(/[\\/]/).includes('..')
}

export interface RunReviewOptions {
  provider: Provider
  model: string
  workspace: string
  /** The composed review input (see formatReviewInput). */
  diff: string
  signal: AbortSignal
  /** Override the dimensions to review (default: all three). */
  dimensions?: readonly ReviewDimension[]
  /** Verification depth (default 'normal'). 'high' verifies each finding by vote. */
  effort?: ReviewEffort
  /** Injected for tests; defaults to the real read-only subagent runner. */
  runAgent?: (opts: SubAgentOptions) => Promise<string>
}

/**
 * Run the review: fan out one read-only reviewer per dimension (parallel, each in
 * its own fresh context), then verify the surviving candidate findings — with a
 * single skeptic over the whole list ('normal') or several independent skeptics
 * per finding, majority-confirmed ('high'). Returns a single report for the parent
 * agent. Never throws — reviewer failures surface as notes, not an aborted review.
 */
export async function runReview(opts: RunReviewOptions): Promise<string> {
  const { provider, model, workspace, diff, signal } = opts
  const runAgent = opts.runAgent ?? runSubAgent
  const dimensions = opts.dimensions ?? REVIEW_DIMENSIONS

  if (!diff.trim()) return 'No changes to review.'
  if (signal.aborted) return '[review aborted]'

  const reports = await Promise.all(
    dimensions.map(async (dimension) => {
      const report = await runAgent({
        provider,
        model,
        workspace,
        signal,
        prompt: reviewerPrompt(dimension, diff),
        systemOverride: reviewerSystem(dimension)
      })
      return { dimension, report: report.trim() }
    })
  )

  if (signal.aborted) return '[review aborted]'

  const notes = reports
    .filter((r) => isErrorReport(r.report))
    .map((r) => `⚠ The ${r.dimension} review could not complete: ${r.report || 'no output'}.`)
  const candidates = reports.filter((r) => !isErrorReport(r.report) && !isClean(r.report))

  if (candidates.length === 0) {
    const clean = `Review complete — no issues found across ${dimensions.join(', ')}.`
    return notes.length ? `${clean}\n\n${notes.join('\n')}` : clean
  }

  const candidateText = candidates.map((c) => `### ${c.dimension} findings\n${c.report}`).join('\n\n')
  const footer =
    'Once you have addressed the confirmed findings, run review_changes again to confirm the fixes and surface anything the changes introduced.'
  const dims = dimensions.join(', ')

  // High effort: verify each finding independently by majority vote of skeptics.
  // Falls back to the single-verifier path if the reports don't parse into findings.
  if ((opts.effort ?? 'normal') === 'high') {
    const findings = parseFindings(candidateText)
    if (findings.length > 0) {
      const toVerify = findings.slice(0, MAX_VERIFIED_FINDINGS)
      if (findings.length > toVerify.length) {
        notes.push(
          `⚠ ${findings.length} candidate findings exceeded the per-review verification cap; verified the first ${toVerify.length}.`
        )
      }
      const verdicts = await Promise.all(
        toVerify.map(async (f) => {
          const votes = await Promise.all(
            Array.from({ length: VOTES_PER_FINDING }, () =>
              runAgent({
                provider,
                model,
                workspace,
                signal,
                prompt: skepticPrompt(f.text),
                systemOverride: skepticSystem()
              })
            )
          )
          return { finding: f, confirms: votes.filter(isConfirmed).length }
        })
      )
      if (signal.aborted) return '[review aborted]'

      const confirmed = verdicts
        .filter((v) => v.confirms >= VOTES_TO_CONFIRM)
        .map((v) => v.finding)
        .sort((a, b) => (SEVERITY_RANK[a.severity] ?? 9) - (SEVERITY_RANK[b.severity] ?? 9))
      const tally = `Confirmed ${confirmed.length} of ${toVerify.length} candidate findings (each checked by ${VOTES_PER_FINDING} independent verifiers).`

      if (confirmed.length === 0) {
        const clean = `Adversarial review (${dims}) — no findings survived independent verification. ${tally}`
        return [clean, ...notes].join('\n\n')
      }
      const header = `Adversarial review of the current changes (${dims}), each finding independently verified by ${VOTES_PER_FINDING} skeptics:`
      const list = confirmed.map((f) => f.text).join('\n\n')
      return [header, list, tally, ...notes, footer].join('\n\n')
    }
    // else: nothing parsed — fall through to the single-verifier path below.
  }

  const verified = await runAgent({
    provider,
    model,
    workspace,
    signal,
    prompt: verifierPrompt(diff, candidateText),
    systemOverride: verifierSystem()
  })

  const header = `Adversarial review of the current changes (${dims}), each candidate finding verified in a separate context:`
  const body = verified.trim() || '[verifier returned no output]'
  return [header, body, ...notes, footer].join('\n\n')
}

export interface ReviewWorkspaceOptions {
  provider: Provider
  model: string
  workspace: string
  /** Git ref to diff against (default HEAD — all uncommitted changes). */
  base?: string
  /** Optional pathspec: limit the review to these workspace-relative paths. */
  paths?: string[]
  /** Verification depth (default 'normal'). 'high' verifies each finding by vote. */
  effort?: ReviewEffort
  signal: AbortSignal
  /** Injected for tests. */
  gitExec?: GitExec
  runAgent?: (opts: SubAgentOptions) => Promise<string>
}

/**
 * Compute the workspace's uncommitted diff and review it. This is the entry point
 * the agent loop wires into the review_changes tool (the loop supplies the
 * provider/model). Handles the not-a-repo and nothing-to-review cases with a
 * helpful message instead of an empty review.
 */
export async function reviewWorkspaceChanges(opts: ReviewWorkspaceOptions): Promise<string> {
  const base = opts.base || 'HEAD'
  if (!isSafeGitRef(base)) {
    return `Invalid base ref "${base}". Use a branch name, tag, or commit SHA (no leading dash or shell characters).`
  }
  const paths = opts.paths ?? []
  const badPath = paths.find((p) => !isSafeReviewPath(p))
  if (badPath !== undefined) {
    return `Invalid review path "${badPath}". Use project-relative paths inside the workspace (no absolute paths or "..").`
  }
  const d = await gitDiff(opts.workspace, base, paths, opts.gitExec)
  if (!d.isRepo) {
    return 'Cannot review: this project is not a git repository, so there is no diff to review. Commit your work in a git repo to use review_changes, or ask me to review specific files directly.'
  }
  const input = formatReviewInput(d)
  if (!input.trim()) {
    const against = base !== 'HEAD' ? ` against ${base}` : ''
    const scope = paths.length ? ` in ${paths.join(', ')}` : ''
    return `No uncommitted changes to review${scope}${against}.`
  }
  return runReview({
    provider: opts.provider,
    model: opts.model,
    workspace: opts.workspace,
    diff: input,
    effort: opts.effort,
    signal: opts.signal,
    runAgent: opts.runAgent
  })
}
