import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { EmptyState, ErrorState, LoadingState } from '../../components/States'
import { currentGreenhouseWeek } from '../collector/greenhouseWeek'
import { cropColorVar } from '../collector/display'
import { useCrops } from '../crops/api'
import { sortCrops } from '../crops/model'
import { useOrganization } from '../organization/OrganizationProvider'
import { useCropRows, usePlantsRow } from './api'
import { COLORS } from './colors'
import { ReviewPanel } from './ReviewPanel'
import { DuplicateBadge, LegendGlyph, StaleBadge } from './Glyphs'
import type { NodeHandler } from './PlantSvg'
import { PlantSvg } from './PlantSvg'
import { STALE_AFTER_WEEKS, STEM_WIDTH, buildTwin, type TwinNode, type TwinStem } from './twin'
import styles from './PlantsTwin.module.css'

const STATUS_NAMES: Record<string, string> = {
  Flower: 'Flower',
  SetFruit: 'Set fruit',
  MatureGreen: 'Mature green',
  BreakerFruit: 'Breaker',
  Harvested: 'Harvested',
  Aborted: 'Aborted',
  Pruned: 'Pruned',
}

const LEGEND: { status: TwinNode['status']; label: string; faint?: boolean }[] = [
  { status: 'Flower', label: 'Flower' },
  { status: 'SetFruit', label: 'Set fruit' },
  { status: 'MatureGreen', label: 'Mature green' },
  { status: 'BreakerFruit', label: 'Breaker' },
  { status: 'Harvested', label: 'Harvested', faint: true },
  { status: 'Aborted', label: 'Aborted', faint: true },
  { status: 'Pruned', label: 'Pruned', faint: true },
  { status: null, label: 'No observation', faint: true },
]

/** Smallest Fit-width scale; below this, scroll sideways instead. */
const MIN_FIT_SCALE = 0.72

type Pinned = { stemId: string; nodeId: string | null }
type Hover = { node: TwinNode; stem: TwinStem; x: number; y: number }
type Review = { stemId: string; nodeIds: string[] }

/**
 * Plants › digital twin: the current state of every sampled stem in a row,
 * drawn from the mobile collector's records (read-only).
 */
export function PlantsTwin() {
  const organization = useOrganization()
  const crops = useCrops(organization.id)
  const [params, setParams] = useSearchParams()

  const sorted = useMemo(() => sortCrops(crops.data ?? []), [crops.data])
  const crop = sorted.find((c) => c.id === params.get('crop')) ?? sorted[0]
  const rows = useCropRows(crop?.id)
  const row = rows.data?.find((r) => r.id === params.get('row')) ?? rows.data?.[0]
  const plants = usePlantsRow(row?.id)

  const [zoom, setZoom] = useState<'fit' | 'full'>('fit')
  const [pinned, setPinned] = useState<Pinned | null>(null)
  const [hover, setHover] = useState<Hover | null>(null)
  const [review, setReview] = useState<Review | null>(null)
  const viewportRef = useRef<HTMLDivElement>(null)
  const [viewportWidth, setViewportWidth] = useState(0)

  useEffect(() => {
    const el = viewportRef.current
    if (!el) return
    const observer = new ResizeObserver(([entry]) => setViewportWidth(entry.contentRect.width))
    observer.observe(el)
    return () => observer.disconnect()
  }, [plants.data])

  const twin = useMemo(() => (plants.data ? buildTwin(plants.data, currentGreenhouseWeek()) : null), [plants.data])
  const variety = crop ? cropColorVar(crop.color) : COLORS.matureGreen
  const stemCount = twin?.stems.length ?? 0
  // Each column has a 1px divider; leave room for it so Fit width never scrolls sideways.
  const fitScale = viewportWidth && stemCount ? Math.min(1, Math.max(MIN_FIT_SCALE, (viewportWidth - stemCount - 2) / (stemCount * STEM_WIDTH))) : 1
  const scale = zoom === 'fit' ? fitScale : 1

  const onNodeEnter = useCallback<NodeHandler>((node, stem, e) => setHover({ node, stem, x: e.clientX, y: e.clientY }), [])
  const onNodeLeave = useCallback(() => setHover(null), [])
  const onNodeClick = useCallback<NodeHandler>((node, stem) => setPinned((p) => (p?.nodeId === node.id ? { stemId: stem.id, nodeId: null } : { stemId: stem.id, nodeId: node.id })), [])
  const onProblemClick = useCallback<NodeHandler>((node, stem) => {
    setHover(null)
    setPinned({ stemId: stem.id, nodeId: node.id })
    setReview({ stemId: stem.id, nodeIds: problemFor(stem, node.id)?.nodeIds ?? [node.id] })
  }, [])
  const closeReview = useCallback(() => setReview(null), [])
  const reviewNode = (stem: TwinStem, nodeId: string) => setReview({ stemId: stem.id, nodeIds: problemFor(stem, nodeId)?.nodeIds ?? [nodeId] })

  const select = (next: { crop?: string; row?: string }) =>
    setParams(
      (prev) => {
        const p = new URLSearchParams(prev)
        if (next.crop) {
          p.set('crop', next.crop)
          p.delete('row')
        }
        if (next.row) p.set('row', next.row)
        return p
      },
      { replace: true },
    )

  if (crops.isPending) return <LoadingState />
  if (crops.error) return <ErrorState error={crops.error} />
  if (!crop) return <EmptyState title="No varieties yet" description="Add a variety in Settings, then record plants with the mobile collector." />

  const summary = twin ? summarize(twin.stems) : null
  const pinnedStem = twin?.stems.find((s) => s.id === pinned?.stemId) ?? null
  const pinnedNode = pinnedStem && pinned?.nodeId ? allNodes(pinnedStem).find((n) => n.id === pinned.nodeId) ?? null : null
  const updated = plants.dataUpdatedAt ? new Date(plants.dataUpdatedAt).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }) : null

  return (
    <section className={styles.section} aria-label="Plants digital twin">
      <div className={styles.controls}>
        <label className={`field ${styles.control}`}>
          <span className="field-label">Variety</span>
          <select className="input" value={crop.id} onChange={(e) => select({ crop: e.target.value })}>
            {sorted.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </label>
        <label className={`field ${styles.control}`}>
          <span className="field-label">Row</span>
          <select className="input" value={row?.id ?? ''} onChange={(e) => select({ row: e.target.value })} disabled={!rows.data?.length}>
            {(rows.data ?? []).map((r) => (
              <option key={r.id} value={r.id}>
                {r.row_name}
              </option>
            ))}
          </select>
        </label>
        <div className={styles.toolbar}>
          <span className={styles.updated}>
            {plants.isFetching ? 'Updating…' : updated ? `Updated ${updated}` : ''}
            {' · '}
            <button type="button" className={styles.linkButton} onClick={() => void plants.refetch()} disabled={plants.isFetching || !row}>
              Refresh
            </button>
          </span>
          <div className={styles.segmented} role="group" aria-label="Zoom">
            <button type="button" aria-pressed={zoom === 'fit'} onClick={() => setZoom('fit')}>
              Fit width
            </button>
            <button type="button" aria-pressed={zoom === 'full'} onClick={() => setZoom('full')}>
              100%
            </button>
          </div>
        </div>
      </div>

      {summary && (
        <p className={styles.summary}>
          <strong>{summary.stems} stems</strong> · {summary.mainNodes} main-stem nodes · {summary.shoots} side shoots · on the plants now:{' '}
          <strong>{summary.on.Flower}</strong> flowers, <strong>{summary.on.SetFruit}</strong> set, <strong>{summary.on.MatureGreen}</strong> mature green,{' '}
          <strong>{summary.on.BreakerFruit}</strong> breaker
          {summary.stale > 0 && <> · <span className={styles.staleText}>{summary.stale} possibly stale</span></>}
          {summary.duplicates > 0 && (
            <>
              {' '}
              · <span className={styles.warnText}>{summary.duplicates} duplicated node{summary.duplicates > 1 ? 's' : ''} (click ⚠ to review)</span>
            </>
          )}
        </p>
      )}

      <ul className={styles.legend} aria-label="Legend">
        {LEGEND.map((l) => (
          <li key={l.label} className={l.faint ? styles.faint : undefined}>
            <LegendGlyph status={l.status} variety={variety} />
            {l.label}
          </li>
        ))}
        <li>
          <svg width={14} height={14} viewBox="-7 -7 14 14" aria-hidden="true">
            <StaleBadge x={0} y={0} />
          </svg>
          Not updated &gt; {STALE_AFTER_WEEKS} weeks
        </li>
        <li>
          <svg width={14} height={14} viewBox="-7 -7 14 14" aria-hidden="true">
            <DuplicateBadge x={0} y={0} />
          </svg>
          Duplicate record — click to review
        </li>
        <li>
          <span className={styles.growthSample}>7.0 cm · W32</span> weekly head growth
        </li>
        <li className={styles.faint}>Leaves are decorative · hover a node for details, click a node or stem heading to pin them</li>
      </ul>

      {rows.isPending || (row && plants.isPending) ? (
        <LoadingState />
      ) : rows.error || plants.error ? (
        <ErrorState error={rows.error ?? plants.error} />
      ) : !row || !twin || twin.stems.length === 0 ? (
        <EmptyState title={`No sampled stems for ${crop.name}`} description="Rows and stems appear here once they're added with the mobile collector." />
      ) : (
        <div className={styles.layout}>
          <div className={styles.viewport} ref={viewportRef}>
            <div className={styles.stems}>
              {twin.stems.map((stem) => (
                <div key={stem.id} className={`${styles.column} ${pinned?.stemId === stem.id ? styles.selectedColumn : ''}`}>
                  <button
                    type="button"
                    className={styles.stemHead}
                    style={{ width: STEM_WIDTH * scale }}
                    onClick={() => setPinned((p) => (p?.stemId === stem.id && !p.nodeId ? null : { stemId: stem.id, nodeId: null }))}
                    aria-pressed={pinned?.stemId === stem.id}
                  >
                    {stem.name}
                    <small>
                      {stem.mainNodes.length} nodes · {stem.shootCount} shoots
                    </small>
                  </button>
                  <PlantSvg
                    stem={stem}
                    height={twin.height}
                    baseY={twin.baseY}
                    maxNodeNumber={twin.maxNodeNumber}
                    scale={scale}
                    variety={variety}
                    selected={pinned?.stemId === stem.id}
                    selectedNodeId={pinned?.stemId === stem.id ? pinned.nodeId : null}
                    onNodeEnter={onNodeEnter}
                    onNodeLeave={onNodeLeave}
                    onNodeClick={onNodeClick}
                    onProblemClick={onProblemClick}
                  />
                </div>
              ))}
            </div>
          </div>

          {/* Floats over the plants only while something is pinned, so the plants get the full width. */}
          {pinnedStem && (
            <aside className={styles.details} aria-live="polite">
              {pinnedNode ? (
                <NodeDetails
                  node={pinnedNode}
                  stem={pinnedStem}
                  rowName={row.row_name}
                  onReview={() => reviewNode(pinnedStem, pinnedNode.id)}
                  onClose={() => setPinned({ stemId: pinnedStem.id, nodeId: null })}
                />
              ) : (
                <StemDetails
                  stem={pinnedStem}
                  rowName={row.row_name}
                  onReview={(nodeIds) => setReview({ stemId: pinnedStem.id, nodeIds })}
                  onClose={() => setPinned(null)}
                />
              )}
            </aside>
          )}
        </div>
      )}

      {review && row && plants.data && (
        <ReviewPanel
          key={review.nodeIds.join()}
          rowName={row.row_name}
          stemName={plants.data.stems.find((s) => s.id === review.stemId)?.stem_name ?? ''}
          nodeIds={review.nodeIds}
          rowNodes={plants.data.nodes}
          missingNumbers={twin?.stems.find((s) => s.id === review.stemId)?.missingNumbers ?? []}
          onClose={closeReview}
        />
      )}

      {hover && (
        <div className={styles.tooltip} style={{ left: hover.x + 14, top: hover.y + 14 }} role="tooltip">
          <NodeFacts node={hover.node} stem={hover.stem} rowName={row?.row_name ?? ''} />
        </div>
      )}
    </section>
  )
}

const allNodes = (stem: TwinStem) => [...stem.mainNodes, ...stem.branches.flatMap((b) => b.nodes)]
const problemFor = (stem: TwinStem, nodeId: string) => stem.problems.find((p) => p.nodeIds.includes(nodeId))

function summarize(stems: TwinStem[]) {
  const on: Record<string, number> = { Flower: 0, SetFruit: 0, MatureGreen: 0, BreakerFruit: 0 }
  let mainNodes = 0
  let shoots = 0
  let stale = 0
  let duplicates = 0
  for (const s of stems) {
    mainNodes += s.mainNodes.length
    shoots += s.shootCount
    duplicates += s.problems.length
    for (const n of allNodes(s)) {
      if (n.category === 'on_plant' && n.status) on[n.status] += 1
      if (n.stale) stale += 1
    }
  }
  return { stems: stems.length, mainNodes, shoots, on, stale, duplicates }
}

const weekLabel = (n: TwinNode) => (n.statusWeek ? `W${n.statusWeek} ${n.statusYear}` : '—')

function NodeFacts({ node, stem, rowName }: { node: TwinNode; stem: TwinStem; rowName: string }) {
  return (
    <dl className={styles.facts}>
      <dt>Row</dt>
      <dd>{rowName}</dd>
      <dt>Stem</dt>
      <dd>{stem.name}</dd>
      <dt>Node</dt>
      <dd>{node.isShoot ? `${node.label} (side shoot of node ${node.nodeNumber}, ${node.side})` : `${node.label} (main stem)`}</dd>
      <dt>Status</dt>
      <dd>{node.status ? STATUS_NAMES[node.status] : 'No observation recorded'}</dd>
      <dt>Last observed</dt>
      <dd>
        {weekLabel(node)}
        {node.observedAt && <span className={styles.muted}> · {new Date(node.observedAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}</span>}
      </dd>
      {node.stale && (
        <dd className={styles.staleNote}>
          Status last updated W{node.statusWeek}, {node.weeksSinceUpdate} weeks ago — it may be stale.
        </dd>
      )}
      {node.duplicate && (
        <dd className={styles.warnNote}>
          {node.isShoot
            ? `${node.duplicate.count} side-shoot records share label ${node.label} on this node (shown side by side).`
            : `${node.duplicate.count} node records share number ${node.nodeNumber} on this stem (shown side by side).`}{' '}
          This is usually a numbering mistake in the collector. Click ⚠ to review them.
        </dd>
      )}
    </dl>
  )
}

function NodeDetails({
  node,
  stem,
  rowName,
  onReview,
  onClose,
}: {
  node: TwinNode
  stem: TwinStem
  rowName: string
  onReview: () => void
  onClose: () => void
}) {
  return (
    <div>
      <div className={styles.detailsHead}>
        <h3>
          {stem.name} · node {node.label}
        </h3>
        <button type="button" className={styles.linkButton} onClick={onClose}>
          Stem details
        </button>
      </div>
      <NodeFacts node={node} stem={stem} rowName={rowName} />
      <button type="button" className={`button button-secondary ${styles.reviewButton}`} onClick={onReview}>
        Review records…
      </button>
    </div>
  )
}

function StemDetails({
  stem,
  rowName,
  onReview,
  onClose,
}: {
  stem: TwinStem
  rowName: string
  onReview: (nodeIds: string[]) => void
  onClose: () => void
}) {
  const nodes = allNodes(stem)
  const count = (s: string) => nodes.filter((n) => n.status === s).length
  return (
    <div>
      <div className={styles.detailsHead}>
        <h3>
          {rowName} · {stem.name}
        </h3>
        <button type="button" className={styles.linkButton} onClick={onClose}>
          Close
        </button>
      </div>
      <dl className={styles.facts}>
        <dt>Main stem</dt>
        <dd>
          {stem.mainNodes.length} nodes, highest node {stem.maxNodeNumber}
        </dd>
        <dt>Side shoots</dt>
        <dd>{stem.shootCount}</dd>
        <dt>On the plant</dt>
        <dd>
          {count('Flower')} flowers · {count('SetFruit')} set · {count('MatureGreen')} mature green · {count('BreakerFruit')} breaker
        </dd>
        <dt>Resolved</dt>
        <dd>
          {count('Harvested')} harvested · {count('Aborted')} aborted · {count('Pruned')} pruned
        </dd>
        {stem.missingNumbers.length > 0 && (
          <>
            <dt>Missing numbers</dt>
            <dd>{stem.missingNumbers.join(', ')}</dd>
          </>
        )}
        {stem.problems.length > 0 && (
          <>
            <dt>Duplicated</dt>
            <dd className={styles.warnNote}>
              {stem.problems.map((p) => (
                <button key={p.key} type="button" className={styles.problemLink} onClick={() => onReview(p.nodeIds)}>
                  {p.kind === 'main' ? `Node ${p.label}` : `Shoot ${p.label}`}: {p.nodeIds.length} records — review
                </button>
              ))}
            </dd>
          </>
        )}
      </dl>
      <h4 className={styles.subhead}>Growth readings</h4>
      {stem.growth.length === 0 && stem.unplacedGrowth.length === 0 ? (
        <p className={styles.muted}>No growth readings for this stem.</p>
      ) : (
        <ul className={styles.readings}>
          {[...stem.growth].reverse().map((g) => (
            <li key={g.id} className={g.latest ? styles.latestReading : undefined}>
              W{g.week}: {g.cm.toFixed(1)} cm · {g.fromNode === g.toNode ? `node ${g.toNode}` : `nodes ${g.fromNode}→${g.toNode}`}
              {g.notes && <span className={styles.muted}> — “{g.notes}”</span>}
            </li>
          ))}
          {[...stem.unplacedGrowth].reverse().map((g) => (
            <li key={g.id} className={styles.muted}>
              W{g.week}: {g.cm.toFixed(1)} cm · position unknown (no top node recorded)
              {g.notes && <> — “{g.notes}”</>}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

