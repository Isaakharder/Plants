import { NavLink, useSearchParams } from 'react-router-dom'
import styles from './WeeklyPlantDataTab.module.css'

/** The Projections sub-tabs. The selected variety carries over between them. */
export function ProjectionsTabs() {
  const [params] = useSearchParams()
  const crop = params.get('crop')
  const search = crop ? `?crop=${encodeURIComponent(crop)}` : ''
  const cls = ({ isActive }: { isActive: boolean }) => `${styles.subtab} ${isActive ? styles.active : ''}`
  return (
    <nav className={styles.subtabs} aria-label="Projections">
      <NavLink to={`/projections/weekly-plant-data${search}`} className={cls}>
        Weekly Plant Data
      </NavLink>
      <NavLink to={`/projections/harvest-forecast${search}`} className={cls}>
        Harvest Forecast
      </NavLink>
    </nav>
  )
}
