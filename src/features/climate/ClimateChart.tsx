// A compact hourly chart (inline SVG, no chart library): one line per zone,
// breaks where an hour is missing, shaded hours without data, hollow red marks
// for excluded readings, and a hover/tap readout. Radiation is drawn as bars.

import { useLayoutEffect, useMemo, useRef, useState } from 'react'
import { formatLocalHour, niceTicks, valueRange, type Line } from './model'
import styles from './Climate.module.css'

const HEIGHT = 150
const PAD = { top: 8, right: 8, bottom: 20, left: 40 }

type Props = {
  lines: (Line & { color: string })[]
  from: number
  to: number
  unit: string
  decimals: number
  /** Hours without any accepted file: [startEpoch, endEpoch). */
  gaps: [number, number][]
  bars?: boolean
}

function useWidth() {
  const ref = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(600)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const ro = new ResizeObserver(([e]) => setWidth(Math.max(240, Math.round(e.contentRect.width))))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  return { ref, width }
}

export function ClimateChart({ lines, from, to, unit, decimals, gaps, bars = false }: Props) {
  const { ref, width } = useWidth()
  const [hover, setHover] = useState<number | null>(null)
  const plotW = width - PAD.left - PAD.right
  const plotH = HEIGHT - PAD.top - PAD.bottom

  const { yMin, yMax } = useMemo(() => valueRange(lines.flatMap((l) => l.points.map((p) => p.v)), bars), [lines, bars])

  const x = (t: number) => PAD.left + ((t - from) / Math.max(1, to - from)) * plotW
  const y = (v: number) => PAD.top + (1 - (v - yMin) / (yMax - yMin)) * plotH
  const ticks = niceTicks(yMin, yMax)
  const days = useMemo(() => {
    // A label per local day (or every few days on long ranges).
    const out: { t: number; label: string }[] = []
    const span = (to - from) / 86400
    const every = span > 20 ? 7 : span > 8 ? 2 : 1
    let n = 0
    for (let t = Math.ceil(from / 3600) * 3600; t < to; t += 3600) {
      const h = formatLocalHour(t)
      if (h.endsWith(' 00:00')) {
        if (n++ % every === 0) out.push({ t, label: h.slice(5, 10).replace('-', '/') })
      }
    }
    if (out.length === 0 && span <= 1.5) {
      for (let t = Math.ceil(from / 21600) * 21600; t < to; t += 21600) out.push({ t, label: formatLocalHour(t).slice(11) })
    }
    return out
  }, [from, to])

  const paths = lines.map((l) => {
    let d = ''
    let prev: number | null = null
    for (const p of l.points) {
      if (p.v === null) {
        prev = null
        continue
      }
      const cmd = prev !== null && p.t - prev <= 3600 ? 'L' : 'M'
      d += `${cmd}${x(p.t).toFixed(1)},${y(p.v).toFixed(1)}`
      prev = p.t
    }
    return d
  })

  const barW = Math.max(1, (plotW / Math.max(1, (to - from) / 3600)) * 0.8)
  const hoverRows =
    hover === null
      ? []
      : lines.map((l) => ({ label: l.label, color: l.color, p: l.points.find((p) => p.t === hover) })).filter((r) => r.p)

  return (
    <div ref={ref} className={styles.chartWrap}>
      <svg
        width={width}
        height={HEIGHT}
        className={styles.chart}
        role="img"
        aria-label={`${lines.map((l) => l.label).join(', ')} (${unit})`}
        onPointerMove={(e) => {
          const r = (e.currentTarget as SVGSVGElement).getBoundingClientRect()
          const t = from + ((e.clientX - r.left - PAD.left) / plotW) * (to - from)
          setHover(t < from || t > to ? null : Math.round(t / 3600) * 3600)
        }}
        onPointerLeave={() => setHover(null)}
      >
        {gaps.map(([s, e]) => (
          <rect key={s} x={x(Math.max(s, from))} y={PAD.top} width={Math.max(1, x(Math.min(e, to)) - x(Math.max(s, from)))} height={plotH} className={styles.gap} />
        ))}
        {ticks.map((v) => (
          <g key={v}>
            <line x1={PAD.left} x2={width - PAD.right} y1={y(v)} y2={y(v)} className={styles.grid} />
            <text x={PAD.left - 4} y={y(v) + 3} className={styles.axisLabel} textAnchor="end">
              {v.toFixed(Math.max(0, decimals - (Math.abs(v) >= 100 ? 1 : 0)))}
            </text>
          </g>
        ))}
        {days.map((d) => (
          <g key={d.t}>
            <line x1={x(d.t)} x2={x(d.t)} y1={PAD.top} y2={PAD.top + plotH} className={styles.dayLine} />
            <text x={x(d.t) + 2} y={HEIGHT - 6} className={styles.axisLabel}>
              {d.label}
            </text>
          </g>
        ))}
        {bars
          ? lines.map((l, i) =>
              l.points.map((p) =>
                p.v === null ? null : (
                  <rect key={`${l.id}${p.t}`} x={x(p.t) - barW / 2 + (i * barW) / lines.length} width={barW / lines.length} y={y(Math.max(0, p.v))} height={Math.abs(y(0) - y(p.v))} fill={l.color} opacity={0.85} />
                ),
              ),
            )
          : paths.map((d, i) => <path key={lines[i].id} d={d} stroke={lines[i].color} strokeWidth={lines[i].emphasis ? 2.5 : 1.5} fill="none" strokeLinejoin="round" />)}
        {/* Excluded readings: where they'd be, hollow and red (no value is plotted for them). */}
        {lines.flatMap((l) =>
          l.points
            .filter((p) => p.excluded)
            .map((p) => <circle key={`x${l.id}${p.t}`} cx={x(p.t)} cy={PAD.top + plotH - 3} r={2.5} className={styles.excludedMark} />),
        )}
        {hover !== null && <line x1={x(hover)} x2={x(hover)} y1={PAD.top} y2={PAD.top + plotH} className={styles.hoverLine} />}
      </svg>
      {hover !== null && (
        <div className={styles.readout} style={{ left: Math.min(Math.max(x(hover) + 8, 0), width - 170) }}>
          <div className={styles.readoutTime}>{formatLocalHour(hover)}</div>
          {hoverRows.length === 0 ? (
            <div className={styles.muted}>No data</div>
          ) : (
            hoverRows.map((r) => (
              <div key={r.label} className={styles.readoutRow}>
                <span className={styles.swatch} style={{ background: r.color }} />
                <span className={styles.readoutLabel}>{r.label}</span>
                <span>{r.p!.v === null ? (r.p!.excluded ? 'excluded' : '—') : `${r.p!.v.toFixed(decimals)}`}</span>
              </div>
            ))
          )}
        </div>
      )}
    </div>
  )
}
