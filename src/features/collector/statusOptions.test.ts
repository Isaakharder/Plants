import { describe, expect, it } from 'vitest'
import { ALL_STATUSES, enabledFromRows, pickerOptions, statusOptionsOrDefaults } from './statusOptions'
import type { NodeStatus } from './types'

const rows = (hidden: NodeStatus[]) => ALL_STATUSES.map((status) => ({ status, enabled: !hidden.includes(status) }))
const values = (opts: ReturnType<typeof pickerOptions>) => opts.map((o) => o.value)
const OUR_CHOICE = enabledFromRows(rows(['Flower', 'MatureGreen']))

describe('mobile status options', () => {
  it('an organization with the seeded rows (all enabled) offers all seven statuses, in picker order', () => {
    expect(enabledFromRows(rows([]))).toEqual(['Aborted', 'Pruned', 'Flower', 'SetFruit', 'MatureGreen', 'BreakerFruit', 'Harvested'])
    expect(values(pickerOptions(enabledFromRows(rows([])), null))).toEqual(ALL_STATUSES)
  })

  it('a status without a row counts as enabled', () => {
    expect(enabledFromRows([{ status: 'Flower', enabled: false }])).toEqual(ALL_STATUSES.filter((s) => s !== 'Flower'))
    expect(enabledFromRows([])).toEqual(ALL_STATUSES)
  })

  it('disabling Flower removes it from new choices', () => {
    expect(values(pickerOptions(enabledFromRows(rows(['Flower'])), null))).not.toContain('Flower')
    expect(values(pickerOptions(enabledFromRows(rows(['Flower'])), 'SetFruit'))).toEqual(['Aborted', 'Pruned', 'SetFruit', 'MatureGreen', 'BreakerFruit', 'Harvested'])
  })

  it('disabling Mature Green removes it from new choices', () => {
    expect(values(pickerOptions(enabledFromRows(rows(['MatureGreen'])), 'SetFruit'))).not.toContain('MatureGreen')
  })

  it('Flower and Mature Green off: Set Fruit → Breaker Fruit → Harvested is offered, nothing in between required', () => {
    expect(OUR_CHOICE).toEqual(['Aborted', 'Pruned', 'SetFruit', 'BreakerFruit', 'Harvested'])
    const fromSet = pickerOptions(OUR_CHOICE, 'SetFruit')
    expect(values(fromSet)).toEqual(['Aborted', 'Pruned', 'SetFruit', 'BreakerFruit', 'Harvested'])
    expect(fromSet.every((o) => !o.hidden)).toBe(true)
    expect(pickerOptions(OUR_CHOICE, 'BreakerFruit').find((o) => o.value === 'Harvested')?.hidden).toBe(false)
  })

  it('a node whose recorded status is hidden still shows it as current, but it can’t be chosen again', () => {
    for (const current of ['Flower', 'MatureGreen'] as const) {
      const opts = pickerOptions(OUR_CHOICE, current)
      expect(opts.find((o) => o.value === current)).toEqual({ value: current, label: current === 'Flower' ? 'Flower' : 'Mature Green', hidden: true })
      // Every other option is a normal, selectable choice (Breaker Fruit straight from Mature Green).
      expect(opts.filter((o) => o.hidden).map((o) => o.value)).toEqual([current])
      expect(values(opts)).toContain('BreakerFruit')
    }
    // The other hidden status doesn't appear.
    expect(values(pickerOptions(OUR_CHOICE, 'MatureGreen'))).not.toContain('Flower')
  })

  it('a device that has never downloaded the choice offers every status, without claiming it is the organization’s', () => {
    expect(statusOptionsOrDefaults(undefined)).toEqual({ enabled: ALL_STATUSES, source: 'defaults' })
    expect(statusOptionsOrDefaults(OUR_CHOICE)).toEqual({ enabled: OUR_CHOICE, source: 'organization' })
  })
})
