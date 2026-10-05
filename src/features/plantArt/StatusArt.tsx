import { useId } from 'react'
import type { NodeStatus } from '../../lib/database.types'
import { COLORS } from './colors'
import { BREAKER_STOPS, artFrame } from './frames'

// The one definition of what each node status looks like, shared by the Plants
// digital twin (drawn at its node) and the mobile collector (as an icon).
//
//   Flower        white flower, yellow centre
//   SetFruit      small, light-green bell pepper
//   MatureGreen   larger, dark-green bell pepper
//   BreakerFruit  the same pepper, green turning to the variety's colour
//   Harvested     faint scar ring in the variety's colour
//   Aborted       faint ×
//   Pruned        faint stub
//   (none)        hollow dot
//
// Peppers and flowers hang from the node on the `hang` side; resolved statuses
// are small, faint marks so they read as "a node was here", not as fruit.

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

type ArtProps = {
  status: NodeStatus | null
  /** The node the artwork hangs from. */
  x: number
  y: number
  hang: -1 | 1
  /** A BreakerGradient in the same SVG. */
  gradientId: string
  /** CSS colour of the variety, for Breaker and harvest scars. */
  variety: string
}

/** A status drawn at its node (the digital twin's plants). */
export function StatusGlyph({ status, x, y, hang, gradientId, variety }: ArtProps) {
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

/** Breaker's green → variety-colour fill. Put one in each SVG that draws a Breaker. */
export function BreakerGradient({ id, variety }: { id: string; variety: string }) {
  return (
    <linearGradient id={id} x1="0" y1="0" x2="0" y2="1">
      <stop offset={BREAKER_STOPS[0]} stopColor={COLORS.matureGreen} />
      <stop offset={BREAKER_STOPS[1]} style={{ stopColor: variety }} />
    </linearGradient>
  )
}

/**
 * A status on its own, centred in a square: the mobile collector's nodes and
 * status picker. Same artwork and relative sizes as on the digital twin (a Set
 * fruit pepper is smaller than a Mature green one).
 */
export function StatusIcon({ status, size, variety, title }: { status: NodeStatus | null; size: number; variety: string; title?: string }) {
  const gradientId = `breaker-icon-${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`
  const f = artFrame(status)
  return (
    <svg width={size} height={size} viewBox={`${f.cx - f.span / 2} ${f.cy - f.span / 2} ${f.span} ${f.span}`} aria-hidden={title ? undefined : true} role={title ? 'img' : undefined}>
      {title && <title>{title}</title>}
      {status === 'BreakerFruit' && (
        <defs>
          <BreakerGradient id={gradientId} variety={variety} />
        </defs>
      )}
      <StatusGlyph status={status} x={0} y={0} hang={1} gradientId={gradientId} variety={variety} />
    </svg>
  )
}
