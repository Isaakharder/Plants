import type { NodeStatus } from '../../lib/database.types'
import { COLORS } from './colors'

// Status glyphs, drawn at a node. Peppers and flowers hang from the node on
// the `hang` side; resolved statuses are small, faint marks so they read as
// "a node was here", not as fruit on the plant.

/** A bell pepper in unit coordinates: calyx at y ≈ −1, lobed bottom at y ≈ 1.15. */
const BELL =
  'M-0.55 -0.98 C-1.05 -1 -1.12 -0.42 -1.02 0.28 C-0.94 0.88 -0.72 1.15 -0.42 1.1 ' +
  'C-0.27 1.2 -0.11 1.16 0 1.05 C0.11 1.16 0.27 1.2 0.42 1.1 ' +
  'C0.72 1.15 0.94 0.88 1.02 0.28 C1.12 -0.42 1.05 -1 0.55 -0.98 C0.3 -0.86 -0.3 -0.86 -0.55 -0.98 Z'


function Pepper({ x, y, size, fill, edge, hang }: { x: number; y: number; size: number; fill: string; edge: string; hang: -1 | 1 }) {
  // Hangs just below and outside the node, tilted slightly outward.
  const cx = x + hang * (size * 0.8 + 2)
  const cy = y + size * 1.15
  return (
    <g transform={`translate(${cx.toFixed(1)} ${cy.toFixed(1)}) rotate(${hang * -8}) scale(${size})`}>
      <path d="M0 -1.3 L0 -0.92" stroke={COLORS.calyx} strokeWidth={0.16} strokeLinecap="round" />
      <path d={BELL} fill={fill} stroke={edge} strokeWidth={0.09} />
      <path d="M-0.5 -0.96 Q0 -0.62 0.5 -0.96 Q0 -1.1 -0.5 -0.96 Z" fill={COLORS.calyx} />
      <path d="M-0.55 -0.4 Q-0.62 0.25 -0.42 0.65" stroke="#ffffff" strokeOpacity={0.4} strokeWidth={0.14} fill="none" strokeLinecap="round" />
    </g>
  )
}

function Flower({ x, y, hang }: { x: number; y: number; hang: -1 | 1 }) {
  const cx = x + hang * 7
  const cy = y + 4
  return (
    <g transform={`translate(${cx} ${cy})`}>
      {[0, 72, 144, 216, 288].map((a) => (
        <ellipse key={a} cx={0} cy={-3.1} rx={2.1} ry={3.1} transform={`rotate(${a})`} fill={COLORS.flower} stroke={COLORS.flowerEdge} strokeWidth={0.6} />
      ))}
      <circle r={1.8} fill={COLORS.flowerCenter} />
    </g>
  )
}

/** A status glyph for a node. `variety` is the crop colour (CSS value) for Breaker / Harvested. */
export function StatusGlyph({ status, x, y, hang, gradientId, variety }: { status: NodeStatus | null; x: number; y: number; hang: -1 | 1; gradientId: string; variety: string }) {
  switch (status) {
    case 'Flower':
      return <Flower x={x} y={y} hang={hang} />
    case 'SetFruit':
      return <Pepper x={x} y={y} size={4.6} fill={COLORS.setFruit} edge={COLORS.setFruitEdge} hang={hang} />
    case 'MatureGreen':
      return <Pepper x={x} y={y} size={8} fill={COLORS.matureGreen} edge={COLORS.matureGreenEdge} hang={hang} />
    case 'BreakerFruit':
      return <Pepper x={x} y={y} size={8} fill={`url(#${gradientId})`} edge={COLORS.matureGreenEdge} hang={hang} />
    case 'Harvested':
      // A cut stalk with a small scar ring: the fruit is gone.
      return (
        <g opacity={0.5} transform={`translate(${x + hang * 5} ${y + 3})`}>
          <path d={`M${-hang * 4} -2 L0 0`} stroke={COLORS.resolved} strokeWidth={1.2} strokeLinecap="round" />
          <circle r={2.6} fill="none" stroke={variety} strokeWidth={1.3} />
        </g>
      )
    case 'Aborted':
      return (
        <g opacity={0.55} transform={`translate(${x + hang * 5} ${y + 3})`} stroke={COLORS.aborted} strokeWidth={1.3} strokeLinecap="round">
          <path d="M-2.4 -2.4 L2.4 2.4 M2.4 -2.4 L-2.4 2.4" />
        </g>
      )
    case 'Pruned':
      return (
        <g opacity={0.55} stroke={COLORS.resolved} strokeWidth={1.3} strokeLinecap="round">
          <path d={`M${x} ${y} L${x + hang * 6} ${y + 2}`} />
          <path d={`M${x + hang * 5} ${y - 1.5} L${x + hang * 8} ${y + 4.5}`} />
        </g>
      )
    default:
      return <circle cx={x + hang * 5} cy={y + 2} r={2.6} fill="#ffffff" stroke="#9aa39a" strokeWidth={1} />
  }
}

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
        <linearGradient id="legend-breaker" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0.25" stopColor={COLORS.matureGreen} />
          <stop offset="0.9" style={{ stopColor: variety }} />
        </linearGradient>
      </defs>
      <circle r={1.8} fill={COLORS.stemDark} />
      <StatusGlyph status={status} x={-4} y={-6} hang={1} gradientId="legend-breaker" variety={variety} />
    </svg>
  )
}
