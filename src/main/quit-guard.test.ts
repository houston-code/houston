import { describe, expect, it } from 'vitest'
import {
  shouldConfirmQuit,
  quitConfirmButton,
  quitConfirmDetail,
  quitConfirmMessage
} from './quit-guard'

describe('shouldConfirmQuit', () => {
  it('does not confirm when nothing is running', () => {
    expect(shouldConfirmQuit({ chats: 0, tasks: 0 })).toBe(false)
  })

  it('confirms when one or more chats are live', () => {
    expect(shouldConfirmQuit({ chats: 1, tasks: 0 })).toBe(true)
    expect(shouldConfirmQuit({ chats: 5, tasks: 0 })).toBe(true)
  })

  it('confirms when only background tasks are running', () => {
    expect(shouldConfirmQuit({ chats: 0, tasks: 1 })).toBe(true)
  })
})

describe('quitConfirmMessage', () => {
  it('uses the singular for a single live chat', () => {
    expect(quitConfirmMessage({ chats: 1, tasks: 0 })).toBe('A chat is still running.')
  })

  it('uses the plural and the count for multiple chats', () => {
    expect(quitConfirmMessage({ chats: 3, tasks: 0 })).toBe('3 chats are still running.')
  })

  it('names background tasks on their own', () => {
    expect(quitConfirmMessage({ chats: 0, tasks: 1 })).toBe('A background task is still running.')
    expect(quitConfirmMessage({ chats: 0, tasks: 2 })).toBe('2 background tasks are still running.')
  })

  it('combines chats and background tasks with a plural verb', () => {
    expect(quitConfirmMessage({ chats: 1, tasks: 1 })).toBe(
      'A chat and a background task are still running.'
    )
    expect(quitConfirmMessage({ chats: 2, tasks: 3 })).toBe(
      '2 chats and 3 background tasks are still running.'
    )
  })
})

describe('quitConfirmDetail', () => {
  it('uses the singular object pronoun for one live item', () => {
    const detail = quitConfirmDetail({ chats: 1, tasks: 0 })
    expect(detail).toContain('Quitting now will stop it')
  })

  it('uses the plural object pronoun for several live items', () => {
    expect(quitConfirmDetail({ chats: 1, tasks: 1 })).toContain('stop them')
    expect(quitConfirmDetail({ chats: 3, tasks: 0 })).toContain('stop them')
  })

  it('describes a restart-to-install when restarting', () => {
    expect(quitConfirmDetail({ chats: 0, tasks: 2 }, 'restart')).toBe(
      'Restarting to install the update now will stop them and discard any unsaved progress.'
    )
  })

  it('never uses an em dash (user-visible copy)', () => {
    for (const reason of ['quit', 'restart'] as const) {
      expect(quitConfirmDetail({ chats: 2, tasks: 2 }, reason)).not.toContain('—')
    }
    expect(quitConfirmMessage({ chats: 2, tasks: 2 })).not.toContain('—')
  })
})

describe('quitConfirmButton', () => {
  it('labels the confirming button for the action', () => {
    expect(quitConfirmButton('quit')).toBe('Quit anyway')
    expect(quitConfirmButton('restart')).toBe('Restart anyway')
  })
})
