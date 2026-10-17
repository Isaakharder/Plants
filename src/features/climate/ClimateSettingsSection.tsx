// Settings › Climate: the climate computer, the zones discovered from its
// exports (friendly names editable; the source label never changes), which
// plantings use each zone, and the agent's upload keys.

import { useState } from 'react'
import { Dialog } from '../../components/Dialog'
import { ErrorState, LoadingState } from '../../components/States'
import type { ClimateAgentKeyRow, ClimateZoneRow } from '../../lib/database.types'
import { useCrops } from '../crops/api'
import { useOrganization } from '../organization/OrganizationProvider'
import shared from '../attentionRules/AttentionRulesSection.module.css'
import {
  agentServerUrl,
  useAgentKeys,
  useClimateSource,
  useClimateZones,
  useCreateAgentKey,
  useCreateClimateSource,
  useRenameZone,
  useRevokeAgentKey,
  useZoneUse,
} from './api'
import { formatLocalHour, sortZones } from './model'
import { todayIso } from '../../lib/dates'
import { useNow } from './useNow'
import styles from './Climate.module.css'

export function ClimateSettingsSection() {
  const organization = useOrganization()
  const owner = organization.role === 'owner'
  const source = useClimateSource(organization.id)
  const create = useCreateClimateSource(organization.id)

  return (
    <section id="climate" className={shared.section} aria-labelledby="climate-settings-heading">
      <div>
        <h2 id="climate-settings-heading" className={shared.title}>Climate</h2>
        <p className={shared.description}>
          Hourly climate data from the climate computer (Ridder Synopta “Block Summary” exports), sent by the GrowLink agent or imported by hand. Zones are
          discovered from the exports; link them to plantings on each variety’s page.
        </p>
      </div>
      {source.isPending ? (
        <LoadingState />
      ) : source.error ? (
        <ErrorState error={source.error} />
      ) : !source.data ? (
        owner ? (
          <div className={styles.actions} style={{ justifyContent: 'flex-start' }}>
            <button type="button" className="button button-primary" disabled={create.isPending} onClick={() => create.mutate('Synopta')}>
              {create.isPending ? 'Setting up…' : 'Set up climate data'}
            </button>
            {create.error && <p className="field-error">{create.error.message}</p>}
          </div>
        ) : (
          <p className={styles.muted}>Not set up yet. An owner can set it up here.</p>
        )
      ) : (
        <>
          <Zones sourceId={source.data.id} canEdit={owner} />
          {owner && <AgentKeys sourceId={source.data.id} />}
        </>
      )}
    </section>
  )
}

function Zones({ sourceId, canEdit }: { sourceId: string; canEdit: boolean }) {
  const organization = useOrganization()
  const zones = useClimateZones(sourceId)
  const use = useZoneUse(organization.id)
  const crops = useCrops(organization.id)
  const today = todayIso()
  const cropName = new Map((crops.data ?? []).map((c) => [c.id, c.name]))
  const usedBy = (zoneId: string) =>
    [...new Set((use.data ?? []).filter((u) => u.zone_id === zoneId && u.valid_from <= today && (u.valid_until === null || u.valid_until > today)).map((u) => cropName.get(u.crop_id) ?? '?'))]

  if (zones.isPending) return <LoadingState />
  if (zones.error) return <ErrorState error={zones.error} />
  const list = sortZones(zones.data)
  return (
    <div className={styles.card}>
      <h3 className={styles.chartTitle}>Zones ({list.length})</h3>
      {list.length === 0 ? (
        <p className={styles.empty}>No zones yet: they appear with the first imported file.</p>
      ) : (
        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th>Zone</th>
                <th className={styles.left}>Name</th>
                <th className={styles.left}>Used by today</th>
                <th className={styles.hideNarrow}>Last data</th>
              </tr>
            </thead>
            <tbody>
              {list.map((z) => (
                <tr key={z.id}>
                  <td title="Label in the climate computer’s export (the zone’s identifier)">{z.source_label}</td>
                  <td className={styles.left}>{canEdit ? <ZoneName zone={z} sourceId={sourceId} /> : (z.display_name ?? <span className={styles.muted}>—</span>)}</td>
                  <td className={`${styles.left} ${styles.small}`}>{usedBy(z.id).join(', ') || <span className={styles.muted}>—</span>}</td>
                  <td className={`${styles.hideNarrow} ${styles.small}`}>{z.last_seen_hour ? formatLocalHour(Date.parse(z.last_seen_hour) / 1000) : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

function ZoneName({ zone, sourceId }: { zone: ClimateZoneRow; sourceId: string }) {
  const [value, setValue] = useState(zone.display_name ?? '')
  const rename = useRenameZone(sourceId)
  const save = () => {
    if (value.trim() !== (zone.display_name ?? '')) rename.mutate({ zoneId: zone.id, name: value })
  }
  return (
    <input
      className={`input ${styles.nameInput}`}
      value={value}
      maxLength={100}
      placeholder="Friendly name (optional)"
      aria-label={`Name for ${zone.source_label}`}
      disabled={rename.isPending}
      onChange={(e) => setValue(e.target.value)}
      onBlur={save}
      onKeyDown={(e) => {
        if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
        if (e.key === 'Escape') setValue(zone.display_name ?? '')
      }}
      title={rename.error?.message}
    />
  )
}

function AgentKeys({ sourceId }: { sourceId: string }) {
  const keys = useAgentKeys(sourceId)
  const create = useCreateAgentKey(sourceId)
  const revoke = useRevokeAgentKey(sourceId)
  const [creating, setCreating] = useState(false)
  const [label, setLabel] = useState('Climate PC')
  const [expires, setExpires] = useState('')
  const [shown, setShown] = useState<{ key: string; label: string } | null>(null)
  const [confirm, setConfirm] = useState<ClimateAgentKeyRow | null>(null)
  const [copied, setCopied] = useState(false)
  const now = useNow()

  const status = (k: ClimateAgentKeyRow) =>
    k.revoked_at ? 'Revoked' : k.expires_at && Date.parse(k.expires_at) < now ? 'Expired' : 'Active'

  return (
    <div className={styles.card}>
      <div className={styles.sectionHead}>
        <h3 className={styles.chartTitle}>Agent upload keys</h3>
        <button type="button" className="button button-secondary" onClick={() => setCreating(true)}>
          Create key…
        </button>
      </div>
      <p className={`${styles.small} ${styles.muted}`}>
        In the agent’s Synopta tab, set the server URL to <span className={styles.mono}>{agentServerUrl}</span> and paste a key. A key can only upload climate files.
        To rotate: create a new key, paste it into the agent and press Test, then revoke the old one.
      </p>
      {keys.isPending ? (
        <LoadingState />
      ) : keys.error ? (
        <ErrorState error={keys.error} />
      ) : keys.data.length === 0 ? (
        <p className={styles.empty}>No keys yet.</p>
      ) : (
        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th>Label</th>
                <th className={styles.left}>Key</th>
                <th className={styles.left}>Status</th>
                <th className={styles.hideNarrow}>Last used</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {keys.data.map((k) => (
                <tr key={k.id}>
                  <td>{k.label}</td>
                  <td className={`${styles.left} ${styles.mono}`}>plk_{k.key_prefix}_…</td>
                  <td className={styles.left}>
                    {status(k)}
                    {k.expires_at && !k.revoked_at && <span className={styles.range}>until {new Date(k.expires_at).toLocaleDateString()}</span>}
                  </td>
                  <td className={styles.hideNarrow}>{k.last_used_at ? new Date(k.last_used_at).toLocaleString() : 'never'}</td>
                  <td>
                    {!k.revoked_at && (
                      <button type="button" className="button button-danger-outline" onClick={() => setConfirm(k)}>
                        Revoke
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <Dialog open={creating} title="Create an agent upload key" onClose={() => setCreating(false)}>
        <form
          className={styles.form}
          onSubmit={(e) => {
            e.preventDefault()
            create.mutate(
              { label: label.trim(), expiresAt: expires ? new Date(`${expires}T23:59:59`).toISOString() : null },
              {
                onSuccess: (r) => {
                  setCreating(false)
                  setCopied(false)
                  setShown({ key: r.key, label: label.trim() })
                },
              },
            )
          }}
        >
          <label className="field">
            <span className="field-label">Label</span>
            <input className="input" value={label} maxLength={100} required onChange={(e) => setLabel(e.target.value)} />
          </label>
          <label className="field">
            <span className="field-label">Expires (optional)</span>
            <input className="input" type="date" value={expires} min={todayIso()} onChange={(e) => setExpires(e.target.value)} />
          </label>
          {create.error && <p className="field-error">{create.error.message}</p>}
          <div className={styles.actions}>
            <button type="button" className="button button-secondary" onClick={() => setCreating(false)}>
              Cancel
            </button>
            <button type="submit" className="button button-primary" disabled={create.isPending || !label.trim()}>
              Create key
            </button>
          </div>
        </form>
      </Dialog>

      <Dialog open={shown !== null} title="Copy the new key now" onClose={() => setShown(null)}>
        <div className={styles.form}>
          <p className={styles.small}>
            This is the only time the key is shown; Plants keeps only a fingerprint of it. Paste it into the agent’s Synopta tab ({shown?.label}).
          </p>
          <div className={`${styles.keyBox} ${styles.mono}`}>{shown?.key}</div>
          <div className={styles.actions}>
            <button
              type="button"
              className="button button-secondary"
              onClick={() => {
                if (shown) void navigator.clipboard?.writeText(shown.key).then(() => setCopied(true))
              }}
            >
              {copied ? 'Copied' : 'Copy'}
            </button>
            <button type="button" className="button button-primary" onClick={() => setShown(null)}>
              Done
            </button>
          </div>
        </div>
      </Dialog>

      <Dialog open={confirm !== null} title="Revoke this key?" onClose={() => setConfirm(null)}>
        <div className={styles.form}>
          <p className={styles.small}>
            “{confirm?.label}” stops working immediately: the agent’s uploads with it are refused (its files stay in its folder and can be sent again with a new key).
          </p>
          {revoke.error && <p className="field-error">{revoke.error.message}</p>}
          <div className={styles.actions}>
            <button type="button" className="button button-secondary" onClick={() => setConfirm(null)}>
              Cancel
            </button>
            <button
              type="button"
              className="button button-danger"
              disabled={revoke.isPending}
              onClick={() => confirm && revoke.mutate(confirm.id, { onSuccess: () => setConfirm(null) })}
            >
              Revoke
            </button>
          </div>
        </div>
      </Dialog>
    </div>
  )
}
