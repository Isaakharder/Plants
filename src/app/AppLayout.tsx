import { NavLink, Outlet, useLocation } from 'react-router-dom'
import { LeafIcon } from '../components/CenteredPanel'
import { signOut } from '../features/auth/AuthProvider'
import { useOrganization } from '../features/organization/OrganizationProvider'
import styles from './AppLayout.module.css'

const NAV_ITEMS = [
  { to: '/projections', label: 'Projections' },
  { to: '/climate', label: 'Climate' },
  { to: '/harvests', label: 'Harvests' },
  { to: '/plants', label: 'Plants' },
  { to: '/photos', label: 'Photos' },
  { to: '/settings', label: 'Settings' },
]

export function AppLayout() {
  const organization = useOrganization()
  // Projections, Climate and Plants have no page header, so they sit closer under the top bar.
  const { pathname } = useLocation()
  const compact = pathname.startsWith('/projections') || pathname.startsWith('/climate') || pathname.startsWith('/plants')

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
      <main className={`${styles.main} ${compact ? styles.mainCompact : ''}`}>
        <Outlet />
      </main>
    </div>
  )
}
