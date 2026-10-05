import { NavLink, Outlet } from 'react-router-dom'
import { PageHeader } from '../components/PageHeader'
import styles from './ProjectionsPage.module.css'

const SUBTABS = [{ to: 'weekly-plant-data', label: 'Weekly Plant Data' }]

export function ProjectionsPage() {
  return (
    <>
      <PageHeader title="Projections" description="What am I going to harvest?" />
      <nav className={styles.subtabs} aria-label="Projections">
        {SUBTABS.map((tab) => (
          <NavLink key={tab.to} to={tab.to} className={({ isActive }) => `${styles.subtab} ${isActive ? styles.active : ''}`}>
            {tab.label}
          </NavLink>
        ))}
      </nav>
      <Outlet />
    </>
  )
}
