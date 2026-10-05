import { memo, type MouseEvent } from 'react'
import { COLORS } from '../plantArt/colors'
import { BreakerGradient, StatusGlyph } from '../plantArt/StatusArt'
import { DuplicateBadge, Leaf, StaleBadge } from './Glyphs'
import { BRACKET_X, NODE_SPACING, STEM_WIDTH, nodeY, type GrowthBracket, type TwinNode, type TwinStem } from './twin'

export type NodeHandler = (node: TwinNode, stem: TwinStem, event: MouseEvent) => void

type Props = {
  stem: TwinStem
  height: number
  baseY: number
  maxNodeNumber: number
  scale: number
  /** CSS colour of the variety, for Breaker and harvest scars. */
  variety: string
  selected: boolean
  selectedNodeId: string | null
  onNodeEnter: NodeHandler
  onNodeLeave: () => void
  onNodeClick: NodeHandler
  /** The duplicate badge was clicked: review the records involved. */
  onProblemClick: NodeHandler
}

/** One sampled stem, drawn from its collector records. */
export const PlantSvg = memo(function PlantSvg({ stem, height, baseY, maxNodeNumber, scale, variety, selected, selectedNodeId, onNodeEnter, onNodeLeave, onNodeClick, onProblemClick }: Props) {
  const gradientId = `breaker-${stem.id}`
  const nodes = [...stem.mainNodes, ...stem.branches.flatMap((b) => b.nodes)]
  return (
    <svg
      width={STEM_WIDTH * scale}
      height={height * scale}
      viewBox={`0 0 ${STEM_WIDTH} ${height}`}
      role="img"
      aria-label={`${stem.name}: ${stem.mainNodes.length} main-stem nodes, ${stem.shootCount} side shoots`}
    >
      <defs>
        <BreakerGradient id={gradientId} variety={variety} />
      </defs>

      {/* Soil and node-number ruler (every 5 nodes), shared by all stems. */}
      <rect x={0} y={baseY} width={STEM_WIDTH} height={height - baseY} fill="#efe6d8" />
      <line x1={0} x2={STEM_WIDTH} y1={baseY} y2={baseY} stroke="#cbb89b" strokeWidth={1.5} />
      {Array.from({ length: Math.floor(maxNodeNumber / 5) }, (_, i) => (i + 1) * 5).map((n) => (
        <text key={n} x={3} y={nodeY(baseY, n) + 3} fontSize={8} fill="#9aa39a">
          {n}
        </text>
      ))}

      {stem.leaves.map((leaf, i) => (
        <Leaf key={i} {...leaf} />
      ))}

      {selected && <path d={stem.path} stroke={COLORS.stem} strokeOpacity={0.18} strokeWidth={11} fill="none" strokeLinecap="round" />}
      <path d={stem.path} stroke={COLORS.stem} strokeWidth={selected ? 4 : 3.4} fill="none" strokeLinecap="round" strokeLinejoin="round" />
      {stem.branches.map((b) => (
        <path key={b.parentId} d={b.path} stroke={COLORS.stem} strokeWidth={2.1} fill="none" strokeLinecap="round" />
      ))}

      {stem.growth.map((g) => (
        <GrowthMark key={g.id} g={g} />
      ))}

      {nodes.map((node) => (
        <g
          key={node.id}
          className="plant-node"
          onMouseEnter={(e) => onNodeEnter(node, stem, e)}
          onMouseLeave={onNodeLeave}
          onClick={(e) => onNodeClick(node, stem, e)}
          style={{ cursor: 'pointer' }}
        >
          <circle cx={node.x} cy={node.y} r={node.isShoot ? 1.9 : 2.3} fill={COLORS.stemDark} />
          <StatusGlyph status={node.status} x={node.x} y={node.y} hang={node.hang} gradientId={gradientId} variety={variety} />
          {node.stale && <StaleBadge x={node.x + node.hang * 15} y={node.y - 3} />}
          {selectedNodeId === node.id && <circle cx={node.x + node.hang * 5} cy={node.y + 4} r={11} fill="none" stroke="#1c2a20" strokeWidth={1.4} strokeDasharray="3 2" />}
          {/* Generous invisible hit area. */}
          <circle cx={node.x + node.hang * 5} cy={node.y + 4} r={NODE_SPACING / 2.4} fill="transparent" />
        </g>
      ))}

      {/* Duplicate badges above every node (and shoot), so they always get their own clicks. */}
      {nodes
        .filter((node) => node.duplicate?.index === 0)
        .map((node) => {
          const x = node.x - 9 - (node.duplicate!.count - 1) * (node.isShoot ? 5.5 : 7)
          return (
            <g
              key={`problem-${node.id}`}
              className="plant-problem"
              role="button"
              aria-label={`Review ${node.duplicate!.count} records labelled ${node.label}`}
              style={{ cursor: 'pointer' }}
              onClick={(e) => onProblemClick(node, stem, e)}
            >
              <DuplicateBadge x={x} y={node.y - 7} />
              <circle cx={x} cy={node.y - 6} r={7} fill="transparent" />
            </g>
          )
        })}
    </svg>
  )
})

/** Weekly head growth beside the stem section it covers (previous top node → this top node). */
function GrowthMark({ g }: { g: GrowthBracket }) {
  const x = BRACKET_X
  const anchor = (g.yTop + g.yBottom) / 2
  const span = g.fromNode === g.toNode ? `node ${g.toNode}` : `nodes ${g.fromNode}→${g.toNode}`
  return (
    <g opacity={g.latest ? 1 : 0.62}>
      <title>{`Week ${g.week}: ${g.cm.toFixed(1)} cm of head growth (${span})${g.notes ? ` — note: ${g.notes}` : ''}`}</title>
      {g.yTop === g.yBottom ? (
        <path d={`M${x - 4} ${g.yTop} L${x} ${g.yTop}`} stroke={COLORS.growth} strokeWidth={1.3} />
      ) : (
        <path d={`M${x - 4} ${g.yTop} L${x} ${g.yTop} L${x} ${g.yBottom} L${x - 4} ${g.yBottom}`} stroke={COLORS.growth} strokeWidth={1.3} fill="none" />
      )}
      {/* A thin leader when the label had to move away from its section. */}
      {Math.abs(g.labelY - anchor) > 4 && <path d={`M${x} ${anchor} L${x + 3} ${g.labelY - 3}`} stroke={COLORS.growth} strokeWidth={0.6} strokeOpacity={0.6} />}
      <text x={x + 4} y={g.labelY - 1} fontSize={9.5} fill={COLORS.growth} fontWeight={g.latest ? 700 : 500}>
        <tspan>{g.cm.toFixed(1)} cm</tspan>
        <tspan x={x + 4} dy={10}>
          W{g.week}
          {g.notes ? ' *' : ''}
        </tspan>
      </text>
    </g>
  )
}
