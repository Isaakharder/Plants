import styles from './Climate.module.css'

const STATE_LABEL: Record<string, string> = {
  active: 'In use',
  conflict: 'Conflict',
  superseded: 'Not used',
  none: 'Quarantined',
  created: 'Created',
  duplicate: 'Duplicate',
  quarantined: 'Quarantined',
  error: 'Not stored',
}

/** A file's state (in use / conflict / not used / quarantined) or an upload's outcome. */
export function StateBadge({ state }: { state: string }) {
  return <span className={`${styles.state} ${styles[`state_${state}`] ?? ''}`}>{STATE_LABEL[state] ?? state}</span>
}
