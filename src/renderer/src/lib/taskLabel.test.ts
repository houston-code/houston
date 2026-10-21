import { describe, expect, it } from 'vitest'
import { describeShell } from './taskLabel'

const WS = '/home/dev/acme/.houston/worktrees/lucid'

describe('describeShell', () => {
  it('picks the server out of cd / venv / redirect / log-poll scaffolding', () => {
    const cmd = `cd ${WS}/backend && source venv/bin/activate && python manage.py runserver 0.0.0.0:8000 > /tmp/django.log 2>&1 &\nsleep 2 && cat /tmp/django.log`
    expect(describeShell(cmd, ['http://0.0.0.0:8000/'], WS)).toEqual({
      label: 'python manage.py runserver 0.0.0.0:8000',
      folder: 'backend/',
      ports: [':8000'],
      exposed: true
    })
  })

  it('drops the nvm bootstrap and keeps a relative cd', () => {
    const cmd = `cd frontend\nexport NVM_DIR="$HOME/.nvm" && . "$NVM_DIR/nvm.sh" && nvm use default\nnpm run dev -- --port 5173`
    const d = describeShell(cmd, ['http://localhost:5173/'], WS)
    expect(d.label).toBe('npm run dev -- --port 5173')
    expect(d.folder).toBe('frontend/')
    expect(d.ports).toEqual([':5173'])
    expect(d.exposed).toBe(false)
  })

  it('reports the workspace root as no folder', () => {
    expect(describeShell(`cd ${WS} && npm test`, [], WS)).toMatchObject({ label: 'npm test', folder: '' })
    expect(describeShell('npm test', [], WS).folder).toBe('')
  })

  it('resolves .. and nested cds', () => {
    expect(describeShell('cd apps/web && cd ../api && make', [], WS).folder).toBe('apps/api/')
  })

  it('names a folder outside the workspace by its last parts, never the full path', () => {
    const d = describeShell('cd /home/dev/other/project/sub && make', [], WS)
    expect(d.folder).toBe('…/project/sub/')
    expect(d.folder).not.toContain('/home/dev')
  })

  it('keeps quoted text and fd redirections intact inside the label', () => {
    expect(describeShell('curl "http://x/?a=1&b=2" 2>&1', [], WS).label).toBe('curl "http://x/?a=1&b=2"')
    expect(describeShell('make &>/dev/null', [], WS).label).toBe('make')
  })

  it('falls back to the first line when there is nothing but setup', () => {
    expect(describeShell('sleep 5', [], WS).label).toBe('sleep 5')
  })

  it('dedupes ports and flags only real exposure', () => {
    const d = describeShell('npm run dev', ['http://localhost:5173/', 'http://127.0.0.1:5173/', 'http://localhost:24678/'], WS)
    expect(d.ports).toEqual([':5173', ':24678'])
    expect(describeShell('vite --host', [], WS).exposed).toBe(true)
    expect(describeShell('vite --host 127.0.0.1', [], WS).exposed).toBe(false)
    expect(describeShell('vite --host --port 3000', [], WS).exposed).toBe(true)
    expect(describeShell('node server.js', ['http://[::]:3000/'], WS).exposed).toBe(true)
  })
})
