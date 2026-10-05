import { NavLink, Outlet } from 'react-router-dom'
import { LeafIcon } from '../components/CenteredPanel'
import { signOut } from '../features/auth/AuthProvider'
import { useOrganization } from '../features/organization/OrganizationProvider'
import styles from './AppLayout.module.css'

const NAV_ITEMS = [
  { to: '/projections', label: 'Projections' },
  { to: '/plants', label: 'Plants' },
  { to: '/settings', label: 'Settings' },
]

export function AppLayout() {
  const organization = useOrganization()

  return (
    <div className={styles.shell}>
      <header className={styles.topbar}>
        <div className={styles.topbarInner}>
          <div className={styles.brand}>
            <span className={styles.brandIcon}>
              <LeafIcon size={18} />
            </span>
            <span className={styles.brandName}>Plants</span>
            <span className={styles.orgName}>{organization.name}</span>
          </div>
          <nav className={styles.nav} aria-label="Main">
            {NAV_ITEMS.map((item) => (
              <NavLink key={item.to} to={item.to} className={({ isActive }) => `${styles.navLink} ${isActive ? styles.active : ''}`}>
                {item.label}
              </NavLink>
            ))}
          </nav>
          <button type="button" className={`button button-link ${styles.signOut}`} onClick={signOut}>
            Sign out
          </button>
        </div>
      </header>
      <main className={styles.main}>
        <Outlet />
      </main>
    </div>
  )
}
