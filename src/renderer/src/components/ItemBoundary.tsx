import { Component, type ErrorInfo, type ReactNode } from 'react'

interface Props {
  children: ReactNode
  /**
   * When this changes, a caught error is cleared and the children are tried again,
   * so a row that threw on one streamed state renders once its content moves on.
   */
  resetKey?: unknown
}
interface State {
  error: Error | null
  resetKey: unknown
}

/**
 * A small error boundary around one piece of content (a transcript row, a rendered
 * markdown body, an inline visual). A render error there replaces only that piece
 * with a one-line notice, instead of reaching the app-level boundary and taking the
 * whole window down with it.
 */
export class ItemBoundary extends Component<Props, State> {
  state: State = { error: null, resetKey: this.props.resetKey }

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error }
  }

  static getDerivedStateFromProps(props: Props, state: State): Partial<State> | null {
    if (props.resetKey === state.resetKey) return null
    return { resetKey: props.resetKey, error: null }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('Item error boundary caught:', error, info.componentStack)
  }

  render(): ReactNode {
    if (!this.state.error) return this.props.children
    return (
      <div className="notice notice--error" role="alert">
        This item couldn't be shown.
      </div>
    )
  }
}
