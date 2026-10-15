import { Outlet } from 'react-router-dom'

export function ProjectionsPage() {
  return (
    <>
      {/* No visible page header: the toolbar inside the tab is the page's top. Keep an h1 for screen readers only. */}
      <h1 className="visually-hidden">Projections</h1>
      <Outlet />
    </>
  )
}
