import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import { ErrorBoundary } from './components/ErrorBoundary'
import './styles/global.css'

// Defense-in-depth against drop-to-navigate: a file dropped anywhere outside an
// explicit drop zone would otherwise make the frame navigate to that `file://`,
// replacing the privileged renderer. The component drop zones (Composer image
// attach, Sidebar reorder) keep working — they read their data in their own
// handlers — these window-level preventDefaults only suppress the browser's
// default navigate action. (The main process also blocks it via will-navigate;
// this stops the attempt one layer earlier.)
window.addEventListener('dragover', (e) => e.preventDefault())
window.addEventListener('drop', (e) => e.preventDefault())

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </React.StrictMode>
)
