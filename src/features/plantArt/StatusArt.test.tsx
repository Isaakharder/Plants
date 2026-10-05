import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { NodeStatus } from '../../lib/database.types'
import { COLORS } from './colors'
import { BREAKER_STOPS, artFrame, statusTone } from './frames'
import { BreakerGradient, StatusGlyph, StatusIcon } from './StatusArt'

const STATUSES: NodeStatus[] = ['Flower', 'SetFruit', 'MatureGreen', 'BreakerFruit', 'Harvested', 'Aborted', 'Pruned']
const VARIETY = 'var(--pepper-orange)'
const icon = (status: NodeStatus | null) => renderToStaticMarkup(<StatusIcon status={status} size={30} variety={VARIETY} />)
const glyph = (status: NodeStatus | null, x = 40, y = 100, hang: -1 | 1 = 1) =>
  renderToStaticMarkup(<svg><StatusGlyph status={status} x={x} y={y} hang={hang} gradientId="g" variety={VARIETY} /></svg>)

describe('shared status artwork', () => {
  it('draws each of the seven statuses (and "no status") differently', () => {
    const all = [...STATUSES, null].map((s) => glyph(s).replace(/key="[^"]*"/g, ''))
    expect(new Set(all).size).toBe(8)
  })

  it('keeps the digital twin’s geometry: peppers hang below and outside the node', () => {
    // Set fruit: size 4.6 → translate(x + 4.6·0.8 + 2, y + 4.6·1.15)
    expect(glyph('SetFruit')).toContain('transform="translate(45.7 105.3) rotate(-8) scale(4.6)"')
    expect(glyph('MatureGreen', 40, 100, -1)).toContain('transform="translate(31.6 109.2) rotate(8) scale(8)"')
    expect(glyph('SetFruit')).toContain(`fill="${COLORS.setFruit}"`)
    expect(glyph('MatureGreen')).toContain(`fill="${COLORS.matureGreen}"`)
    expect(glyph('BreakerFruit')).toContain('fill="url(#g)"')
    expect(glyph('Flower')).toContain(`fill="${COLORS.flowerCenter}"`)
    expect(glyph('Harvested')).toContain(`stroke="${VARIETY}"`)
  })

  it('Breaker turns from mature green to the variety’s colour (not a fixed red)', () => {
    const g = renderToStaticMarkup(<svg><BreakerGradient id="b" variety="var(--pepper-yellow)" /></svg>)
    expect(g).toContain(`offset="${BREAKER_STOPS[0]}" stop-color="${COLORS.matureGreen}"`)
    expect(g).toContain(`offset="${BREAKER_STOPS[1]}" style="stop-color:var(--pepper-yellow)"`)
    const i = icon('BreakerFruit')
    const id = i.match(/linearGradient id="([^"]+)"/)![1]
    expect(i).toContain(`fill="url(#${id})"`)
    expect(i).toContain('stop-color:var(--pepper-orange)')
  })

  it('icons use the same artwork, and keep Set fruit smaller than Mature green', () => {
    const ids = (m: string) => m.replace(/url\(#[^)]+\)/g, 'url(#ID)')
    for (const s of STATUSES) expect(ids(icon(s))).toContain(ids(glyph(s, 0, 0).replace(/^<svg>|<\/svg>$/g, '')))
    expect(artFrame('SetFruit').span).toBe(artFrame('MatureGreen').span)
    expect(icon('SetFruit')).toContain('scale(4.6)')
    expect(icon('MatureGreen')).toContain('scale(8)')
  })

  it('mobile button tones come from the same palette; Breaker rings in the variety colour', () => {
    expect(statusTone('SetFruit', VARIETY).ring).toBe(COLORS.setFruitEdge)
    expect(statusTone('MatureGreen', VARIETY).ring).toBe(COLORS.matureGreen)
    expect(statusTone('BreakerFruit', VARIETY).ring).toBe(VARIETY)
    expect(statusTone('Aborted', VARIETY).ring).toBe(COLORS.aborted)
  })

  it('the mobile collector has no artwork of its own any more', () => {
    const page = Object.values(import.meta.glob<string>('../collector/RowCanvasPage.tsx', { query: '?raw', import: 'default', eager: true }))[0]
    expect(page).toContain("from '../plantArt/StatusArt'")
    expect(page).not.toMatch(/crop-status-icons|<img /)
    expect(Object.keys(import.meta.glob('../collector/assets/**'))).toEqual([])
  })
})
