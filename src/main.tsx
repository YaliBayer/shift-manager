import { StrictMode, Suspense } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import './App.css'
import CloudRoot from './cloud/CloudRoot.tsx'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Suspense fallback={<p dir="rtl">טוען…</p>}>
      <CloudRoot />
    </Suspense>
  </StrictMode>,
)
