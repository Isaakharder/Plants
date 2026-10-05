import type { NodeStatus } from '../../lib/database.types'
import { COLORS } from './colors'

/** Breaker's gradient: mature green until 30 %, the variety's colour from 85 %. */
export const BREAKER_STOPS = [0.3, 0.85] as const

/**
 * Where each status's artwork sits relative to its node (hanging right), and
 * the square that frames it as an icon. Flower and fruit share one span, so a
 * Set fruit pepper stays smaller than a Mature green one, as on the plant; the
 * small resolved marks get a tighter frame so they stay legible on a phone.
 */
const FRAMES: Record<NodeStatus | 'none', { cx: number; cy: number; span: number }> = {
  Flower: { cx: 7, cy: 4, span: 22 },
  SetFruit: { cx: 5.7, cy: 5.1, span: 22 },
  MatureGreen: { cx: 8.4, cy: 8.8, span: 22 },
  BreakerFruit: { cx: 8.4, cy: 8.8, span: 22 },
  Harvested: { cx: 4.3, cy: 3, span: 12 },
  Aborted: { cx: 5, cy: 3, span: 12 },
  Pruned: { cx: 4, cy: 1.5, span: 12 },
  none: { cx: 5, cy: 2, span: 12 },
}

export const artFrame = (status: NodeStatus | null) => FRAMES[status ?? 'none']

/**
 * Ring and background of a status's button on the mobile collector, from the
 * same palette as the artwork. Breaker takes the variety's colour, as its pepper does.
 */
export function statusTone(status: NodeStatus | null, variety: string): { ring: string; background: string } {
  switch (status) {
    case 'Flower':
      return { ring: COLORS.flowerCenter, background: '#fffdf2' }
    case 'SetFruit':
      return { ring: COLORS.setFruitEdge, background: '#f3f9ec' }
    case 'MatureGreen':
      return { ring: COLORS.matureGreen, background: '#e9f3ea' }
    case 'BreakerFruit':
      return { ring: variety, background: '#ffffff' }
    case 'Harvested':
      return { ring: COLORS.resolved, background: '#f4f5f2' }
    case 'Aborted':
      return { ring: COLORS.aborted, background: '#f6f2ed' }
    case 'Pruned':
      return { ring: COLORS.resolved, background: '#f4f5f2' }
    default:
      return { ring: '#d1d5db', background: '#ffffff' }
  }
}
