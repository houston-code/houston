import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * The Electron glue around the quit guard: what counts as live work and whether a
 * restart-to-install is confirmed before `quitAndInstall` runs. Electron and the
 * live-work sources are stubbed; each test re-imports the module for fresh state.
 */
const h = vi.hoisted(() => ({
  runs: 0,
  shells: [] as Array<{ running: boolean }>,
  terminals: 0,
  response: 1,
  dialogs: [] as Array<Record<string, unknown>>,
  quits: 0,
  relaunches: 0
}))

vi.mock('electron', () => ({
  app: { quit: () => h.quits++, relaunch: () => h.relaunches++ },
  BrowserWindow: { getFocusedWindow: () => null, getAllWindows: () => [] },
  dialog: {
    showMessageBox: async (...args: unknown[]) => {
      h.dialogs.push(args[args.length - 1] as Record<string, unknown>)
      return { response: h.response }
    }
  }
}))
vi.mock('./agent/loop', () => ({ activeRunCount: () => h.runs }))
vi.mock('./agent/shells', () => ({ listShells: () => h.shells }))
vi.mock('./terminal', () => ({ terminalCount: () => h.terminals }))
vi.mock('./logger', () => ({ log: { error: () => {} } }))

async function load(): Promise<typeof import('./quit-confirm')> {
  vi.resetModules()
  return import('./quit-confirm')
}

function quitEvent(): { preventDefault: () => void; prevented: boolean } {
  const e = { prevented: false, preventDefault: () => (e.prevented = true) }
  return e
}

beforeEach(() => {
  h.runs = 0
  h.shells = []
  h.terminals = 0
  h.response = 1
  h.dialogs = []
  h.quits = 0
  h.relaunches = 0
})

describe('relaunchApp', () => {
  it('relaunches straight away when nothing is running', async () => {
    const { relaunchApp } = await load()
    expect(await relaunchApp()).toBe(true)
    expect(h.dialogs).toHaveLength(0)
    expect(h.relaunches).toBe(1)
    expect(h.quits).toBe(1)
  })

  it('asks first when work is live, and does nothing on Cancel', async () => {
    h.runs = 1
    const { relaunchApp } = await load()
    expect(await relaunchApp()).toBe(false)
    expect(h.dialogs[0]).toMatchObject({
      buttons: ['Restart anyway', 'Cancel'],
      detail: 'Restarting Houston now will stop it and discard any unsaved progress.'
    })
    expect(h.relaunches).toBe(0)
    expect(h.quits).toBe(0)
  })

  it('relaunches on Restart anyway, and the quit guard lets that quit through', async () => {
    h.runs = 1
    h.response = 0
    const { relaunchApp, guardQuitWithLiveWork } = await load()
    expect(await relaunchApp()).toBe(true)
    expect(h.relaunches).toBe(1)
    const e = quitEvent()
    guardQuitWithLiveWork(e as never, undefined)
    expect(e.prevented).toBe(false)
  })
})

describe('confirmRestartForUpdate', () => {
  it('proceeds without asking when nothing is running', async () => {
    const { confirmRestartForUpdate } = await load()
    expect(await confirmRestartForUpdate()).toBe(true)
    expect(h.dialogs).toHaveLength(0)
  })

  it('asks when a background shell is running, and respects Cancel', async () => {
    h.shells = [{ running: true }, { running: false }]
    const { confirmRestartForUpdate } = await load()
    expect(await confirmRestartForUpdate()).toBe(false)
    expect(h.dialogs[0]).toMatchObject({
      message: 'A background task is still running.',
      buttons: ['Restart anyway', 'Cancel']
    })
  })

  it('counts live terminals and chats too', async () => {
    h.runs = 1
    h.terminals = 2
    const { confirmRestartForUpdate } = await load()
    await confirmRestartForUpdate()
    expect(h.dialogs[0]).toMatchObject({
      message: 'A chat and 2 background tasks are still running.'
    })
  })

  it('lets the follow-up quit through once the restart is confirmed', async () => {
    h.terminals = 1
    h.response = 0 // Restart anyway
    const { confirmRestartForUpdate, guardQuitWithLiveWork } = await load()
    expect(await confirmRestartForUpdate()).toBe(true)
    const e = quitEvent()
    guardQuitWithLiveWork(e as never, undefined)
    expect(e.prevented).toBe(false)
    expect(h.dialogs).toHaveLength(1) // no second prompt from before-quit
  })

  it('guards quits again after resetQuitConfirmation', async () => {
    h.terminals = 1
    h.response = 0
    const { confirmRestartForUpdate, guardQuitWithLiveWork, resetQuitConfirmation } = await load()
    await confirmRestartForUpdate()
    resetQuitConfirmation()
    const e = quitEvent()
    guardQuitWithLiveWork(e as never, undefined)
    expect(e.prevented).toBe(true)
  })
})

describe('guardQuitWithLiveWork', () => {
  it('blocks a quit while a background task runs, then quits on confirm', async () => {
    h.shells = [{ running: true }]
    h.response = 0
    const { guardQuitWithLiveWork } = await load()
    const e = quitEvent()
    guardQuitWithLiveWork(e as never, undefined)
    expect(e.prevented).toBe(true)
    await vi.waitFor(() => expect(h.quits).toBe(1))
    expect(h.dialogs[0]).toMatchObject({ buttons: ['Quit anyway', 'Cancel'] })
  })

  it('lets the quit through when nothing is running', async () => {
    h.shells = [{ running: false }]
    const { guardQuitWithLiveWork } = await load()
    const e = quitEvent()
    guardQuitWithLiveWork(e as never, undefined)
    expect(e.prevented).toBe(false)
    expect(h.dialogs).toHaveLength(0)
  })
})
