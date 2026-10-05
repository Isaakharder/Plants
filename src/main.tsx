import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './app/App'
import { startQueryPersistence } from './features/collector/offline/queryPersistence'
import { queryClient } from './lib/queryClient'
import './styles/tokens.css'
import './styles/global.css'

// Restore the collector's saved data (and the organization) before the first
// render, so the mobile collector can open without a connection. This is a
// local IndexedDB read and takes a few milliseconds.
void startQueryPersistence(queryClient).finally(() => {
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <App />
    </StrictMode>,
  )
})

// Service worker for the installable mobile collector. Production only, so it
// never caches Vite dev-server modules.
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {})
  })
}
