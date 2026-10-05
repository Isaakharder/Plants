import type { ReactNode } from 'react'

export function CenteredPanel({ title, subtitle, children }: { title: string; subtitle?: string; children: ReactNode }) {
  return (
    <main className="centered-panel">
      <div className="centered-panel-card">
        <div className="brand-mark" aria-hidden="true">
          <LeafIcon />
        </div>
        <h1 className="centered-panel-title">{title}</h1>
        {subtitle && <p className="centered-panel-subtitle">{subtitle}</p>}
        {children}
      </div>
    </main>
  )
}

export function LeafIcon({ size = 20 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M11 20A7 7 0 0 1 9.8 6.1C15.5 5 17 4.48 19 2c1 2 2 4.18 2 8 0 5.5-4.78 10-10 10Z" />
      <path d="M2 21c0-3 1.85-5.36 5.08-6C9.5 14.52 12 13 13 12" />
    </svg>
  )
}
