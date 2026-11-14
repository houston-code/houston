import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import { ErrorBoundary } from './components/ErrorBoundary'
import { applyTheme, rememberedTheme } from './lib/theme'
import './styles/global.css'

// Paint the first frame in the theme the user last saved. Settings arrive over IPC
// after the first render, so waiting for them showed light-theme users a dark flash
// on every launch and new window; App re-applies (and re-caches) once they load.
applyTheme(rememberedTheme())

// Defense-in-depth against drop-to-navigate: a file dropped anywhere outside an
// explicit drop zone would otherwise make the frame navigate to that `file://`,
// replacing the privileged renderer. The component drop zones (Composer image
// attach, Sidebar reorder) keep working — they read their data in their own
// handlers — these window-level preventDefaults only suppress the browser's
// default navigate action. (The main process also blocks it via will-navigate;
// this stops the attempt one layer earlier.) A folder dropped on the window is read
// by useFolderDrop, which opens it as the project; it never navigates either.
window.addEventListener('dragover', (e) => e.preventDefault())
window.addEventListener('drop', (e) => e.preventDefault())

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </React.StrictMode>
)
