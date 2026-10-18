import { describe, expect, it } from 'vitest'
import {
  TIP_IDS,
  checklistView,
  existingInstallOnboarding,
  markTipsSeen,
  onboardingSurfaces,
  pickTip,
  relevantTips,
  restartTips,
  shouldShowChecklist,
  shouldShowTourInvite,
  type ChecklistFacts,
  type TipId
} from './onboarding'

const facts = (over: Partial<ChecklistFacts> = {}): ChecklistFacts => ({
  modelReady: false,
  hasWorkspace: false,
  hasConversation: false,
  ...over
})

const all = (): boolean => true

describe('checklistView', () => {
  it('starts at the model step with nothing done', () => {
    const v = checklistView(facts())
    expect(v.completed).toBe(0)
    expect(v.current).toBe('model')
  })

  it('moves the current step to the first one not done, in order', () => {
    expect(checklistView(facts({ modelReady: true })).current).toBe('folder')
    expect(checklistView(facts({ modelReady: true, hasWorkspace: true })).current).toBe('task')
    // A folder opened before a model is connected still leaves the model step current.
    const v = checklistView(facts({ hasWorkspace: true }))
    expect(v.current).toBe('model')
    expect(v.completed).toBe(1)
  })

  it('reports no current step once everything is done', () => {
    const v = checklistView(facts({ modelReady: true, hasWorkspace: true, hasConversation: true }))
    expect(v.current).toBeNull()
    expect(v.completed).toBe(3)
  })
})

describe('shouldShowChecklist', () => {
  it('shows on a fresh install', () => {
    expect(shouldShowChecklist(undefined, facts())).toBe(true)
  })

  it('stays up for a configured install that has not sent a task yet', () => {
    expect(shouldShowChecklist({}, facts({ modelReady: true, hasWorkspace: true }))).toBe(true)
  })

  it('hides once a conversation exists, even before the latch is persisted', () => {
    expect(shouldShowChecklist({}, facts({ hasConversation: true }))).toBe(false)
  })

  it('hides for good once done or skipped', () => {
    expect(shouldShowChecklist({ checklistDone: true }, facts())).toBe(false)
  })
})

describe('shouldShowTourInvite', () => {
  it('shows only while pending', () => {
    expect(shouldShowTourInvite({ tourInvite: 'pending' }, false)).toBe(true)
    expect(shouldShowTourInvite({ tourInvite: 'done' }, false)).toBe(false)
    expect(shouldShowTourInvite(undefined, false)).toBe(false)
  })

  it('never stacks on top of the checklist', () => {
    expect(shouldShowTourInvite({ tourInvite: 'pending' }, true)).toBe(false)
  })
})

describe('existingInstallOnboarding', () => {
  it('marks every tip seen and invites a tour', () => {
    expect(existingInstallOnboarding()).toEqual({ seenTips: [...TIP_IDS], tourInvite: 'pending' })
  })
})

describe('markTipsSeen / restartTips', () => {
  it('adds ids without duplicates, in tour order, dropping unknown ones', () => {
    const s = markTipsSeen({ seenTips: ['revert', 'bogus'] }, ['approval', 'revert'])
    expect(s.seenTips).toEqual(['approval', 'revert'])
  })

  it('keeps other fields', () => {
    expect(markTipsSeen({ checklistDone: true }, ['approval']).checklistDone).toBe(true)
  })

  it('restart clears seen tips and settles a pending invite', () => {
    expect(restartTips({ seenTips: [...TIP_IDS], tourInvite: 'pending' })).toEqual({
      seenTips: [],
      tourInvite: 'done'
    })
  })

  it('restart on a new install does not invent an invite', () => {
    expect(restartTips(undefined).tourInvite).toBeUndefined()
  })
})

describe('relevantTips', () => {
  it('is empty when nothing is happening', () => {
    expect(relevantTips({ readyToSend: false, afterEdit: false, touring: false })).toEqual([])
  })

  it('offers the pre-send tips on an empty, ready chat', () => {
    expect(relevantTips({ readyToSend: true, afterEdit: false, touring: false })).toEqual([
      'approval',
      'worktree'
    ])
  })

  it('offers undo first after an edit', () => {
    expect(relevantTips({ readyToSend: false, afterEdit: true, touring: false })).toEqual([
      'revert',
      'changes'
    ])
  })

  it('offers every tip during a requested tour', () => {
    expect(relevantTips({ readyToSend: false, afterEdit: false, touring: true })).toEqual([
      ...TIP_IDS
    ])
  })
})

describe('pickTip', () => {
  it('returns null when nothing is relevant', () => {
    expect(pickTip([], [], all)).toBeNull()
  })

  it('picks the first unseen tip and counts the run', () => {
    expect(pickTip(['approval', 'worktree'], [], all)).toEqual({
      id: 'approval',
      index: 1,
      total: 2,
      hasNext: true
    })
  })

  it('skips tips already seen', () => {
    expect(pickTip(['approval', 'worktree'], ['approval'], all)?.id).toBe('worktree')
    expect(pickTip(['approval', 'worktree'], ['approval', 'worktree'], all)).toBeNull()
  })

  it('skips a tip whose control is not on screen instead of pointing at nothing', () => {
    const present = (id: TipId): boolean => id !== 'worktree'
    expect(pickTip(['approval', 'worktree'], [], present)).toEqual({
      id: 'approval',
      index: 1,
      total: 1,
      hasNext: false
    })
    expect(pickTip(['worktree'], [], present)).toBeNull()
  })

  it('keeps counting across a run: the second tip reads 2 of 2', () => {
    expect(pickTip(['approval', 'worktree'], ['approval'], all, ['approval'])).toEqual({
      id: 'worktree',
      index: 2,
      total: 2,
      hasNext: false
    })
  })

  it('ignores stepped tips from outside the current run', () => {
    expect(pickTip(['revert', 'changes'], ['approval'], all, ['approval'])?.index).toBe(1)
  })
})

describe('onboardingSurfaces', () => {
  it('shows nothing until conversations have loaded', () => {
    expect(onboardingSurfaces({ tourInvite: 'pending' }, facts(), false)).toEqual({
      checklist: false,
      tourInvite: false
    })
  })

  it('shows the checklist to a new user, and holds a pending invite behind it', () => {
    expect(onboardingSurfaces({ tourInvite: 'pending' }, facts(), true)).toEqual({
      checklist: true,
      tourInvite: false
    })
  })

  it('shows the invite to an existing user with chats', () => {
    expect(
      onboardingSurfaces({ tourInvite: 'pending' }, facts({ hasConversation: true }), true)
    ).toEqual({ checklist: false, tourInvite: true })
  })

  it('shows neither once both are settled', () => {
    expect(
      onboardingSurfaces({ checklistDone: true, tourInvite: 'done' }, facts(), true)
    ).toEqual({ checklist: false, tourInvite: false })
  })
})
