// Harvests: the grower records which greenhouse rows of a variety were
// harvested and when; employees then inspect the sampled stems in those rows
// (collector). This page shows each harvest's inspection, which harvested fruit
// it can be linked to (inferred / confirmed), and what is on each sampled stem
// now. Read-only towards the forecast: nothing here changes a projection.

import { useMemo, useRef, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { PageHeader } from '../../components/PageHeader'
import { EmptyState, ErrorState, LoadingState } from '../../components/States'
import type { FruitHarvestLinkRow, HarvestEventInEffect, InspectionStemRow } from '../../lib/database.types'
import { useCrops } from '../crops/api'
import { cropStatus, sortCrops, type Crop } from '../crops/model'
import { useAuth } from '../auth/AuthProvider'
import { useOrganization } from '../organization/OrganizationProvider'
import {
  useHarvestEvents,
  useHarvestLinks,
  useHarvestVersions,
  useInspectionStems,
  useNodeLabels,
  useOrganizationRows,
  useRecordHarvest,
  useReviewLink,
  useStemInventory,
  useWorkflowFrom,
} from './api'
import { checkRanges, dayLabel, earliestEditable, editableUntil, greenhouseToday, hasHarvestDate, LINK_TEXT, rangesLabel, type RangeDraft, type RowRef } from './model'
import styles from './Harvests.module.css'

const WHEN = new Intl.DateTimeFormat('en-US', { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', timeZone: 'America/Toronto' })
const whenLabel = (iso: string) => WHEN.format(new Date(iso))
const percent = (v: number) => `${v.toLocaleString('en-US', { maximumFractionDigits: 1 })}%`

export function HarvestsPage() {
  const organization = useOrganization()
  const crops = useCrops(organization.id)
  const rows = useOrganizationRows(organization.id)
  const [params, setParams] = useSearchParams()
  const varieties = useMemo(() => {
    const all = sortCrops(crops.data ?? [])
    return [...all.filter((c) => cropStatus(c) === 'active'), ...all.filter((c) => cropStatus(c) !== 'active')]
  }, [crops.data])
  const memoryKey = `plants.harvests.variety:${organization.id}`
  const remembered = (() => {
    try {
      return localStorage.getItem(memoryKey)
    } catch {
      return null
    }
  })()
  const wanted = params.get('crop') ?? remembered
  const crop = varieties.find((c) => c.id === wanted) ?? varieties[0] ?? null
  const choose = (id: string) => {
    try {
      localStorage.setItem(memoryKey, id)
    } catch {
      // not remembered
    }
    setParams((p) => { const next = new URLSearchParams(p); next.set('crop', id); next.delete('harvest'); return next }, { replace: true })
  }

  let body
  if (crops.isPending || rows.isPending) body = <LoadingState />
  else if (crops.error || rows.error) body = <ErrorState error={crops.error ?? rows.error} />
  else if (!crop) body = <EmptyState title="No varieties yet" description="Add a variety in Settings first." />
  else body = <VarietyHarvests key={crop.id} crop={crop} crops={varieties} rows={rows.data!} />

  return (
    <div className={styles.page}>
      <PageHeader
        title="Harvests"
        description="Record which rows were harvested. Employees then inspect the sampled stems in those rows on the phone."
      />
      {varieties.length > 0 && (
        <div className={styles.controls}>
          <select className="input" value={crop?.id ?? ''} onChange={(e) => choose(e.target.value)} aria-label="Variety">
            {varieties.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
                {cropStatus(c) === 'active' ? '' : ' (not growing)'}
              </option>
            ))}
          </select>
        </div>
      )}
      {body}
    </div>
  )
}

function VarietyHarvests({ crop, crops, rows }: { crop: Crop; crops: Crop[]; rows: RowRef[] }) {
  const organization = useOrganization()
  const [params, setParams] = useSearchParams()
  const events = useHarvestEvents(organization.id, crop.id)
  const inspections = useInspectionStems(crop.id)
  const links = useHarvestLinks(crop.id)
  const workflowFrom = useWorkflowFrom(crop.id)
  const [editing, setEditing] = useState<HarvestEventInEffect | 'new' | null>(null)
  const selectedId = params.get('harvest')
  const select = (id: string | null) =>
    setParams((p) => { const next = new URLSearchParams(p); if (id) next.set('harvest', id); else next.delete('harvest'); return next }, { replace: true })
  const selected = events.data?.find((e) => e.event_id === selectedId) ?? null
  const ownRows = rows.filter((r) => r.crop_id === crop.id)

  return (
    <>
      {workflowFrom.data != null && (
        <div className={styles.notice} role="status">
          {crop.name} uses post-harvest inspections from {Math.floor(workflowFrom.data / 100)}-W{String(workflowFrom.data % 100).padStart(2, '0')}. Official
          forecasts are not locked for those weeks until the forecast method is reviewed for post-harvest counts. Previews still work, and forecasts already
          locked are unchanged.
        </div>
      )}

      {editing ? (
        <HarvestForm crop={crop} crops={crops} rows={rows} editing={editing === 'new' ? null : editing} onDone={(id) => { setEditing(null); if (id) select(id) }} />
      ) : (
        <div className={styles.controls}>
          <button type="button" className="button button-primary" onClick={() => setEditing('new')} disabled={ownRows.length === 0}>
            Record a harvest
          </button>
          {ownRows.length === 0 && <span className={`${styles.small} ${styles.muted}`}>{crop.name} has no sampled rows yet.</span>}
        </div>
      )}

      <section className={styles.card} aria-label="Harvests">
        <h2 className={styles.cardTitle}>Harvests of {crop.name}</h2>
        {events.isPending ? (
          <LoadingState />
        ) : events.error ? (
          <ErrorState error={events.error} />
        ) : events.data.length === 0 ? (
          <p className={`${styles.small} ${styles.muted}`}>No harvests recorded for {crop.name} yet.</p>
        ) : (
          <HarvestTable
            events={events.data}
            inspections={inspections.data ?? []}
            links={links.data ?? []}
            selectedId={selectedId}
            onSelect={(id) => select(id === selectedId ? null : id)}
          />
        )}
      </section>

      {selected && (
        <HarvestDetail
          key={selected.event_id}
          crop={crop}
          event={selected}
          events={events.data ?? []}
          inspections={(inspections.data ?? []).filter((i) => i.event_id === selected.event_id)}
          links={(links.data ?? []).filter((l) => l.inspection_event_id === selected.event_id || l.candidate_event_ids.includes(selected.event_id))}
          onCorrect={() => setEditing(selected)}
        />
      )}

      <Inventory crop={crop} events={events.data ?? []} />
    </>
  )
}

// ── Recording / correcting ───────────────────────────────────────────────────

function HarvestForm({ crop, crops, rows, editing, onDone }: { crop: Crop; crops: Crop[]; rows: RowRef[]; editing: HarvestEventInEffect | null; onDone: (eventId: string | null) => void }) {
  const organization = useOrganization()
  const save = useRecordHarvest(organization.id)
  const today = greenhouseToday()
  const [date, setDate] = useState(editing?.harvest_date ?? today)
  const [colour, setColour] = useState(editing ? String(editing.min_colour_percent) : '')
  const [ranges, setRanges] = useState<RangeDraft[]>(
    editing ? editing.ranges.map((r) => ({ from: String(r.from), to: r.to === r.from ? '' : String(r.to), coverage: r.coverage })) : [{ from: '', to: '', coverage: 'complete' }],
  )
  const [kg, setKg] = useState(editing?.harvested_kg != null ? String(editing.harvested_kg) : '')
  const [note, setNote] = useState(editing ? '' : '')
  const [cancelling, setCancelling] = useState(false)
  // One id per attempt: a retry after a lost response returns the same version.
  const attempt = useRef<string>(crypto.randomUUID())

  const growing = useMemo(() => new Map(crops.filter((c) => c.planting_date <= date && date <= c.pullout_date).map((c) => [c.id, c.name])), [crops, date])
  const checked = checkRanges(ranges, crop.id, rows, growing)
  const colourValue = colour.trim() === '' ? NaN : Number(colour)
  const kgValue = kg.trim() === '' ? null : Number(kg)
  const problems = [
    ...(!date ? ['Enter the harvest date.'] : []),
    ...(date > today ? ['The harvest date is in the future.'] : []),
    ...(date && date < earliestEditable(today)
      ? [`Harvests can be entered or changed until 14 days after the harvest date: ${dayLabel(date)} was editable until ${dayLabel(editableUntil(date))}.`]
      : []),
    ...(date < crop.planting_date || date > crop.pullout_date ? [`${crop.name} grows from ${crop.planting_date} to ${crop.pullout_date}.`] : []),
    ...(!Number.isFinite(colourValue) || colourValue < 0 || colourValue > 100 ? ['Enter the minimum mature colour for picking (0–100%).'] : []),
    ...(kgValue !== null && (!Number.isFinite(kgValue) || kgValue < 0) ? ['Harvested kg must be a positive number.'] : []),
    ...checked.problems,
  ]
  const stems = checked.sampledRows.length

  const submit = (cancel: boolean) =>
    save.mutate(
      {
        id: attempt.current,
        cropId: crop.id,
        harvestDate: date,
        minColourPercent: colourValue,
        ranges: checked.ranges ?? [],
        harvestedKg: kgValue,
        note: note.trim() || null,
        replacesId: editing?.version_id ?? null,
        cancel,
      },
      {
        onSuccess: (r) => {
          attempt.current = crypto.randomUUID()
          onDone(r?.event_id ?? null)
        },
        onError: () => {
          attempt.current = crypto.randomUUID()
        },
      },
    )

  const setRange = (i: number, patch: Partial<RangeDraft>) => setRanges((list) => list.map((r, j) => (j === i ? { ...r, ...patch } : r)))

  return (
    <section className={styles.card} aria-label={editing ? 'Correct harvest' : 'Record a harvest'}>
      <h2 className={styles.cardTitle}>
        {editing ? `Correct the harvest of ${dayLabel(editing.harvest_date)}` : `Record a harvest of ${crop.name}`}
      </h2>
      {editing && (
        <p className={`${styles.small} ${styles.muted}`}>
          The correction is saved as a new version; what was recorded before stays in the history. Inspections already made stay linked to this harvest.
          It can be corrected or cancelled until {dayLabel(editing.editable_until)}.
        </p>
      )}
      <div className={styles.formGrid}>
        <label className={styles.field}>
          <span>Harvest date</span>
          <input className="input" type="date" value={date} min={earliestEditable(today)} max={today} onChange={(e) => setDate(e.target.value)} />
          <span className={styles.muted}>up to 14 days back</span>
        </label>
        <label className={styles.field}>
          <span>Minimum mature colour</span>
          <input className="input" type="number" inputMode="decimal" min={0} max={100} placeholder="e.g. 80" value={colour} onChange={(e) => setColour(e.target.value)} />
          <span className={styles.muted}>% the pickers aimed for</span>
        </label>
        <label className={styles.field}>
          <span>Harvested kg (optional)</span>
          <input className="input" type="number" inputMode="decimal" min={0} value={kg} onChange={(e) => setKg(e.target.value)} />
        </label>
      </div>

      <div className={styles.ranges}>
        <span className={styles.small}>
          <strong>Greenhouse rows harvested</strong> <span className={styles.muted}>(a single row: leave “to” empty)</span>
        </span>
        {ranges.map((r, i) => (
          <div key={i} className={styles.rangeRow}>
            <span>Rows</span>
            <input className="input" inputMode="numeric" aria-label={`Range ${i + 1} from`} placeholder="from" value={r.from} onChange={(e) => setRange(i, { from: e.target.value })} />
            <span>–</span>
            <input className="input" inputMode="numeric" aria-label={`Range ${i + 1} to`} placeholder="to" value={r.to} onChange={(e) => setRange(i, { to: e.target.value })} />
            <select className="input" aria-label={`Range ${i + 1} coverage`} value={r.coverage} onChange={(e) => setRange(i, { coverage: e.target.value as RangeDraft['coverage'] })}>
              <option value="complete">every plant picked</option>
              <option value="partial">only partly picked</option>
            </select>
            {ranges.length > 1 && (
              <button type="button" className="button button-link" onClick={() => setRanges((list) => list.filter((_, j) => j !== i))}>
                Remove
              </button>
            )}
          </div>
        ))}
        <div>
          <button type="button" className="button" onClick={() => setRanges((list) => [...list, { from: '', to: '', coverage: 'complete' }])} disabled={ranges.length >= 20}>
            + Add a range
          </button>
        </div>
      </div>

      <p className={styles.preview} aria-live="polite">
        {stems > 0 ? (
          <>
            Sampled rows to inspect: <strong>{checked.sampledRows.map((r) => `${r.row_name}${r.coverage === 'partial' ? ' (partial)' : ''}`).join(', ')}</strong>
          </>
        ) : checked.ranges ? (
          <span className={styles.muted}>No sampled row of {crop.name} in these ranges: the harvest is recorded for the calendar, with nothing to inspect.</span>
        ) : null}
        {checked.withoutSampledRows.length > 0 && stems > 0 && (
          <span className={styles.muted}> · {rangesLabel(checked.withoutSampledRows)}: no sampled rows</span>
        )}
      </p>

      <label className={styles.field}>
        <span>{cancelling ? 'Why is it cancelled?' : 'Note (optional)'}</span>
        <input className="input" maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} placeholder={editing ? 'What was corrected (kept in the history)' : ''} />
      </label>

      {problems.length > 0 && !cancelling && (
        <ul className={styles.problems}>
          {problems.map((p) => (
            <li key={p}>{p}</li>
          ))}
        </ul>
      )}
      {save.error && <p className={styles.problems}>Not saved: {save.error.message}</p>}

      <div className={styles.actions}>
        {cancelling ? (
          <>
            <button type="button" className="button button-danger" disabled={save.isPending || note.trim() === ''} onClick={() => submit(true)}>
              {save.isPending ? 'Cancelling…' : 'Cancel this harvest'}
            </button>
            <button type="button" className="button" onClick={() => setCancelling(false)} disabled={save.isPending}>
              Back
            </button>
          </>
        ) : (
          <>
            <button type="button" className="button button-primary" disabled={problems.length > 0 || save.isPending} onClick={() => submit(false)}>
              {save.isPending ? 'Saving…' : editing ? 'Save correction' : 'Save harvest'}
            </button>
            <button type="button" className="button" onClick={() => onDone(null)} disabled={save.isPending}>
              Close
            </button>
            {editing && (
              <button type="button" className="button button-danger-outline" onClick={() => setCancelling(true)} disabled={save.isPending}>
                Cancel this harvest…
              </button>
            )}
          </>
        )}
      </div>
    </section>
  )
}

// ── List ─────────────────────────────────────────────────────────────────────

function HarvestTable({
  events,
  inspections,
  links,
  selectedId,
  onSelect,
}: {
  events: HarvestEventInEffect[]
  inspections: InspectionStemRow[]
  links: FruitHarvestLinkRow[]
  selectedId: string | null
  onSelect: (id: string) => void
}) {
  return (
    <div className={styles.tableWrap}>
      <table className={styles.table}>
        <thead>
          <tr>
            <th>Date</th>
            <th>Rows</th>
            <th className={styles.num}>Min. colour</th>
            <th className={styles.num}>kg</th>
            <th>Sampled rows</th>
            <th>Inspection</th>
            <th>Harvested fruit</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {events.map((e) => {
            const stems = inspections.filter((i) => i.event_id === e.event_id)
            const complete = stems.filter((i) => i.state === 'complete').length
            const own = links.filter((l) => l.inspection_event_id === e.event_id)
            const dated = own.filter((l) => hasHarvestDate(l.link_status) && l.link_event_id === e.event_id).length
            return (
              <tr key={e.event_id} className={`${e.cancelled ? styles.cancelled : ''} ${e.event_id === selectedId ? styles.selected : ''}`}>
                <td>
                  {dayLabel(e.harvest_date)}
                  {!e.editable && !e.cancelled && <span className={styles.muted} title={`Read-only since ${dayLabel(e.editable_until)}`}> · locked</span>}
                </td>
                <td>{rangesLabel(e.ranges)}</td>
                <td className={styles.num}>≥ {percent(e.min_colour_percent)}</td>
                <td className={styles.num}>{e.harvested_kg != null ? e.harvested_kg.toLocaleString('en-US') : '—'}</td>
                <td>{e.sampled_rows.length ? e.sampled_rows.map((r) => r.row_name).join(', ') : <span className={styles.muted}>none</span>}</td>
                <td>
                  {e.cancelled ? (
                    <span className={styles.muted}>Cancelled: {e.note}</span>
                  ) : stems.length === 0 ? (
                    <span className={styles.muted}>nothing to inspect</span>
                  ) : (
                    <span className={`${styles.pill} ${complete === stems.length ? styles.pill_complete : complete > 0 ? styles.pill_in_progress : ''}`}>
                      {complete} of {stems.length} stems
                    </span>
                  )}
                </td>
                <td>{own.length ? `${own.length} · ${dated} dated` : <span className={styles.muted}>—</span>}</td>
                <td>
                  <button type="button" className="button button-link" onClick={() => onSelect(e.event_id)} aria-expanded={e.event_id === selectedId}>
                    {e.event_id === selectedId ? 'Hide' : 'Details'}
                  </button>
                  {e.versions > 1 && <span className={`${styles.small} ${styles.muted}`}> · {e.versions - 1} correction{e.versions > 2 ? 's' : ''}</span>}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

// ── One harvest: inspection, links, history ───────────────────────────────────

const STATE_TEXT: Record<InspectionStemRow['state'], string> = {
  complete: 'Complete',
  in_progress: 'In progress',
  not_started: 'Not started',
  retracted: 'Check taken back',
}

function HarvestDetail({
  crop,
  event,
  events,
  inspections,
  links,
  onCorrect,
}: {
  crop: Crop
  event: HarvestEventInEffect
  events: HarvestEventInEffect[]
  inspections: InspectionStemRow[]
  links: FruitHarvestLinkRow[]
  onCorrect: () => void
}) {
  const organization = useOrganization()
  const me = useAuth().session!.user.id
  const who = (id: string | null) => (id === me ? 'you' : 'another member')
  const labels = useNodeLabels(crop.id)
  const inventory = useStemInventory(crop.id)
  const versions = useHarvestVersions(event.event_id)
  const review = useReviewLink(organization.id, crop.id)
  const [note, setNote] = useState('')
  const stemName = new Map((inventory.data ?? []).map((s) => [s.measurement_stem_id, `${s.row_name} · ${s.stem_name}`]))
  const eventDay = new Map(events.map((e) => [e.event_id, dayLabel(e.harvest_date)]))
  const decide = (link: FruitHarvestLinkRow, decision: 'confirmed' | 'rejected' | 'unreviewed', eventId: string | null = null) =>
    review.mutate({ link, decision, eventId, note: note.trim() || null }, { onSuccess: () => setNote('') })

  return (
    <section className={styles.card} aria-label="Harvest details">
      <h2 className={styles.cardTitle}>
        {dayLabel(event.harvest_date)} · {rangesLabel(event.ranges)}
      </h2>
      <p className={`${styles.small} ${styles.muted}`}>
        Minimum colour aimed for: ≥ {percent(event.min_colour_percent)} (the pickers’ target, not a measurement of the picked fruit). Recorded{' '}
        {whenLabel(event.first_recorded_at)} by {who(event.first_recorded_by)}
        {event.versions > 1 && `, corrected ${event.versions - 1}×, last ${whenLabel(event.recorded_at)} by ${who(event.recorded_by)}`}.
        {event.note && !event.cancelled && ` Note: “${event.note}”`}
      </p>
      {event.editable ? (
        <div className={styles.actions}>
          <button type="button" className="button" onClick={onCorrect}>
            Correct or cancel…
          </button>
          <span className={`${styles.small} ${styles.muted}`}>until {dayLabel(event.editable_until)}</span>
        </div>
      ) : (
        !event.cancelled && (
          <p className={`${styles.small} ${styles.muted}`}>Read-only: harvests can be corrected or cancelled until 14 days after the harvest date ({dayLabel(event.editable_until)}).</p>
        )
      )}

      <h3 className={styles.cardTitle}>Post-harvest inspection</h3>
      {inspections.length === 0 ? (
        <p className={`${styles.small} ${styles.muted}`}>No sampled stems in these rows.</p>
      ) : (
        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th>Row · stem</th>
                <th>State</th>
                <th className={styles.num}>Fruit to confirm</th>
                <th className={styles.num}>Answered</th>
                <th className={styles.num}>Harvested</th>
                <th className={styles.num}>New</th>
                <th>Checked</th>
                <th>Notes</th>
              </tr>
            </thead>
            <tbody>
              {inspections.map((i) => (
                <tr key={i.measurement_stem_id}>
                  <td>
                    {i.row_name} · {i.stem_name}
                  </td>
                  <td>
                    <span className={`${styles.pill} ${styles[`pill_${i.state}`] ?? ''}`}>{STATE_TEXT[i.state]}</span>
                  </td>
                  <td className={styles.num}>{i.to_confirm}</td>
                  <td className={styles.num}>{i.answered}</td>
                  <td className={styles.num}>{i.harvested}</td>
                  <td className={styles.num}>{i.new_nodes}</td>
                  <td>{i.checked_at ? whenLabel(i.checked_at) : '—'}</td>
                  <td className={styles.small}>
                    {[
                      i.coverage === 'partial' ? 'row partly harvested: no dates inferred' : null,
                      i.later_harvest ? 'another harvest of this row before the check' : null,
                      i.unanswered > 0 && i.state !== 'not_started' ? `${i.unanswered} fruit not answered` : null,
                    ]
                      .filter(Boolean)
                      .join(' · ')}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <h3 className={styles.cardTitle}>Harvested fruit</h3>
      <p className={`${styles.small} ${styles.muted}`}>
        Inferred: the stem’s inspection is complete, its row was fully harvested, the fruit was on the plant before, and only this harvest could have taken it.
        Confirmed: a person confirmed the harvest. Original records are never changed.
      </p>
      {links.length === 0 ? (
        <p className={`${styles.small} ${styles.muted}`}>No harvested fruit recorded for this harvest yet.</p>
      ) : (
        <>
          <input className="input" value={note} maxLength={1000} onChange={(e) => setNote(e.target.value)} placeholder="Note for the next confirmation or rejection (optional)" />
          {review.error && <p className={styles.problems}>Not saved: {review.error.message}</p>}
          <div className={styles.tableWrap}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th>Fruit</th>
                  <th>Last seen on the plant</th>
                  <th>Recorded harvested</th>
                  <th>Link</th>
                  <th>Possible harvests</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {links.map((l) => (
                  <tr key={l.node_observation_id}>
                    <td>
                      {stemName.get(l.measurement_stem_id) ?? '—'} · {labels.data?.get(l.plant_node_id) ?? '…'}
                    </td>
                    <td>{l.last_on_plant_at ? `${whenLabel(l.last_on_plant_at)} (${l.last_on_plant_status === 'BreakerFruit' ? 'Breaker' : l.last_on_plant_status})` : '—'}</td>
                    <td>{whenLabel(l.harvested_at)}</td>
                    <td>
                      <span className={`${styles.pill} ${styles[`pill_${l.link_status}`] ?? ''}`}>{LINK_TEXT[l.link_status]}</span>
                      {l.harvest_date && <> {dayLabel(l.harvest_date)}</>}
                      {l.review_note && <div className={`${styles.small} ${styles.muted}`}>“{l.review_note}”</div>}
                    </td>
                    <td>{l.candidate_event_ids.map((id) => eventDay.get(id) ?? '?').join(', ') || '—'}</td>
                    <td>
                      <div className={styles.linkActions}>
                        {l.link_status === 'confirmed' || l.link_status === 'rejected' ? (
                          <button type="button" className="button" disabled={review.isPending} onClick={() => decide(l, 'unreviewed')}>
                            Reopen
                          </button>
                        ) : (
                          <>
                            {l.candidate_event_ids.map((id) => (
                              <button key={id} type="button" className="button" disabled={review.isPending} onClick={() => decide(l, 'confirmed', id)}>
                                Confirm {eventDay.get(id)}
                              </button>
                            ))}
                            <button type="button" className="button" disabled={review.isPending} onClick={() => decide(l, 'rejected')}>
                              Not harvested
                            </button>
                          </>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      {(versions.data?.length ?? 0) > 1 && (
        <details>
          <summary className={styles.small}>History ({versions.data!.length} versions)</summary>
          <ul className={`${styles.small} ${styles.muted}`}>
            {versions.data!.map((v) => (
              <li key={v.id}>
                {whenLabel(v.recorded_at)} by {who(v.recorded_by)}: {v.cancelled ? 'cancelled' : `${dayLabel(v.harvest_date)}`} ·{' '}
                {rangesLabel(v.ranges)} · ≥ {percent(v.min_colour_percent)}
                {v.harvested_kg != null && ` · ${v.harvested_kg} kg`}
                {v.note && ` — “${v.note}”`}
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  )
}

// ── Now on the sampled stems ─────────────────────────────────────────────────

function Inventory({ crop, events }: { crop: Crop; events: HarvestEventInEffect[] }) {
  const inventory = useStemInventory(crop.id)
  const eventDay = new Map(events.map((e) => [e.event_id, dayLabel(e.harvest_date)]))
  const totals = (inventory.data ?? []).reduce((t, s) => ({ set: t.set + s.set_fruit, mature: t.mature + s.mature_green, breakers: t.breakers + s.breakers }), { set: 0, mature: 0, breakers: 0 })
  return (
    <details className={styles.card}>
      <summary className={styles.small}>
        <strong>Now on the sampled stems</strong> · each stem’s latest records, whatever day they were made
        {inventory.data && ` · ${totals.breakers} Breakers, ${totals.mature} Mature Green, ${totals.set} Set Fruit`}
      </summary>
      <p className={`${styles.small} ${styles.muted}`}>For review only: forecasts don’t use this yet.</p>
      {inventory.isPending ? (
        <LoadingState />
      ) : inventory.error ? (
        <ErrorState error={inventory.error} />
      ) : (
        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th>Row · stem</th>
                <th className={styles.num}>Breakers</th>
                <th className={styles.num}>Mature Green</th>
                <th className={styles.num}>Set Fruit</th>
                <th>Latest record</th>
                <th>Latest complete inspection</th>
              </tr>
            </thead>
            <tbody>
              {inventory.data.map((s) => (
                <tr key={s.measurement_stem_id}>
                  <td>
                    {s.row_name} · {s.stem_name}
                  </td>
                  <td className={styles.num}>{s.breakers}</td>
                  <td className={styles.num}>{s.mature_green}</td>
                  <td className={styles.num}>{s.set_fruit}</td>
                  <td>{s.last_record_at ? whenLabel(s.last_record_at) : '—'}</td>
                  <td>{s.last_inspection_at ? `${whenLabel(s.last_inspection_at)} (harvest ${eventDay.get(s.last_inspection_event_id!) ?? '?'})` : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </details>
  )
}
