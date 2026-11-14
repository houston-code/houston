import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { installRendererErrorReporting, reportRendererError } from './rendererErrors'
import { ItemBoundary } from '../components/ItemBoundary'
import { ErrorBoundary } from '../components/ErrorBoundary'

const sent: unknown[] = []
const api = window as unknown as { api?: Record<string, unknown> }
let saved: Record<string, unknown> | undefined

beforeEach(() => {
  sent.length = 0
  saved = api.api
  api.api = { ...(saved ?? {}), reportRendererError: (e: unknown) => sent.push(e) }
  vi.spyOn(console, 'error').mockImplementation(() => {})
})
afterEach(() => {
  api.api = saved
  vi.restoreAllMocks()
})

function Boom(): JSX.Element {
  throw new Error('row exploded')
}

describe('renderer error reporting', () => {
  it('sends an Error with its name, message and stack', () => {
    const e = new TypeError('x is undefined')
    reportRendererError('error', e)
    expect(sent).toEqual([{ kind: 'error', message: 'TypeError: x is undefined', stack: e.stack }])
  })

  it('describes a non-Error value, and never throws when the bridge is missing', () => {
    reportRendererError('unhandledrejection', { code: 7 })
    expect(sent).toEqual([{ kind: 'unhandledrejection', message: '{"code":7}' }])
    api.api = undefined
    expect(() => reportRendererError('error', 'boom')).not.toThrow()
  })

  it('forwards uncaught errors and unhandled rejections from the window', () => {
    const target = new EventTarget() as unknown as Window
    installRendererErrorReporting(target)
    target.dispatchEvent(Object.assign(new Event('error'), { error: new Error('uncaught'), message: 'uncaught' }))
    target.dispatchEvent(Object.assign(new Event('unhandledrejection'), { reason: 'nope' }))
    expect(sent).toEqual([
      expect.objectContaining({ kind: 'error', message: 'Error: uncaught' }),
      { kind: 'unhandledrejection', message: 'nope' }
    ])
  })

  it('an item boundary shows its notice and forwards the error with the component stack', () => {
    render(
      <ItemBoundary>
        <Boom />
      </ItemBoundary>
    )
    expect(screen.getByText('This item failed to render.')).toBeInTheDocument()
    expect(sent).toEqual([
      expect.objectContaining({ kind: 'boundary', message: 'Error: row exploded', componentStack: expect.stringContaining('Boom') })
    ])
  })

  it('the app-level boundary forwards what it catches too', () => {
    render(
      <ErrorBoundary>
        <Boom />
      </ErrorBoundary>
    )
    expect(screen.getByRole('alert')).toBeInTheDocument()
    expect(sent).toContainEqual(expect.objectContaining({ kind: 'boundary', message: 'Error: row exploded' }))
  })
})
