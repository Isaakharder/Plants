import { STATUS_LABELS, type CropColor, type CropStatus } from './model'

export function ColorDot({ color }: { color: CropColor }) {
  return <span className={`color-dot color-${color}`} aria-hidden="true" />
}

export function StatusBadge({ status }: { status: CropStatus }) {
  return <span className={`status-badge status-${status}`}>{STATUS_LABELS[status]}</span>
}
