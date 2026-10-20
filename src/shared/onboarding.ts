/**
 * First-run onboarding for the desktop app: a get-started checklist on the welcome
 * screen, and one-shot coachmarks ("tips") pinned to real controls the first time
 * each one matters. Pure logic only, so the rules are testable without a renderer;
 * the components live in src/renderer/src/components/{GetStarted,ConnectModel,Coachmark}.
 */

/** Coachmarks in tour order. Each is anchored to an element carrying `data-tour="<id>"`. */
export const TIP_IDS = ['approval', 'worktree', 'context', 'steer', 'changes', 'revert'] as const

export type TipId = (typeof TIP_IDS)[number]

/** Persisted onboarding progress (AppSettings.onboarding). Absent = a fresh install. */
export interface OnboardingState {
  /** The checklist was finished or skipped; it never shows again. */
  checklistDone?: boolean
  /** Tips already shown and dismissed. Unknown ids are ignored. */
  seenTips?: string[]
}

/**
 * Onboarding state seeded into an install that existed before onboarding shipped
 * (the settings migration). They already know their way around, so nothing appears
 * on its own: every tip is marked seen. The release's "What's new" notes point them
 * at the command palette's "Take the tour" if they want it.
 */
export function existingInstallOnboarding(): OnboardingState {
  return { seenTips: [...TIP_IDS] }
}

/** What the checklist reads off the app's real state. */
export interface ChecklistFacts {
  /** A model is selected and its provider is usable (key stored, or keyless/local). */
  modelReady: boolean
  /** A project folder is open. */
  hasWorkspace: boolean
  /** At least one conversation exists, i.e. a task has been sent. */
  hasConversation: boolean
}

export type ChecklistStep = 'model' | 'folder' | 'task'

export interface ChecklistView {
  done: Record<ChecklistStep, boolean>
  completed: number
  /** The first step not yet done, or null when all are. */
  current: ChecklistStep | null
}

export function checklistView(f: ChecklistFacts): ChecklistView {
  const done = { model: f.modelReady, folder: f.hasWorkspace, task: f.hasConversation }
  const order: ChecklistStep[] = ['model', 'folder', 'task']
  return {
    done,
    completed: order.filter((s) => done[s]).length,
    current: order.find((s) => !done[s]) ?? null
  }
}

/**
 * Whether the checklist belongs on the welcome screen. Anyone who has sent a task
 * has finished onboarding, so an existing conversation hides it even before the
 * `checklistDone` latch is persisted.
 */
export function shouldShowChecklist(state: OnboardingState | undefined, f: ChecklistFacts): boolean {
  return !state?.checklistDone && !f.hasConversation
}

/**
 * Whether the welcome screen shows the checklist. Never until conversations have
 * loaded: before then "no conversations" isn't known yet, and an existing user would
 * see the checklist flash.
 */
export function checklistVisible(
  state: OnboardingState | undefined,
  f: ChecklistFacts,
  conversationsLoaded: boolean
): boolean {
  return conversationsLoaded && shouldShowChecklist(state, f)
}

export function markTipsSeen(state: OnboardingState | undefined, ids: readonly TipId[]): OnboardingState {
  const seen = new Set(state?.seenTips ?? [])
  for (const id of ids) seen.add(id)
  return { ...state, seenTips: TIP_IDS.filter((id) => seen.has(id)) }
}

/** Replay every tip ("Take the tour" in the command palette). */
export function restartTips(state: OnboardingState | undefined): OnboardingState {
  return { ...state, seenTips: [] }
}

/** When each tip is relevant, as read off the app's state. */
export interface TipContext {
  /** An empty new chat, ready to send (model and folder set, nothing running). */
  readyToSend: boolean
  /** The last turn edited files and the run has finished. */
  afterEdit: boolean
  /** The user asked for the tour: every tip whose control is on screen is relevant. */
  touring: boolean
}

/** Tips relevant right now, in display order. */
export function relevantTips(ctx: TipContext): TipId[] {
  if (ctx.touring) return [...TIP_IDS]
  const out: TipId[] = []
  // Steer isn't here: mid-run, the message box's placeholder already says how Enter
  // and Mod+Enter behave, so its tip shows only in a requested tour.
  if (ctx.readyToSend) out.push('approval', 'worktree', 'context')
  if (ctx.afterEdit) out.push('revert', 'changes')
  return out
}

export interface PickedTip {
  id: TipId
  /** 1-based position among this run of tips, and the run's length, for "1 of 2". */
  index: number
  total: number
  /** Another tip follows in this run (label the button "Next" rather than "Got it"). */
  hasNext: boolean
}

/**
 * The tip to show now: the first relevant, unseen one whose anchor is on screen.
 * `present` reports whether a tip's anchor element exists, so a tip for a control
 * that isn't rendered (no worktree toggle outside a git repo) is skipped, not shown
 * pointing at nothing. `dismissedThisRun` lists tips already stepped through in the
 * current run so the counter reads "2 of 2" rather than restarting at 1.
 */
export function pickTip(
  relevant: readonly TipId[],
  seen: readonly string[] | undefined,
  present: (id: TipId) => boolean,
  dismissedThisRun: readonly TipId[] = []
): PickedTip | null {
  const seenSet = new Set(seen ?? [])
  const run = relevant.filter((id) => !seenSet.has(id) && present(id))
  if (run.length === 0) return null
  const before = dismissedThisRun.filter((id) => relevant.includes(id)).length
  return { id: run[0], index: before + 1, total: before + run.length, hasNext: run.length > 1 }
}

/** What's in the open folder, for picking step 3's example task. */
export type FolderKind = 'empty' | 'has-files' | 'unknown'

/**
 * Classify a folder from its top-level listing: empty when nothing but hidden
 * entries (`.git`, `.DS_Store`) is there. `null` (couldn't list it) is unknown.
 */
export function folderKind(entries: readonly { name: string }[] | null): FolderKind {
  if (!entries) return 'unknown'
  return entries.some((e) => !e.name.startsWith('.')) ? 'has-files' : 'empty'
}

/**
 * Step 3's example task, picked to be useful for this folder: an empty folder gets
 * something to build (small, quick, no installs, and it produces edits, so the
 * Changes and Revert tips follow); a project gets a read-only first look.
 */
export function firstTaskExample(kind: FolderKind): string {
  switch (kind) {
    case 'empty':
      return 'Build a simple to-do list web page in this folder.'
    case 'has-files':
      return 'Explain how this project is organized.'
    case 'unknown':
      return 'Look around this folder and suggest a good first task.'
  }
}

/** How long the pre-send tips wait after step 3 becomes current: a follow-up, not a jolt. */
export const PRE_SEND_TIP_DELAY_MS = 2000
