import { Link } from 'react-router-dom'
import { formatDate } from '../../lib/dates'
import { formatArea, formatInteger } from '../../lib/format'
import { ColorDot, StatusBadge } from './CropBadges'
import { cropDescription, cropStatus, type Crop } from './model'
import styles from './CropCard.module.css'

export function CropCard({ crop }: { crop: Crop }) {
  const status = cropStatus(crop)
  return (
    <Link to={`/settings/varieties/${crop.id}`} className={`${styles.card} ${styles[status]}`}>
      <div className={styles.top}>
        <div className={styles.identity}>
          <ColorDot color={crop.color} />
          <div>
            <h3 className={styles.name}>{crop.name}</h3>
            <p className={styles.description}>{cropDescription(crop.color)}</p>
          </div>
        </div>
        <StatusBadge status={status} />
      </div>

      <dl className={styles.stats}>
        <div>
          <dt>Growing area</dt>
          <dd>
            {formatArea(crop.area_m2)} <span className={styles.unit}>m²</span>
          </dd>
        </div>
        <div>
          <dt>Picking stems</dt>
          <dd>{formatInteger(crop.picking_stems)}</dd>
        </div>
      </dl>

      <p className={styles.dates}>
        {formatDate(crop.planting_date)} <span aria-label="to">→</span> {formatDate(crop.pullout_date)}
      </p>
    </Link>
  )
}
