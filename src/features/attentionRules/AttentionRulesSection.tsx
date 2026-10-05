import { useState } from 'react'
import { ErrorState, LoadingState } from '../../components/States'
import { DEFAULT_ATTENTION_RULES, RULE_KEYS, type AttentionRules } from '../collector/attention'
import { useOrganization } from '../organization/OrganizationProvider'
import { useAttentionRuleSettings, useSaveAttentionRules } from './api'
import { MAX_DAYS, MIN_DAYS, RULE_LABELS, draftFromRules, sameDraft, validateDraft, type RuleDraft } from './model'
import styles from './AttentionRulesSection.module.css'

/** Settings › Mobile attention rules: when the collector's clock shows on a node. */
export function AttentionRulesSection() {
  const organization = useOrganization()
  const query = useAttentionRuleSettings(organization.id)
  // Kept here: saving reloads the rules, which starts the form afresh.
  const [saved, setSaved] = useState(false)
  return (
    <section className={styles.section} aria-labelledby="attention-rules-heading">
      <div>
        <h2 id="attention-rules-heading" className={styles.title}>Mobile attention rules</h2>
        <p className={styles.description}>
          The mobile collector shows a clock 🕒 on a node that hasn’t been updated within these days of its latest status. “No status yet” counts from
          when a node was added, until its first status is recorded. Harvested, Aborted and Pruned nodes never show it.
        </p>
      </div>
      {query.isPending ? (
        <LoadingState />
      ) : query.error ? (
        <ErrorState error={query.error} />
      ) : (
        // Re-mounted when the saved rules change, so the form starts from them.
        <RulesForm
          key={JSON.stringify(query.data)}
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

function RulesForm({
  organizationId,
  saved,
  canEdit,
  justSaved,
  onSavedChange,
}: {
  organizationId: string
  saved: AttentionRules
  canEdit: boolean
  justSaved: boolean
  onSavedChange: (saved: boolean) => void
}) {
  const initial = draftFromRules(saved)
  const [draft, setDraft] = useState<RuleDraft>(initial)
  const save = useSaveAttentionRules(organizationId)
  const errors = validateDraft(draft)
  const invalid = Object.keys(errors).length > 0
  const unchanged = sameDraft(draft, initial)

  return (
    <form
      className={styles.card}
      onSubmit={(e) => {
        e.preventDefault()
        if (!invalid && !unchanged) save.mutate(draft, { onSuccess: () => onSavedChange(true) })
      }}
    >
      <p className={styles.lead}>Show the mobile 🕒 attention indicator when a node has not been updated within:</p>
      <div className={styles.rules}>
        {RULE_KEYS.map((s) => (
          <label key={s} className={styles.rule}>
            <span className={styles.ruleLabel}>{RULE_LABELS[s]}</span>
            <span className={styles.days}>
              <input
                className="input"
                inputMode="numeric"
                value={draft[s]}
                disabled={!canEdit || save.isPending}
                aria-invalid={Boolean(errors[s])}
                aria-describedby={errors[s] ? `rule-${s}-error` : undefined}
                onChange={(e) => {
                  onSavedChange(false)
                  setDraft({ ...draft, [s]: e.target.value })
                }}
              />
              <span>days</span>
            </span>
            {errors[s] && (
              <span id={`rule-${s}-error`} className="field-error">
                {errors[s]}
              </span>
            )}
          </label>
        ))}
      </div>
      {save.error && (
        <p className="field-error" role="alert">
          Couldn’t save: {save.error.message}
        </p>
      )}
      {canEdit ? (
        <div className={styles.actions}>
          <button type="submit" className="button button-primary" disabled={invalid || unchanged || save.isPending}>
            {save.isPending ? 'Saving…' : 'Save rules'}
          </button>
          <button
            type="button"
            className="button button-secondary"
            disabled={save.isPending || sameDraft(draft, draftFromRules(DEFAULT_ATTENTION_RULES))}
            onClick={() => {
              onSavedChange(false)
              setDraft(draftFromRules(DEFAULT_ATTENTION_RULES))
            }}
          >
            Use defaults (7 · 7 · 14 · 49 · 14)
          </button>
          {justSaved && unchanged && (
            <span className={styles.saved} role="status">
              Saved. Phones pick this up the next time they sync.
            </span>
          )}
        </div>
      ) : (
        <p className={styles.note}>Only an organization owner can change these.</p>
      )}
      <p className={styles.note}>
        Whole days, {MIN_DAYS}–{MAX_DAYS}. Applies to every variety. Separate from the Plants page’s “possibly stale” warning.
      </p>
    </form>
  )
}
