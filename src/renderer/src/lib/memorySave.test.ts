import { describe, expect, it, vi } from 'vitest'
import { saveMemoryAndNotify } from './memorySave'

describe('saveMemoryAndNotify', () => {
  it('says where a project note landed', async () => {
    const notify = vi.fn()
    const save = vi.fn().mockResolvedValue('/w/AGENTS.md')
    await saveMemoryAndNotify(save, notify, '/w', 'project', 'run the linter')
    expect(save).toHaveBeenCalledWith('/w', 'project', 'run the linter')
    expect(notify).toHaveBeenCalledWith('Remembered: added to this project (/w/AGENTS.md)', 'info')
  })

  it('says a global note applies to every project', async () => {
    const notify = vi.fn()
    await saveMemoryAndNotify(vi.fn().mockResolvedValue('~/.houston/AGENTS.md'), notify, '/w', 'global', 'x')
    expect(notify).toHaveBeenCalledWith('Remembered: added to every project (~/.houston/AGENTS.md)', 'info')
  })

  it('reports input main refused', async () => {
    const notify = vi.fn()
    await saveMemoryAndNotify(vi.fn().mockResolvedValue(null), notify, '', 'project', 'x')
    expect(notify).toHaveBeenCalledWith('Could not save that instruction.', 'error')
  })

  it('reports a failed write instead of rejecting', async () => {
    const notify = vi.fn()
    const save = vi.fn().mockRejectedValue(new Error('busy'))
    await expect(saveMemoryAndNotify(save, notify, '/w', 'project', 'x')).resolves.toBeUndefined()
    expect(notify).toHaveBeenCalledWith("Couldn't save that instruction: busy", 'error')
  })

  it("names main's reason without Electron's IPC prefix", async () => {
    const notify = vi.fn()
    const err = new Error(
      "Error invoking remote method 'memory:save': Error: AGENTS.md links to /etc/x, outside this project. Add the note there instead."
    )
    await saveMemoryAndNotify(vi.fn().mockRejectedValue(err), notify, '/w', 'project', 'x')
    expect(notify).toHaveBeenCalledWith(
      "Couldn't save that instruction: AGENTS.md links to /etc/x, outside this project. Add the note there instead.",
      'error'
    )
  })

  it('falls back to a generic message when the failure carries none', async () => {
    const notify = vi.fn()
    await saveMemoryAndNotify(vi.fn().mockRejectedValue('x'), notify, '/w', 'project', 'x')
    expect(notify).toHaveBeenCalledWith("Couldn't save that instruction. Try again.", 'error')
  })
})
