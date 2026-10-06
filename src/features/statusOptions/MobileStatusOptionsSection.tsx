import { useState } from 'react'
import { ErrorState, LoadingState } from '../../components/States'
import { ALL_STATUSES, STATUS_OPTIONS, type EnabledStatuses } from '../collector/statusOptions'
import { useOrganization } from '../organization/OrganizationProvider'
import { useMobileStatusOptionSettings, useSaveMobileStatusOptions } from './api'
import { draftFromEnabled, sameStatusDraft, validateStatusDraft, type StatusDraft } from './model'
import shared from '../attentionRules/AttentionRulesSection.module.css'
import styles from './MobileStatusOptionsSection.module.css'

/** Settings › Mobile status options: which statuses the collector offers for new entries. */
export function MobileStatusOptionsSection() {
  const organization = useOrganization()
  const query = useMobileStatusOptionSettings(organization.id)
  // Kept here: saving reloads the options, which starts the form afresh.
  const [saved, setSaved] = useState(false)
  return (
    <section className={shared.section} aria-labelledby="mobile-status-options-heading">
      <div>
        <h2 id="mobile-status-options-heading" className={shared.title}>Mobile status options</h2>
        <p className={shared.description}>
          Choose which statuses are available when recording plant nodes in the mobile collector. Hiding a status does not remove or change historical data.
        </p>
      </div>
      {query.isPending ? (
        <LoadingState />
      ) : query.error ? (
        <ErrorState error={query.error} />
      ) : (
        <OptionsForm
          key={query.data.join(',')}
          organizationId={organization.id}
          saved={query.data}
          canEdit={organization.role === 'owner'}
          justSaved={saved}
          onSavedChange={setSaved}
        />
      )}
    </section>
  )
}

function OptionsForm({
  organizationId,
  saved,
  canEdit,
  justSaved,
  onSavedChange,
}: {
  organizationId: string
  saved: EnabledStatuses
  canEdit: boolean
  justSaved: boolean
  onSavedChange: (saved: boolean) => void
}) {
  const initial = draftFromEnabled(saved)
  const [draft, setDraft] = useState<StatusDraft>(initial)
  const save = useSaveMobileStatusOptions(organizationId)
  const error = validateStatusDraft(draft)
  const unchanged = sameStatusDraft(draft, initial)
  const all = draftFromEnabled(ALL_STATUSES)

  return (
    <form
      className={shared.card}
      onSubmit={(e) => {
        e.preventDefault()
        if (!error && !unchanged) save.mutate(draft, { onSuccess: () => onSavedChange(true) })
      }}
    >
      <p className={shared.lead}>Offer these statuses when recording a node:</p>
      <div className={styles.options}>
        {STATUS_OPTIONS.map((o) => (
          <label key={o.value} className={styles.option}>
            <input
              type="checkbox"
              checked={draft[o.value]}
              disabled={!canEdit || save.isPending}
              onChange={(e) => {
                onSavedChange(false)
                setDraft({ ...draft, [o.value]: e.target.checked })
              }}
            />
            <span>{o.label}</span>
          </label>
        ))}
      </div>
      {error && (
        <p className="field-error" role="alert">
          {error}
        </p>
      )}
      {save.error && (
        <p className="field-error" role="alert">
          Couldn’t save: {save.error.message}
        </p>
      )}
      {canEdit ? (
        <div className={shared.actions}>
          <button type="submit" className="button button-primary" disabled={Boolean(error) || unchanged || save.isPending}>
            {save.isPending ? 'Saving…' : 'Save status options'}
          </button>
          <button
            type="button"
            className="button button-secondary"
            disabled={save.isPending || sameStatusDraft(draft, all)}
            onClick={() => {
              onSavedChange(false)
              setDraft(all)
            }}
          >
            Show all
          </button>
          {justSaved && unchanged && (
            <span className={shared.saved} role="status">
              Saved. Phones pick this up the next time they sync.
            </span>
          )}
        </div>
      ) : (
        <p className={shared.note}>Only an organization owner can change these.</p>
      )}
      <p className={shared.note}>
        Only new entries are affected. Nodes keep any status already recorded, and every status still counts on the Plants page and in Projections.
      </p>
    </form>
  )
}
