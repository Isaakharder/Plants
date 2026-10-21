import { describe, expect, it } from 'vitest'
import { importMessage, importSummary, issueText } from './importMessages'

const matched = { file_id: 'f0', filename: 'Block Summary_20261017_080003.csv', received_at: '2026-10-17T12:01:00Z', hour_local: '2026-10-17 08:00:00', file_status: 'active', channel: 'manual' }

describe('import messages', () => {
  it('names the stored file for duplicates, by bytes or by readings', () => {
    expect(importMessage({ status: 'duplicate', reason: 'same_bytes', matched })).toBe(
      'Already imported: this exact file is “Block Summary_20261017_080003.csv”, imported Oct 17, 08:01 (2026-10-17 08:00). Nothing new was added.',
    )
    expect(importMessage({ status: 'duplicate', reason: 'same_readings', matched })).toContain('the same readings for 2026-10-17 08:00 are in “Block Summary_20261017_080003.csv”')
  })

  it('explains a conflict and a copy of another hour', () => {
    expect(importMessage({ status: 'conflict', reason: 'different_readings_same_hour', matched, hour_local: '2026-10-17 08:00:00' })).toContain(
      'already has a different file (“Block Summary_20261017_080003.csv”',
    )
    expect(importMessage({ status: 'quarantined', reason: 'same_readings_as_other_hour', matched })).toContain('identical to the 2026-10-17 08:00 file')
  })

  it('turns problem codes into words, and still answers for older responses without a match', () => {
    expect(importMessage({ status: 'quarantined', problems: ['system_time_mismatch'] })).toContain('renamed copy of another hour')
    expect(importMessage({ status: 'duplicate', hour_local: '2026-10-17 08:00:00' })).toBe('Already imported (2026-10-17 08:00). Nothing new was added.')
    expect(issueText('something_new')).toBe('something_new')
  })

  it('summarises a batch', () => {
    expect(importSummary([{ status: 'created' }, { status: 'duplicate' }, { status: 'duplicate' }, { status: 'conflict' }, { status: 'quarantined' }])).toBe(
      '1 imported · 2 already imported · 2 held for review',
    )
  })
})
