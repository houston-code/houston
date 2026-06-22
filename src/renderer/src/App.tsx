import { useEffect, useState } from 'react'

export default function App(): JSX.Element {
  const [version, setVersion] = useState('')
  const [workspace, setWorkspace] = useState<string | null>(null)

  useEffect(() => {
    void window.api.getVersion().then(setVersion)
  }, [])

  return (
    <div className="app-shell">
      <header className="titlebar">
        <span className="titlebar__title">Coder Pro</span>
        <span className="titlebar__version">v{version}</span>
      </header>
      <main className="placeholder">
        <h1>Coder Pro</h1>
        <p>An open-source, local-first coding agent. Bring your own model.</p>
        <button
          className="btn"
          onClick={async () => {
            const dir = await window.api.pickWorkspace()
            if (dir) setWorkspace(dir)
          }}
        >
          Open a project folder…
        </button>
        {workspace && <p className="placeholder__path">{workspace}</p>}
      </main>
    </div>
  )
}
