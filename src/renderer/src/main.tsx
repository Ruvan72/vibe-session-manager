import { createRoot } from 'react-dom/client'
import { App } from './App.tsx'
import './styles.css'

const root = createRoot(document.getElementById('root')!)
// The page needs the app's preload API; opened in a normal browser (e.g. the dev server URL) it has none.
if (window.api) root.render(<App />)
else
  root.render(
    <div className="empty">
      This page only works inside the Vibe Session Manager app. Click its tray icon or press Ctrl+Alt+Space to open it.
    </div>
  )
