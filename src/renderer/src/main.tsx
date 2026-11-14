import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import { ErrorBoundary } from './components/ErrorBoundary'
import { installRendererErrorReporting } from './lib/rendererErrors'
import './styles/global.css'

// Defense-in-depth against drop-to-navigate: a file dropped anywhere outside an
// explicit drop zone would otherwise make the frame navigate to that `file://`,
// replacing the privileged renderer. The component drop zones (Composer image
// attach, Sidebar reorder) keep working — they read their data in their own
// handlers — these window-level preventDefaults only suppress the browser's
// default navigate action. (The main process also blocks it via will-navigate;
// this stops the attempt one layer earlier.) A folder dropped on the window is read
// by useFolderDrop, which opens it as the project; it never navigates either.
window.addEventListener('dragover', (e) => e.preventDefault())
// Uncaught errors and unhandled rejections go to the main-process log too.
installRendererErrorReporting()
window.addEventListener('drop', (e) => e.preventDefault())

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </React.StrictMode>
)
