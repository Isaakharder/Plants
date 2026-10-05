// Adapted from CropLink client/src/pages/RowCanvasPage.tsx. The canvas, status
// picker and Veg column render as in CropLink. Changes:
//   * data comes from ./api (Supabase as the signed-in user + offline queue);
//     seasons and temp-ID remapping are gone
//   * the week is evaluated when each status / growth reading is saved
//   * the header (row, variety, colour) is loaded by rowId, so a reload or a
//     deep link no longer shows "Variety / Row"
//   * legacy CropLink statuses (GolfBall, Harvestable, …) are not carried over

import { useMemo, useRef, useState, type FormEvent } from 'react';
import { useLocation, useNavigate, useParams } from 'react-router-dom';
import { useAuth } from '../auth/AuthProvider';
import { duplicateExplanation, rowAttention, useNow, type NodeAttention } from './attention';
import { useOrganization } from '../organization/OrganizationProvider';
import { NotOnDeviceError, useAttentionRules, useCollectorActions, useCollectorCrops, useRowCanvas } from './api';
import { OfflineBanner } from './components/OfflineBanner';
import { TextPromptModal } from './components/TextPromptModal';
import { cropColorVar, type CanvasState } from './display';
import { useGreenhouseWeek } from './greenhouseWeek';
import type { LatestNodeStatus, MeasurementStem, NodeStatus, PlantNode, StemGrowthMeasurement } from './types';

// Load all crop status icons eagerly; presence in the map determines whether to show an icon.
const _statusIconModules = import.meta.glob<string>(
  './assets/crop-status-icons/*.svg',
  { eager: true, import: 'default' }
);

// Explicit mapping from DB status value → SVG filename stem (no lowercasing assumed).
const STATUS_TO_ICON_FILE: Record<NodeStatus, string> = {
  Aborted:      'aborted',
  Pruned:       'pruned',
  Flower:       'flower',
  SetFruit:     'set-fruit',
  MatureGreen:  'mature-green',
  BreakerFruit: 'breaker-fruit',
  Harvested:    'harvested',
};

function getStatusIcon(status: NodeStatus): string | undefined {
  return _statusIconModules[`./assets/crop-status-icons/${STATUS_TO_ICON_FILE[status]}.svg`];
}

const STATUS_OPTIONS: { value: NodeStatus; label: string }[] = [
  { value: 'Aborted',      label: 'Aborted' },
  { value: 'Pruned',       label: 'Pruned' },
  { value: 'Flower',       label: 'Flower' },
  { value: 'SetFruit',     label: 'Set Fruit' },
  { value: 'MatureGreen',  label: 'Mature Green' },
  { value: 'BreakerFruit', label: 'Breaker Fruit' },
  { value: 'Harvested',    label: 'Harvested' },
];

const STATUS_CONFIG: Record<NodeStatus, { color: string; bg: string; label: string }> = {
  Aborted:      { color: '#ef4444', bg: '#fee2e2', label: 'Aborted' },
  Pruned:       { color: '#6b7280', bg: '#f3f4f6', label: 'Pruned' },
  Flower:       { color: '#ec4899', bg: '#fdf2f8', label: 'Flower' },
  SetFruit:     { color: '#8b5cf6', bg: '#f5f3ff', label: 'Set Fruit' },
  MatureGreen:  { color: '#16a34a', bg: '#dcfce7', label: 'Mature Green' },
  BreakerFruit: { color: '#f97316', bg: '#fff7ed', label: 'Breaker Fruit' },
  Harvested:    { color: '#1d4ed8', bg: '#dbeafe', label: 'Harvested' },
};

const SHORT_STATUS_LABEL: Record<NodeStatus, string> = {
  Aborted:      'Aborted',
  Pruned:       'Pruned',
  Flower:       'Flower',
  SetFruit:     'Set',
  MatureGreen:  'Mature',
  BreakerFruit: 'Breaker',
  Harvested:    'Harvested',
};

function shortStatusLabel(status: NodeStatus): string {
  return SHORT_STATUS_LABEL[status];
}

// Side-shoot display notation: "<parent node number>+<order>", e.g. "5+1", "5+2".
// `order` currently counts shoots on the same parent; a future secondary-branch
// dimension can extend this (e.g. an extra "+level" segment) without touching callers.
function formatShootLabel(parentNodeNumber: number, order: number): string {
  return `${parentNodeNumber}+${order}`;
}

// ── Attention badges (⚠ duplicate record, clock = overdue for an update) ──
// Small marks on the node's corner; tapping one explains it. They sit outside
// the node button, so tapping the node still opens the status picker.

function WarningIcon() {
  return (
    <svg viewBox="-6 -6 12 12" aria-hidden="true">
      <path d="M0 -4.6 L4.6 3.6 L-4.6 3.6 Z" fill="#fff4ed" stroke="#c2410c" strokeWidth={1.2} strokeLinejoin="round" />
      <path d="M0 -1.6 L0 1" stroke="#c2410c" strokeWidth={1.2} strokeLinecap="round" />
      <circle cy={2.4} r={0.6} fill="#c2410c" />
    </svg>
  );
}

function ClockIcon() {
  return (
    <svg viewBox="-6 -6 12 12" aria-hidden="true">
      <circle r={4.8} fill="#fdf3dc" stroke="#b7791f" strokeWidth={1.2} />
      <path d="M0 -2.6 L0 0 L2 1.3" stroke="#b7791f" strokeWidth={1.1} fill="none" strokeLinecap="round" />
    </svg>
  );
}

function AttentionBadges({ attention, onOpen }: { attention: NodeAttention | undefined; onOpen: () => void }) {
  if (!attention) return null;
  const open = (e: { stopPropagation: () => void }) => { e.stopPropagation(); onOpen(); };
  return (
    <>
      {attention.duplicate && (
        <button type="button" className="attention-badge attention-badge--warning" aria-label="Needs attention: duplicate record" onClick={open}>
          <WarningIcon />
        </button>
      )}
      {attention.clock && (
        <button type="button" className="attention-badge attention-badge--clock" aria-label={attention.clock.kind === 'overdue' ? `Needs an update: last updated ${attention.clock.ageDays} days ago` : 'No status update recorded'} onClick={open}>
          <ClockIcon />
        </button>
      )}
    </>
  );
}

const byNodeOrder = (a: PlantNode, b: PlantNode) => a.sort_order - b.sort_order || a.node_number - b.node_number;

export function RowCanvasPage() {
  const { rowId = '' } = useParams<{ rowId: string }>();
  const location = useLocation();
  const navigate = useNavigate();
  const userId = useAuth().session!.user.id;
  const organization = useOrganization();
  const actions = useCollectorActions();

  // Display only: every save asks for the current week itself.
  const { year: currentYear, week: currentWeek } = useGreenhouseWeek(); // greenhouse (Toronto) week, not the device clock

  const canvasQuery = useRowCanvas(rowId, userId);
  const crops = useCollectorCrops(organization.id, userId).data;
  const row = canvasQuery.data?.row ?? null;
  const crop = row ? crops?.find(c => c.id === row.crop_id) : undefined;

  // Header: loaded by rowId; router state is only a fast first paint.
  const ctx = (location.state ?? {}) as Partial<CanvasState>;
  const rowName      = row?.row_name ?? ctx.rowName ?? 'Row';
  const varietyName  = crop?.name ?? ctx.varietyName ?? 'Variety';
  const varietyColor = crop ? cropColorVar(crop.color) : ctx.varietyColor ?? null;

  const [activeStemIndex, setActiveStemIndex] = useState(0);
  const [addStemModal,    setAddStemModal]    = useState(false);
  const [statusPickerCtx, setStatusPickerCtx] = useState<{ stem: MeasurementStem; node: PlantNode; isNew?: boolean } | null>(null);
  const [attentionCtx, setAttentionCtx] = useState<{ stem: MeasurementStem; node: PlantNode } | null>(null);
  const [saving,   setSaving]   = useState(false);
  const [message,  setMessage]  = useState('');

  const [vegModal,     setVegModal]     = useState(false);
  const [vegGrowthCm,  setVegGrowthCm]  = useState('');
  const [vegNotes,     setVegNotes]     = useState('');
  const [vegSaving,    setVegSaving]    = useState(false);
  const [vegError,     setVegError]     = useState('');

  const canvasRef = useRef<HTMLDivElement>(null);

  // ── Server data (merged with this device's unsynced writes) ─────────────
  const stems = useMemo(
    () => (canvasQuery.data?.stems ?? []).filter(s => s.is_active).sort((a, b) => a.sort_order - b.sort_order),
    [canvasQuery.data],
  );

  const nodesByStem = useMemo(() => {
    const result: Record<string, PlantNode[]> = {};
    for (const node of canvasQuery.data?.nodes ?? []) {
      if (!node.is_active) continue;
      (result[node.measurement_stem_id] ??= []).push(node);
    }
    Object.values(result).forEach(list => list.sort(byNodeOrder));
    return result;
  }, [canvasQuery.data]);

  const statusesByStem = useMemo(() => {
    const stemOfNode = new Map((canvasQuery.data?.nodes ?? []).map(n => [n.id, n.measurement_stem_id]));
    const result: Record<string, LatestNodeStatus[]> = {};
    for (const status of canvasQuery.data?.statuses ?? []) {
      const stemId = stemOfNode.get(status.plant_node_id);
      if (stemId) (result[stemId] ??= []).push(status);
    }
    return result;
  }, [canvasQuery.data]);

  // Duplicate records and nodes overdue under the organization’s attention rules, from the same merged
  // data (queued writes included), so a status saved offline clears its clock at once.
  const now = useNow();
  const { rules: attentionRules } = useAttentionRules(organization.id, userId);
  const attentionByNode = useMemo(
    () => rowAttention(canvasQuery.data?.nodes ?? [], canvasQuery.data?.statuses ?? [], now, attentionRules),
    [canvasQuery.data, now, attentionRules],
  );

  // This week's reading (shown on the chip and pre-filled in the Veg modal).
  const growthByStem = useMemo(() => {
    const result: Record<string, StemGrowthMeasurement | null> = {};
    for (const g of canvasQuery.data?.growth ?? []) {
      if (g.year === currentYear && g.week_number === currentWeek) result[g.measurement_stem_id] = g;
    }
    return result;
  }, [canvasQuery.data, currentYear, currentWeek]);

  // Readings that carry a top node, oldest first, for the Veg column.
  const vegHistoryByStem = useMemo(() => {
    const result: Record<string, StemGrowthMeasurement[]> = {};
    for (const g of canvasQuery.data?.growth ?? []) {
      if (g.top_node_number == null) continue;
      (result[g.measurement_stem_id] ??= []).push(g);
    }
    Object.values(result).forEach(list => list.sort((a, b) => a.year - b.year || a.week_number - b.week_number));
    return result;
  }, [canvasQuery.data]);

  const safeIndex  = stems.length === 0 ? 0 : Math.min(activeStemIndex, stems.length - 1);
  const activeStem = stems[safeIndex] ?? null;

  async function handleAddStem(name: string) {
    if (!row) throw new Error('This row isn’t available on this device yet. Reconnect and try again.');
    const newIndex = stems.length;
    await actions.createStem(row, name, stems.length + 1);
    setActiveStemIndex(newIndex);
    canvasRef.current?.scrollTo({ top: 0, behavior: 'smooth' });
  }

  async function handleAddNode(stem: MeasurementStem, num: number) {
    const existing = (nodesByStem[stem.id] ?? []).find(
      n => !n.is_side_shoot && n.node_number === num,
    );
    if (existing) {
      setStatusPickerCtx({ stem, node: existing, isNew: false });
      return;
    }
    const created = await actions.createNode(stem, {
      node_number: num,
      sort_order: num,
    });
    setStatusPickerCtx({ stem, node: created, isNew: true });
    canvasRef.current?.scrollTo({ top: 0, behavior: 'smooth' });
  }

  async function handleAddShoot(parentNode: PlantNode, side: 'left' | 'right') {
    if (!activeStem) return;
    const stemNodes = nodesByStem[activeStem.id] ?? [];
    const existingCount = stemNodes.filter(
      n => n.is_side_shoot && n.parent_node_id === parentNode.id,
    ).length;
    const label = formatShootLabel(parentNode.node_number, existingCount + 1);
    const created = await actions.createNode(activeStem, {
      node_number: parentNode.node_number,
      sort_order: parentNode.sort_order,
      node_label: label,
      parent_node_id: parentNode.id,
      side,
      is_side_shoot: true,
    });
    setStatusPickerCtx({ stem: activeStem, node: created, isNew: true });
  }

  async function handleSaveStatus(status: NodeStatus) {
    if (!statusPickerCtx) return;
    setSaving(true);
    try {
      await actions.recordStatus(statusPickerCtx.node, status);
      const nodeLabel = statusPickerCtx.node.is_side_shoot
        ? (statusPickerCtx.node.node_label ?? 'Shoot')
        : `Node ${statusPickerCtx.node.node_number}`;
      setMessage(`${nodeLabel}: ${STATUS_CONFIG[status].label}`);
      setStatusPickerCtx(null);
    } catch (err: unknown) {
      setMessage(`Not saved: ${err instanceof Error ? err.message : 'Save failed'}`);
    } finally {
      setSaving(false);
    }
  }

  async function handleCancelStatusPicker() {
    if (!statusPickerCtx) return;
    if (statusPickerCtx.isNew) {
      try { await actions.discardNewNode(statusPickerCtx.node); } catch { /* best effort */ }
    }
    setStatusPickerCtx(null);
  }

  function openVegModal() {
    const existing = activeStem ? growthByStem[activeStem.id] : null;
    setVegGrowthCm(existing ? String(existing.growth_cm) : '');
    setVegNotes(existing?.notes ?? '');
    setVegError('');
    setVegModal(true);
  }

  async function handleSaveVeg(e: FormEvent) {
    e.preventDefault();
    if (!activeStem) return;
    const cm = parseFloat(vegGrowthCm);
    if (!vegGrowthCm.trim() || isNaN(cm) || cm <= 0) {
      setVegError('Enter a valid growth in cm (must be > 0)');
      return;
    }
    setVegSaving(true);
    setVegError('');
    try {
      // Highest active main-stem node right now (CropLink took this on the server).
      const mainNodeNumbers = (nodesByStem[activeStem.id] ?? []).filter(n => !n.is_side_shoot).map(n => n.node_number);
      const topNodeNumber = mainNodeNumbers.length > 0 ? Math.max(...mainNodeNumbers) : null;
      const saved = await actions.saveGrowth(activeStem, cm, vegNotes.trim() || null, topNodeNumber, growthByStem[activeStem.id] ?? null);
      setMessage(`Growth: ${saved.growth_cm} cm saved`);
      setVegModal(false);
    } catch (err: unknown) {
      setVegError(err instanceof Error ? err.message : 'Save failed');
    } finally {
      setVegSaving(false);
    }
  }

  async function handlePickerNodeSwitch(nodeNum: number) {
    if (!statusPickerCtx || saving) return;
    const stem = statusPickerCtx.stem;
    const existing = (nodesByStem[stem.id] ?? []).find(
      n => !n.is_side_shoot && n.node_number === nodeNum,
    );
    if (existing) {
      setStatusPickerCtx({ stem, node: existing });
      return;
    }
    setSaving(true);
    try {
      const created = await actions.createNode(stem, {
        node_number: nodeNum,
        sort_order: nodeNum,
      });
      setStatusPickerCtx({ stem, node: created });
    } finally {
      setSaving(false);
    }
  }

  // ── Derived values for the active stem ──────────────────────────────
  const allNodes     = activeStem ? (nodesByStem[activeStem.id]    ?? []) : [];
  const activeStatuses = activeStem ? (statusesByStem[activeStem.id] ?? []) : [];

  const mainNodes = allNodes.filter(n => !n.is_side_shoot);

  // ── Veg Measurement Stem (secondary, node-aligned growth readings) ──────
  // Each reading's top_node_number is "the highest active main-stem node at
  // save time" — visually that places the reading in the gap directly below
  // that node (i.e. between it and the node one lower), so a chip is emitted
  // right before its matching node as we walk mainNodes bottom-to-top.
  const vegHistory = activeStem ? (vegHistoryByStem[activeStem.id] ?? []) : [];
  const vegByTopNode: Record<number, StemGrowthMeasurement[]> = {};
  vegHistory.forEach(g => {
    if (g.top_node_number == null) return;
    (vegByTopNode[g.top_node_number] ??= []).push(g);
  });
  type VegRow =
    | { kind: 'node'; node: PlantNode }
    | { kind: 'growth'; growth: StemGrowthMeasurement };
  const vegRows: VegRow[] = [];
  mainNodes.forEach(node => {
    (vegByTopNode[node.node_number] ?? []).forEach(growth => {
      vegRows.push({ kind: 'growth', growth });
    });
    vegRows.push({ kind: 'node', node });
  });
  const hasVegStem = vegHistory.length > 0 && vegRows.some(r => r.kind === 'node');

  // Group ALL side shoots by parent node id (not just one per side)
  const shootsByParentNode: Record<string, PlantNode[]> = {};
  allNodes
    .filter(n => n.is_side_shoot && n.parent_node_id)
    .forEach(n => {
      const pid = n.parent_node_id!;
      if (!shootsByParentNode[pid]) shootsByParentNode[pid] = [];
      shootsByParentNode[pid].push(n);
    });

  const hasPrev = safeIndex > 0;
  const hasNext = safeIndex < stems.length - 1;

  const pickerNodeLabel = statusPickerCtx
    ? (statusPickerCtx.node.is_side_shoot
        ? (statusPickerCtx.node.node_label ?? 'Side Shoot')
        : `Node ${statusPickerCtx.node.node_number}`)
    : '';

  const loading = canvasQuery.data === undefined;

  return (
    <div className="row-canvas-page">

      {/* ── Main header ── */}
      <header className="row-canvas-header">
        <button className="row-canvas-back" onClick={() => navigate('/mobile')}>
          ← Back
        </button>
        <div className="row-canvas-title">
          {varietyColor && (
            <span className="variety-color-dot" style={{ background: varietyColor }} />
          )}
          <span className="row-canvas-variety">{varietyName}</span>
          <span className="row-canvas-sep">/</span>
          <span className="row-canvas-rowname">{rowName}</span>
        </div>
        <div className="row-canvas-week">Wk {currentWeek}</div>
        <button
          className="btn btn-primary btn-sm"
          style={{ flexShrink: 0 }}
          disabled={!row}
          onClick={() => setAddStemModal(true)}
        >
          + Stem
        </button>
      </header>

      <OfflineBanner />

      {/* ── Stem navigation bar ── */}
      {stems.length > 0 && (
        <div className="stem-nav-bar">
          <button
            className="stem-nav-arrow"
            aria-label="Previous stem"
            disabled={!hasPrev}
            onClick={() => setActiveStemIndex(i => i - 1)}
          >
            ←
          </button>
          <span className="stem-nav-name">
            {activeStem?.stem_name ?? ''}
            <span className="stem-nav-counter">
              &nbsp;{safeIndex + 1} / {stems.length}
            </span>
          </span>
          <button
            className="stem-nav-arrow"
            aria-label="Next stem"
            disabled={!hasNext}
            onClick={() => setActiveStemIndex(i => i + 1)}
          >
            →
          </button>
        </div>
      )}

      {/* ── Flash message ── */}
      {message && (
        <div className="row-canvas-message" onClick={() => setMessage('')}>
          {message} &times;
        </div>
      )}

      {/* ── Canvas area ── */}
      <div className="row-canvas-area" ref={canvasRef}>
        {loading ? (
          <div className="row-canvas-empty">
            <p>
              {canvasQuery.error instanceof NotOnDeviceError
                ? 'Offline. This row hasn’t been opened on this device yet.'
                : canvasQuery.isError
                  ? `Couldn’t load this row. ${canvasQuery.error.message}`
                  : 'Loading…'}
            </p>
          </div>
        ) : !row ? (
          <div className="row-canvas-empty">
            <p>Row not found.</p>
          </div>
        ) : stems.length === 0 ? (
          <div className="row-canvas-empty">
            <p>No stems yet.</p>
            <p style={{ fontSize: 13, color: 'var(--gray-400)', marginTop: 8 }}>
              Tap &ldquo;+ Stem&rdquo; in the header to add your first stem.
            </p>
          </div>
        ) : activeStem ? (
          <div className="stem-single">

            {/* Growing tip — always at the top */}
            <div className="stem-tip-actions">
              <button
                className="stem-add-node-btn"
                onClick={() => { void handleAddNode(activeStem!, mainNodes.length + 1 || 1); }}
              >
                + Node
              </button>
              <button
                className="stem-veg-btn"
                onClick={openVegModal}
              >
                + Veg
              </button>
            </div>
            {activeStem && growthByStem[activeStem.id] != null && (
              <div className="stem-growth-chip">
                &#8593; {growthByStem[activeStem.id]!.growth_cm} cm
              </div>
            )}

            <div className="stem-canvas-row">
            {/*
             * column-reverse: first DOM child (N1) sits at the BOTTOM;
             * the highest node number is directly below "+ Node".
             */}
            <div className="stem-visual">
              {mainNodes.length > 0 && <div className="stem-line" />}
              {mainNodes.length === 0 && (
                <div className="stem-no-nodes">
                  Add the first<br />node above
                </div>
              )}

              {mainNodes.map(node => {
                const statusRec  = activeStatuses.find(s => s.plant_node_id === node.id);
                const nodeStatus = statusRec?.status ?? null;
                const cfg = nodeStatus ? STATUS_CONFIG[nodeStatus] : null;

                // Odd node_number → shoot on right, badge on left
                // Even node_number → shoot on left, badge on right
                const shootSide: 'left' | 'right' = node.node_number % 2 !== 0 ? 'right' : 'left';
                // All shoots for this node, ordered by label suffix (1+1, 1+2, …)
                const nodeShoots = (shootsByParentNode[node.id] ?? [])
                  .slice()
                  .sort((a, b) => {
                    const nA = parseInt(a.node_label?.match(/\+(\d+)$/)?.[1] ?? '0', 10);
                    const nB = parseInt(b.node_label?.match(/\+(\d+)$/)?.[1] ?? '0', 10);
                    return nA - nB;
                  });

                const mainIcon = nodeStatus ? getStatusIcon(nodeStatus) : undefined;

                // Shoot zone: one icon-circle per shoot + always-visible add button.
                // DOM order is [connector?, …icons, +btn]; shoot-zone--left reverses via
                // row-reverse so the connector always sits closest to the main stem.
                const MAX_VISIBLE = 3;
                const visibleShoots = nodeShoots.slice(0, MAX_VISIBLE);
                const hiddenCount   = nodeShoots.length - MAX_VISIBLE;
                const shootZone = (
                  <div className={`shoot-zone shoot-zone--${shootSide}`}>
                    {nodeShoots.length > 0 && <div className="shoot-connector" />}
                    {visibleShoots.map((shoot, shootIdx) => {
                      const sr        = activeStatuses.find(s => s.plant_node_id === shoot.id);
                      const srStatus  = sr?.status ?? null;
                      const sc        = srStatus ? STATUS_CONFIG[srStatus] : null;
                      const shootIcon = srStatus ? getStatusIcon(srStatus) : undefined;
                      const cellLabel = srStatus ? shortStatusLabel(srStatus) : (shoot.node_label ?? '?');
                      const shootNumberLabel = shoot.node_label ?? formatShootLabel(node.node_number, shootIdx + 1);
                      return (
                        <div key={shoot.id} className="shoot-node-cell">
                          <span className="shoot-number-label">{shootNumberLabel}</span>
                          <span className="attention-anchor attention-anchor--shoot">
                          <button
                            type="button"
                            className="shoot-icon-btn"
                            style={{
                              borderColor: sc?.color ?? 'var(--gray-300)',
                              background:  sc?.bg    ?? 'var(--white)',
                              color:       sc?.color ?? 'var(--gray-500)',
                            }}
                            title={shoot.node_label ?? 'Tap to set status'}
                            onClick={e => { e.stopPropagation(); setStatusPickerCtx({ stem: activeStem!, node: shoot }); }}
                          >
                            {shootIcon
                              ? <img src={shootIcon} alt="" width={20} height={20} />
                              : srStatus
                                ? <span style={{ fontSize: 9, fontWeight: 700, lineHeight: 1 }}>
                                    {shortStatusLabel(srStatus).slice(0, 3)}
                                  </span>
                                : <span style={{ fontSize: 9, color: 'var(--gray-400)', lineHeight: 1 }}>
                                    {shoot.node_label ?? '?'}
                                  </span>}
                          </button>
                          <AttentionBadges attention={attentionByNode.get(shoot.id)} onOpen={() => setAttentionCtx({ stem: activeStem!, node: shoot })} />
                          </span>
                          <span className="shoot-node-cell-label">{cellLabel}</span>
                        </div>
                      );
                    })}
                    {hiddenCount > 0 && (
                      <span className="shoot-overflow-badge">+{hiddenCount}</span>
                    )}
                    <button
                      type="button"
                      className="stem-side-add-btn"
                      onClick={e => { e.stopPropagation(); void handleAddShoot(node, shootSide); }}
                    >+</button>
                  </div>
                );

                return (
                  <div key={node.id} className="stem-node-section">

                    {/* Left zone: shoots (even node) on the left; otherwise the node number */}
                    <div className="stem-side-zone stem-side-zone--left">
                      {shootSide === 'left'
                        ? shootZone
                        : <span className="stem-node-number-label">{node.node_number}</span>}
                    </div>

                    {/* Main zone: status icon inside circle + short label below */}
                    <div className="stem-main-zone">
                      <span className="attention-anchor">
                      <button
                        type="button"
                        className="stem-node-btn"
                        style={{
                          borderColor: cfg?.color ?? 'var(--gray-300)',
                          background:  cfg?.bg    ?? 'var(--white)',
                          color:       cfg?.color ?? 'var(--gray-600)',
                        }}
                        title={cfg ? cfg.label : 'Tap to set status'}
                        onClick={() => setStatusPickerCtx({ stem: activeStem!, node })}
                      >
                        {mainIcon
                          ? <img src={mainIcon} alt="" width={24} height={24} />
                          : nodeStatus
                            ? <span style={{ fontSize: 9, fontWeight: 700, lineHeight: 1 }}>
                                {shortStatusLabel(nodeStatus).slice(0, 3)}
                              </span>
                            : node.node_number}
                      </button>
                      <AttentionBadges attention={attentionByNode.get(node.id)} onOpen={() => setAttentionCtx({ stem: activeStem!, node })} />
                      </span>
                      {nodeStatus && (
                        <span className="stem-node-status-label">
                          {shortStatusLabel(nodeStatus)}
                        </span>
                      )}
                    </div>

                    {/* Right zone: shoots (odd node) on the right; otherwise the node number */}
                    <div className="stem-side-zone stem-side-zone--right">
                      {shootSide === 'right'
                        ? shootZone
                        : <span className="stem-node-number-label">{node.node_number}</span>}
                    </div>

                  </div>
                );
              })}
            </div>

            {/*
             * Secondary, node-aligned Veg Measurement Stem. Not a weekly
             * timeline — no week labels. Same node numbers as the main
             * stem above; growth_cm values sit in the gap below the node
             * that was the top of the stem when each reading was saved.
             */}
            {hasVegStem && (
              <div className="veg-stem-column">
                <div className="veg-stem-label">Veg</div>
                <div className="veg-stem-visual">
                  <div className="veg-stem-line" />
                  {vegRows.map(row => row.kind === 'node' ? (
                    <div key={`vn-${row.node.id}`} className="veg-stem-node-row">
                      <span className="veg-stem-node-dot" />
                      <span className="veg-stem-node-number">{row.node.node_number}</span>
                    </div>
                  ) : (
                    <div key={`vg-${row.growth.id}`} className="veg-stem-growth-row">
                      <span className="veg-stem-growth-value">{row.growth.growth_cm} cm</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
            </div>

          </div>
        ) : null}
      </div>

      {/* ── Add Stem modal ── */}
      {addStemModal && (
        <TextPromptModal
          title="Add Stem"
          label="Stem name or number"
          defaultValue={`Stem ${stems.length + 1}`}
          onClose={() => setAddStemModal(false)}
          onSave={handleAddStem}
        />
      )}

      {/* ── Veg growth modal ── */}
      {vegModal && (
        <div className="modal-overlay" onClick={() => setVegModal(false)}>
          <div className="modal" style={{ maxWidth: 380 }} onClick={e => e.stopPropagation()}>
            <div className="modal-title">
              Vegetative Growth
              {activeStem && (
                <span style={{ fontWeight: 400, color: 'var(--gray-500)', marginLeft: 8 }}>
                  {activeStem.stem_name}
                </span>
              )}
            </div>
            {vegError && <div className="alert alert-error">{vegError}</div>}
            <form onSubmit={handleSaveVeg}>
              <div className="form-group">
                <label className="form-label">Growth (cm)</label>
                <input
                  className="form-control mobile-control"
                  type="number"
                  step="0.1"
                  min="0.1"
                  placeholder="e.g. 8.5"
                  value={vegGrowthCm}
                  onChange={e => setVegGrowthCm(e.target.value)}
                  autoFocus
                />
              </div>
              <div className="form-group">
                <label className="form-label">Notes (optional)</label>
                <input
                  className="form-control"
                  type="text"
                  value={vegNotes}
                  onChange={e => setVegNotes(e.target.value)}
                />
              </div>
              <div className="modal-actions">
                <button type="button" className="btn btn-secondary" onClick={() => setVegModal(false)}>Cancel</button>
                <button type="submit" className="btn btn-primary" disabled={vegSaving}>
                  {vegSaving ? 'Saving…' : 'Save'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* ── Attention details ── */}
      {attentionCtx && (() => {
        const a = attentionByNode.get(attentionCtx.node.id);
        const label = attentionCtx.node.is_side_shoot ? `Shoot ${attentionCtx.node.node_label ?? ''}` : `Node ${attentionCtx.node.node_number}`;
        return (
          <div className="modal-overlay" onClick={() => setAttentionCtx(null)}>
            <div className="modal attention-modal" role="dialog" aria-label="Needs attention" onClick={e => e.stopPropagation()}>
              <div className="modal-title">
                {label}
                <span style={{ fontWeight: 400, color: 'var(--gray-500)', marginLeft: 8 }}>{attentionCtx.stem.stem_name}</span>
              </div>
              {!a && <p className="attention-line">Nothing needs attention on this node now.</p>}
              {a?.duplicate && (
                <div className="attention-item">
                  <span className="attention-item-icon"><WarningIcon /></span>
                  <div>
                    <p className="attention-line attention-line--title">Needs attention</p>
                    <p className="attention-line">{duplicateExplanation(a.duplicate)}</p>
                    <p className="attention-line attention-line--muted">Check on the plant which is which. This can’t be corrected from the phone yet.</p>
                  </div>
                </div>
              )}
              {a?.clock && (
                <div className="attention-item">
                  <span className="attention-item-icon"><ClockIcon /></span>
                  <div>
                    {a.clock.kind === 'overdue' ? (
                      <>
                        <p className="attention-line attention-line--title">Needs an update</p>
                        <p className="attention-line">Last updated {a.clock.ageDays} days ago (W{a.clock.week})</p>
                        <p className="attention-line attention-line--muted">{STATUS_CONFIG[a.clock.status].label} · update interval: {a.clock.intervalDays} days</p>
                      </>
                    ) : (
                      <>
                        <p className="attention-line attention-line--title">Needs an update</p>
                        <p className="attention-line">No status update recorded for this node.</p>
                        <p className="attention-line attention-line--muted">Added {a.clock.ageDays} days ago · update interval: {a.clock.intervalDays} days</p>
                      </>
                    )}
                  </div>
                </div>
              )}
              <div className="modal-actions">
                <button className="btn btn-secondary" onClick={() => setAttentionCtx(null)}>Close</button>
                <button className="btn btn-primary" onClick={() => { setStatusPickerCtx(attentionCtx); setAttentionCtx(null); }}>Set status</button>
              </div>
            </div>
          </div>
        );
      })()}

      {/* ── Status picker ── */}
      {statusPickerCtx && (
        <div className="modal-overlay" onClick={() => handleCancelStatusPicker()}>
          <div className="modal" style={{ maxWidth: 480 }} onClick={e => e.stopPropagation()}>
            <div className="modal-title">
              {pickerNodeLabel}
              <span style={{ fontWeight: 400, color: 'var(--gray-500)', marginLeft: 8 }}>
                {statusPickerCtx.stem.stem_name}
              </span>
            </div>
            {!statusPickerCtx.node.is_side_shoot && (
              <div className="form-group" style={{ marginBottom: 12 }}>
                <label className="form-label">Node Number</label>
                <select
                  className="form-control mobile-control"
                  value={statusPickerCtx.node.node_number}
                  onChange={e => handlePickerNodeSwitch(Number(e.target.value))}
                  disabled={saving}
                >
                  {Array.from({ length: 100 }, (_, i) => i + 1).map(n => (
                    <option key={n} value={n}>Node {n}</option>
                  ))}
                </select>
              </div>
            )}
            <div className="status-picker-grid">
              {STATUS_OPTIONS.map(opt => {
                const cfg = STATUS_CONFIG[opt.value];
                const currentRec = (statusesByStem[statusPickerCtx.stem.id] ?? []).find(
                  s => s.plant_node_id === statusPickerCtx.node.id,
                );
                const isActive = currentRec?.status === opt.value;
                const icon = getStatusIcon(opt.value);
                return (
                  <button
                    key={opt.value}
                    className={`status-picker-btn${isActive ? ' active' : ''}`}
                    style={isActive ? { borderColor: cfg.color, background: cfg.bg, color: cfg.color } : {}}
                    onClick={() => !saving && handleSaveStatus(opt.value)}
                    disabled={saving}
                  >
                    {icon && <img src={icon} alt="" width={32} height={32} style={{ flexShrink: 0 }} />}
                    <span>{opt.label}</span>
                  </button>
                );
              })}
            </div>
            <div className="modal-actions">
              <button className="btn btn-secondary" onClick={() => handleCancelStatusPicker()}>Cancel</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
