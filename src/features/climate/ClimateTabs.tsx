import { NavLink } from 'react-router-dom'
import styles from './Climate.module.css'

/** Climate sub-tabs; Imports shows how many files wait for review. */
export function ClimateTabs({ reviewCount = 0 }: { reviewCount?: number }) {
  const cls = ({ isActive }: { isActive: boolean }) => `${styles.subtab} ${isActive ? styles.active : ''}`
  return (
    <nav className={styles.subtabs} aria-label="Climate">
      <NavLink to="/climate/monitor" className={cls}>
        Monitor
      </NavLink>
      <NavLink to="/climate/imports" className={cls}>
        Imports
        {reviewCount > 0 && (
          <span className={styles.badgeCount} aria-label={`${reviewCount} to review`}>
            {reviewCount}
          </span>
        )}
      </NavLink>
      <NavLink to="/climate/reports" className={cls}>
        Reports
      </NavLink>
      <NavLink to="/climate/maturation" className={cls}>
        Maturation
      </NavLink>
    </nav>
  )
}
