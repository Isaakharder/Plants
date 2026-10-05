import { useEffect } from 'react'
import type { NodeStatus, PlantNode } from '../collector/types'
import { useNodeObservations } from './api'
import { buildTimeline, diagnose, nodeName, neighbourhood, shortId, summarizeRecord, type Observation, type RecordSummary } from './review'
import styles from './ReviewPanel.module.css'

const STATUS: Record<NodeStatus, { short: string; name: string; className: string }> = {
  Flower: { short: 'F', name: 'Flower', className: styles.sFlower },
  SetFruit: { short: 'S', name: 'Set fruit', className: styles.sSet },
  MatureGreen: { short: 'MG', name: 'Mature green', className: styles.sMature },
  BreakerFruit: { short: 'B', name: 'Breaker', className: styles.sBreaker },
  Harvested: { short: 'H', name: 'Harvested', className: styles.sResolved },
  Aborted: { short: 'A', name: 'Aborted', className: styles.sResolved },
  Pruned: { short: 'P', name: 'Pruned', className: styles.sResolved },
}

const fmtDate = (iso: string) => new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
const obsText = (o: Observation | null) => (o ? `${STATUS[o.status].name} · W${o.week_number} ${o.year}` : '—')

type Props = {
  rowName: string
  stemName: string
  /** The records under review (a flagged duplicate group, or one node). */
  nodeIds: string[]
  /** Every node of the row as last loaded. */
  rowNodes: PlantNode[]
  /** The stem's missing main-stem numbers (from the twin). */
  missingNumbers: number[]
  onClose: () => void
}

/**
 * Review records: the records behind a flagged problem side by side, their
 * weekly history on one timeline, and what the data suggests. Read-only —
 * structural fixes belong in the mobile collector, at the plant.
 */
export function ReviewPanel({ rowName, stemName, nodeIds, rowNodes, missingNumbers, onClose }: Props) {
  const nodes = nodeIds.map((id) => rowNodes.find((n) => n.id === id)).filter((n): n is PlantNode => Boolean(n))
  const first = nodes[0]
  const stemNodes = rowNodes.filter((n) => n.measurement_stem_id === first?.measurement_stem_id)
  const childIds = stemNodes.filter((n) => n.parent_node_id && nodeIds.includes(n.parent_node_id)).map((n) => n.id)
  const observations = useNodeObservations([...nodeIds, ...childIds])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const records = nodes.map((n) => summarizeRecord(n, stemNodes, observations.data ?? []))
  const timeline = buildTimeline(records)
  const diagnosis = observations.data ? diagnose(records, stemNodes, timeline) : []
  const title = nodes.length > 1 ? `${nodes.length} records · ${nodeName(nodes[0])}` : first ? nodeName(first) : 'Records'
  const strip = first && !first.is_side_shoot && nodes.length > 1 ? neighbourhood(stemNodes, first.node_number, nodes.length) : []

  return (
    <>
      <div className={styles.scrim} onClick={onClose} aria-hidden="true" />
      <section className={styles.panel} role="dialog" aria-modal="true" aria-label="Review records">
        <header className={styles.head}>
          <div>
            <p className={styles.eyebrow}>
              Review records · {rowName} · {stemName}
            </p>
            <h2>{title}</h2>
          </div>
          <button type="button" className="icon-button" onClick={onClose} aria-label="Close">
            ×
          </button>
        </header>

        {diagnosis.length > 0 && (
          <div className={styles.diagnosis}>
            {diagnosis.map((line) => (
              <p key={line}>{line}</p>
            ))}
          </div>
        )}

        <dl className={styles.stemFacts}>
          <dt>Missing numbers on {stemName}</dt>
          <dd>{missingNumbers.length ? missingNumbers.join(', ') : 'None'}</dd>
          {strip.length > 0 && (
            <>
              <dt>Nearby</dt>
              <dd className={styles.strip} aria-label="Records per node number nearby">
                {strip.map((s) => (
                  <span key={s.number} className={s.records === 0 ? styles.gap : s.records > 1 ? styles.dup : undefined} title={s.records === 0 ? 'missing' : `${s.records} record${s.records > 1 ? 's' : ''}`}>
                    {s.number}
                    {s.records === 0 ? ' missing' : s.records > 1 ? ` ×${s.records}` : ''}
                  </span>
                ))}
              </dd>
            </>
          )}
        </dl>

        {observations.isPending ? (
          <p className={styles.muted}>Loading observation history…</p>
        ) : observations.error ? (
          <p className={styles.error}>Couldn’t load the observation history: {observations.error.message}</p>
        ) : (
          <>
            <div className={styles.records}>
              {records.map((r) => (
                <RecordCard key={r.node.id} record={r} stemNodes={stemNodes} />
              ))}
            </div>
            {timeline.weeks.length > 0 && <TimelineTable records={records} timeline={timeline} />}
          </>
        )}

        <p className={styles.readOnly}>This page is read-only. It explains the problem; corrections will be made in the mobile collector, at the plant.</p>
      </section>
    </>
  )
}

function RecordCard({ record: r, stemNodes }: { record: RecordSummary; stemNodes: PlantNode[] }) {
  const n = r.node
  const parent = n.parent_node_id ? stemNodes.find((p) => p.id === n.parent_node_id) : null
  return (
    <article className={styles.card}>
      <header>
        <h3>{nodeName(n)}</h3>
        <code title={n.id}>record {shortId(n.id)}</code>
      </header>
      {!n.is_active && <p className={styles.removedTag}>Removed in the collector (history kept)</p>}
      {r.observations.length === 0 && <p className={styles.emptyTag}>No observations</p>}
      <dl className={styles.facts}>
        <dt>Type</dt>
        <dd>{n.is_side_shoot ? `Side shoot, ${n.side}` : 'Main stem'}</dd>
        {n.is_side_shoot && (
          <>
            <dt>Parent</dt>
            <dd>
              {parent ? nodeName(parent) : '—'} {parent && <code>{shortId(parent.id)}</code>}
            </dd>
          </>
        )}
        <dt>Created</dt>
        <dd>
          {fmtDate(n.created_at)} · W{r.createdWeek.week}
        </dd>
        <dt>Latest status</dt>
        <dd>{obsText(r.latest)}</dd>
        <dt>Observations</dt>
        <dd>{r.observations.length}</dd>
        <dt>First</dt>
        <dd>{obsText(r.first)}</dd>
        {!n.is_side_shoot && (
          <>
            <dt>Side shoots</dt>
            <dd>
              {r.children.length === 0
                ? 'None'
                : r.children.map((c) => (
                    <span key={c.node.id} className={styles.child}>
                      {c.node.node_label} ({c.node.side}) · {c.observationCount} obs{c.latest ? ` · ${STATUS[c.latest.status].name} W${c.latest.week_number}` : ''}
                      {!c.node.is_active && ' · removed'}
                    </span>
                  ))}
            </dd>
          </>
        )}
      </dl>
    </article>
  )
}

function TimelineTable({ records, timeline }: { records: RecordSummary[]; timeline: ReturnType<typeof buildTimeline> }) {
  return (
    <div className={styles.timelineWrap}>
      <table className={styles.timeline}>
        <caption>Weekly status of each record · highlighted weeks were updated on more than one record</caption>
        <thead>
          <tr>
            <th scope="col">Record</th>
            {timeline.weeks.map((w) => (
              <th key={w.key} scope="col" className={timeline.sharedWeeks.has(w.key) ? styles.shared : undefined}>
                W{w.week}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {records.map((r) => (
            <tr key={r.node.id}>
              <th scope="row">
                {nodeName(r.node)} <code>{shortId(r.node.id)}</code>
              </th>
              {timeline.weeks.map((w) => {
                const s = timeline.cells.get(r.node.id)?.get(w.key)
                return (
                  <td key={w.key} className={timeline.sharedWeeks.has(w.key) ? styles.shared : undefined}>
                    {s && (
                      <span className={`${styles.cell} ${STATUS[s].className}`} title={`${STATUS[s].name}, W${w.week} ${w.year}`}>
                        {STATUS[s].short}
                      </span>
                    )}
                  </td>
                )
              })}
            </tr>
          ))}
        </tbody>
      </table>
      <p className={styles.key}>F flower · S set fruit · MG mature green · B breaker · H harvested · A aborted · P pruned</p>
    </div>
  )
}
