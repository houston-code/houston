import { Component, type ErrorInfo, type ReactNode } from 'react'

interface Props {
  children: ReactNode
}
interface State {
  error: Error | null
}

/**
 * Catches render-time errors so a bug in one component can't white-screen the
 * whole app. Shows a recoverable fallback with the message and a Reload button.
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // Surfaced in DevTools; the main-process logger captures uncaught errors too.
    console.error('Renderer error boundary caught:', error, info.componentStack)
  }

  render(): ReactNode {
    const { error } = this.state
    if (!error) return this.props.children
    return (
      <div className="crash" role="alert">
        <h1 className="crash__title">Something went wrong</h1>
        <p className="crash__msg">{error.message || 'The interface hit an unexpected error.'}</p>
        <div className="crash__actions">
          <button className="btn btn--accent" onClick={() => window.location.reload()}>
            Reload
          </button>
          <button className="btn" onClick={() => this.setState({ error: null })}>
            Dismiss
          </button>
        </div>
        {error.stack && <pre className="crash__stack">{error.stack}</pre>}
      </div>
    )
  }
}
