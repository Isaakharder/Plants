import { Outlet } from 'react-router-dom'

export function ClimatePage() {
  return (
    <>
      {/* Like Projections: the tab toolbar is the page's top; the h1 is for screen readers. */}
      <h1 className="visually-hidden">Climate</h1>
      <Outlet />
    </>
  )
}
