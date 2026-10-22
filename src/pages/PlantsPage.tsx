import { NavLink, Outlet } from 'react-router-dom'
import styles from '../features/plants/PlantsTwin.module.css'

/** Plants: the stem view (default) and weekly Metrics. */
export function PlantsPage() {
  const cls = ({ isActive }: { isActive: boolean }) => `${styles.subtab} ${isActive ? styles.subtabActive : ''}`
  return (
    <>
      {/* No visible page header: the controls are the page's top. Keep an h1 for screen readers only. */}
      <h1 className="visually-hidden">Plants</h1>
      <nav className={styles.subtabs} aria-label="Plants">
        <NavLink to="/plants" end className={cls}>
          Plants
        </NavLink>
        <NavLink to="/plants/metrics" className={cls}>
          Metrics
        </NavLink>
      </nav>
      <Outlet />
    </>
  )
}
