import type { NodeStatus } from '../../lib/database.types'
import { COLORS } from '../plantArt/colors'
import { BreakerGradient, StatusGlyph } from '../plantArt/StatusArt'

/** Small clock badge for a status that may be stale. */
export function StaleBadge({ x, y }: { x: number; y: number }) {
  return (
    <g transform={`translate(${x} ${y})`}>
      <circle r={4.2} fill="#fdf3dc" stroke={COLORS.stale} strokeWidth={1} />
      <path d="M0 -2.2 L0 0 L1.7 1.1" stroke={COLORS.stale} strokeWidth={0.9} fill="none" strokeLinecap="round" />
    </g>
  )
}

/** Small warning triangle for duplicate node numbers. */
export function DuplicateBadge({ x, y }: { x: number; y: number }) {
  return (
    <g transform={`translate(${x} ${y})`}>
      <path d="M0 -4.2 L4 3 L-4 3 Z" fill="#fff4ed" stroke={COLORS.warning} strokeWidth={0.9} strokeLinejoin="round" />
      <path d="M0 -1.6 L0 0.8" stroke={COLORS.warning} strokeWidth={0.9} strokeLinecap="round" />
      <circle cy={2} r={0.45} fill={COLORS.warning} />
    </g>
  )
}

/** A decorative leaf (no data). */
export function Leaf({ x, y, side }: { x: number; y: number; side: -1 | 1 }) {
  return (
    <path
      d="M0 0 C4 -5 12 -6 17 -3 C12 1 5 2 0 0 Z"
      transform={`translate(${x.toFixed(1)} ${y.toFixed(1)}) scale(${side} 1) rotate(-22)`}
      fill={COLORS.leaf}
      opacity={0.32}
    />
  )
}

/** A glyph sample for the legend, centred in a small SVG. */
export function LegendGlyph({ status, variety }: { status: NodeStatus | null; variety: string }) {
  return (
    <svg width={30} height={30} viewBox="-12 -12 30 30" aria-hidden="true">
      <defs>
        <BreakerGradient id="legend-breaker" variety={variety} />
      </defs>
      <circle r={1.8} fill={COLORS.stemDark} />
      <StatusGlyph status={status} x={-4} y={-6} hang={1} gradientId="legend-breaker" variety={variety} />
    </svg>
  )
}
