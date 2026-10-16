// Adapted from CropLink client/src/pages/RowCanvasPage.tsx. The canvas, status
// picker and Veg column render as in CropLink. Changes:
//   * data comes from ./api (Supabase as the signed-in user + offline queue);
//     seasons and temp-ID remapping are gone
//   * the week is evaluated when each status / growth reading is saved
//   * the header (row, variety, colour) is loaded by rowId, so a reload or a
//     deep link no longer shows "Variety / Row"
//   * legacy CropLink statuses (GolfBall, Harvestable, …) are not carried over

import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { useLocation, useNavigate, useParams } from 'react-router-dom';
import { useAuth } from '../auth/AuthProvider';
import { duplicateExplanation, rowAttention, useNow, type NodeAttention } from './attention';
import { COLORS } from '../plantArt/colors';
import { statusTone } from '../plantArt/frames';
import { StatusIcon } from '../plantArt/StatusArt';
import { useOrganization } from '../organization/OrganizationProvider';
import { NotOnDeviceError, useAttentionRules, useCollectorActions, useCollectorCrops, useMobileStatusOptions, useRowCanvas } from './api';
import { pickerOptions } from './statusOptions';
import { BreakerCapture, type CaptureMode } from './BreakerCapture';
import { BreakerRecorded } from './BreakerRecorded';
import { BREAKER_PHOTOS_ENABLED, type PreparedPhoto } from './photos';
import { captureDrafts, draftAlreadySaved, draftKey, freshDrafts, type CaptureDraft } from './offline/captureDrafts';
import { OfflineBanner } from './components/OfflineBanner';
import { TextPromptModal } from './components/TextPromptModal';
import { cropColorVar, type CanvasState } from './display';
import { useGreenhouseWeek } from './greenhouseWeek';
import type { LatestNodeStatus, MeasurementStem, NodeStatus, PlantNode, StemGrowthMeasurement } from './types';

const STATUS_LABEL: Record<NodeStatus, string> = {
  Aborted:      'Aborted',
  Pruned:       'Pruned',
  Flower:       'Flower',
  SetFruit:     'Set Fruit',
  MatureGreen:  'Mature Green',
  BreakerFruit: 'Breaker Fruit',
  Harvested:    'Harvested',
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
  // Breaker artwork and harvest scars use the variety's colour, as on the Plants page.
  const artVariety  = varietyColor ?? COLORS.matureGreen;

  const [activeStemIndex, setActiveStemIndex] = useState(0);
  const [addStemModal,    setAddStemModal]    = useState(false);
  const [statusPickerCtx, setStatusPickerCtx] = useState<{ stem: MeasurementStem; node: PlantNode; isNew?: boolean } | null>(null);
  const [attentionCtx, setAttentionCtx] = useState<{ stem: MeasurementStem; node: PlantNode } | null>(null);
  const [saving,   setSaving]   = useState(false);
  // Camera-first Breaker: the picker shows the photo step instead of saving straight away.
  // 'auto': a Breaker recorded this week shows what was saved, otherwise the status grid.
  // Kept per node, so switching node or closing the picker starts again at 'auto'.
  type PickerStep = 'auto' | 'grid' | 'recorded' | 'capture' | { replace: CaptureMode & { kind: 'replace' }; current: Partial<Record<'front' | 'back', string>> };
  const [pickerStep, setPickerStepState] = useState<{ nodeId: string; step: PickerStep } | null>(null);
  const setPickerStep = (nodeId: string, step: PickerStep) => setPickerStepState({ nodeId, step });
  const closeBreakerStep = () => setPickerStepState(null);
  // Breaker photos taken on this phone but not saved yet (e.g. the page reloaded after the camera).
  const [drafts, setDrafts] = useState<CaptureDraft[]>([]);
  useEffect(() => {
    let cancelled = false;
    void freshDrafts(captureDrafts(), userId).then(d => !cancelled && setDrafts(d)).catch(() => {});
    return () => { cancelled = true; };
  }, [userId, statusPickerCtx]);
  // A new-Breaker draft whose node was recorded as Breaker after the photos were
  // started is a leftover of that save: discard it rather than offer "Finish".
  useEffect(() => {
    const statuses = canvasQuery.data?.statuses;
    if (!statuses || drafts.length === 0) return;
    const saved = drafts.filter(d => draftAlreadySaved(d, statuses.find(s => s.plant_node_id === d.nodeId)));
    if (saved.length === 0) return;
    void Promise.all(saved.map(d => captureDrafts().delete(d.key))).catch(() => {});
    setDrafts(list => list.filter(d => !saved.includes(d)));
  }, [drafts, canvasQuery.data]);
  const [message,  setMessage]  = useState('');

  /** The node's Breaker of this greenhouse week, if one is recorded (queued writes included). */
  const breakerThisWeek = (stemId: string, nodeId: string): LatestNodeStatus | null => {
    const latest = (statusesByStem[stemId] ?? []).find(s => s.plant_node_id === nodeId);
    return latest && latest.status === 'BreakerFruit' && latest.year === currentYear && latest.week_number === currentWeek ? latest : null;
  };

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
  const { enabled: enabledStatuses } = useMobileStatusOptions(organization.id, userId);
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

  /** Breaker with its front and back photos (kept on the phone until they upload). */
  async function handleSaveBreakerPhotos(photos: PreparedPhoto[], timing: { captureSeconds: number }): Promise<boolean> {
    if (!statusPickerCtx) return false;
    // Never a second Breaker of the same pepper (e.g. a photo step left open on another screen).
    if (breakerThisWeek(statusPickerCtx.stem.id, statusPickerCtx.node.id)) {
      setPickerStep(statusPickerCtx.node.id, 'recorded');
      return false;
    }
    setSaving(true);
    try {
      await actions.recordBreakerWithPhotos(statusPickerCtx.node, photos, timing);
      // The photos are queued now: the photo step deletes its draft.
      setDrafts(d => d.filter(x => x.nodeId !== statusPickerCtx.node.id));
      const nodeLabel = statusPickerCtx.node.is_side_shoot
        ? (statusPickerCtx.node.node_label ?? 'Shoot')
        : `Node ${statusPickerCtx.node.node_number}`;
      setMessage(`${nodeLabel}: ${STATUS_LABEL.BreakerFruit} · 2 photos saved on this phone${navigator.onLine ? '' : ' (they upload when the connection returns)'}`);
      closeBreakerStep();
      setStatusPickerCtx(null);
      return true;
    } catch (err: unknown) {
      setMessage(`Not saved: ${err instanceof Error ? err.message : 'Save failed'}`);
      return false;
    } finally {
      setSaving(false);
    }
  }

  /** New photos for the Breaker already recorded (the same record; earlier photos are kept). */
  async function handleReplaceBreakerPhotos(
    photos: PreparedPhoto[],
    meta: { captureSeconds: number; reason: string | null },
    observationId: string,
    current: Partial<Record<'front' | 'back', string>>,
  ): Promise<boolean> {
    if (!statusPickerCtx) return false;
    setSaving(true);
    try {
      await actions.replaceBreakerPhotos(statusPickerCtx.node, observationId, photos, current, { captureSeconds: meta.captureSeconds, reason: meta.reason ?? 'Replaced' });
      setDrafts(d => d.filter(x => x.nodeId !== statusPickerCtx.node.id));
      const nodeLabel = statusPickerCtx.node.is_side_shoot
        ? (statusPickerCtx.node.node_label ?? 'Shoot')
        : `Node ${statusPickerCtx.node.node_number}`;
      const n = photos.length;
      setMessage(`${nodeLabel}: ${n} new photo${n === 1 ? '' : 's'} saved on this phone for the same Breaker${navigator.onLine ? '' : ' (they upload when the connection returns)'}`);
      closeBreakerStep();
      setStatusPickerCtx(null);
      return true;
    } catch (err: unknown) {
      setMessage(`Not saved: ${err instanceof Error ? err.message : 'Save failed'}`);
      return false;
    } finally {
      setSaving(false);
    }
  }

  async function handleSaveStatus(status: NodeStatus) {
    if (!statusPickerCtx) return;
    setSaving(true);
    try {
      await actions.recordStatus(statusPickerCtx.node, status);
      const nodeLabel = statusPickerCtx.node.is_side_shoot
        ? (statusPickerCtx.node.node_label ?? 'Shoot')
        : `Node ${statusPickerCtx.node.node_number}`;
      setMessage(`${nodeLabel}: ${STATUS_LABEL[status]}`);
      closeBreakerStep();
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

  // The Breaker step shown in the picker (see PickerStep).
  const recordedBreaker = statusPickerCtx ? breakerThisWeek(statusPickerCtx.stem.id, statusPickerCtx.node.id) : null;
  const chosenStep = statusPickerCtx && pickerStep?.nodeId === statusPickerCtx.node.id ? pickerStep.step : 'auto';
  const pickerStepNow: PickerStep = chosenStep === 'auto' ? (recordedBreaker && BREAKER_PHOTOS_ENABLED ? 'recorded' : 'grid') : chosenStep;

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

      {/* ── Breaker photos taken but not saved (e.g. the page reloaded after the camera) ── */}
      {(() => {
        const here = drafts
          .map(d => ({ d, stemIndex: stems.findIndex(s => s.id === d.stemId), node: (nodesByStem[d.stemId] ?? []).find(n => n.id === d.nodeId) }))
          .filter(x => x.stemIndex >= 0 && x.node);
        if (here.length === 0) return null;
        return (
          <div className="breaker-drafts" role="status">
            {here.map(({ d, stemIndex, node }) => (
              <div key={d.key} className="breaker-draft">
                <span>
                  Unsaved Breaker photos: <strong>{node!.is_side_shoot ? (node!.node_label ?? 'Shoot') : `Node ${node!.node_number}`}</strong> · {stems[stemIndex].stem_name}
                </span>
                <button
                  type="button"
                  className="btn btn-primary btn-sm"
                  onClick={() => {
                    setActiveStemIndex(stemIndex);
                    setStatusPickerCtx({ stem: stems[stemIndex], node: node! });
                    // A replacement's photos come back under "Replace photos" of the recorded Breaker.
                    setPickerStep(node!.id, d.replacing ? 'recorded' : 'capture');
                  }}
                >
                  Finish
                </button>
              </div>
            ))}
          </div>
        );
      })()}

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
                const tone = statusTone(nodeStatus, artVariety);

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
                      const shootTone = statusTone(srStatus, artVariety);
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
                              borderColor: srStatus ? shootTone.ring : 'var(--gray-300)',
                              background:  srStatus ? shootTone.background : 'var(--white)',
                              color:       'var(--gray-500)',
                            }}
                            title={shoot.node_label ?? 'Tap to set status'}
                            onClick={e => { e.stopPropagation(); setStatusPickerCtx({ stem: activeStem!, node: shoot }); }}
                          >
                            {srStatus
                              ? <StatusIcon status={srStatus} size={22} variety={artVariety} />
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
                          borderColor: nodeStatus ? tone.ring : 'var(--gray-300)',
                          background:  nodeStatus ? tone.background : 'var(--white)',
                          color:       'var(--gray-600)',
                        }}
                        title={nodeStatus ? STATUS_LABEL[nodeStatus] : 'Tap to set status'}
                        onClick={() => setStatusPickerCtx({ stem: activeStem!, node })}
                      >
                        {nodeStatus
                          ? <StatusIcon status={nodeStatus} size={30} variety={artVariety} />
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
                        <p className="attention-line attention-line--muted">{STATUS_LABEL[a.clock.status]} · update interval: {a.clock.intervalDays} days</p>
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
        <div className="modal-overlay" onClick={() => { if (!saving) { closeBreakerStep(); handleCancelStatusPicker(); } }}>
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
                  // Photos belong to the node shown: go Back to change it.
                  disabled={saving || pickerStepNow === 'capture' || typeof pickerStepNow === 'object'}
                >
                  {Array.from({ length: 100 }, (_, i) => i + 1).map(n => (
                    <option key={n} value={n}>Node {n}</option>
                  ))}
                </select>
              </div>
            )}
            {pickerStepNow === 'capture' ? (
              <BreakerCapture
                userId={userId}
                nodeId={statusPickerCtx.node.id}
                stemId={statusPickerCtx.stem.id}
                nodeLabel={pickerNodeLabel}
                mode={{ kind: 'new' }}
                saving={saving}
                onSave={(photos, meta) => handleSaveBreakerPhotos(photos, meta)}
                onManual={() => {
                  // Recorded without photos: any photos kept for this node are no longer wanted.
                  void captureDrafts().delete(draftKey(userId, statusPickerCtx.node.id)).catch(() => {});
                  void handleSaveStatus('BreakerFruit');
                }}
                onBack={() => setPickerStep(statusPickerCtx.node.id, 'grid')}
              />
            ) : typeof pickerStepNow === 'object' ? (
              <BreakerCapture
                userId={userId}
                nodeId={statusPickerCtx.node.id}
                stemId={statusPickerCtx.stem.id}
                nodeLabel={pickerNodeLabel}
                mode={pickerStepNow.replace}
                saving={saving}
                onSave={(photos, meta) => handleReplaceBreakerPhotos(photos, meta, pickerStepNow.replace.observationId, pickerStepNow.current)}
                onManual={() => {}}
                onBack={() => setPickerStep(statusPickerCtx.node.id, 'recorded')}
              />
            ) : pickerStepNow === 'recorded' && recordedBreaker ? (
              <BreakerRecorded
                userId={userId}
                nodeLabel={pickerNodeLabel}
                observation={recordedBreaker}
                onReplace={(current, hasPhotos) =>
                  setPickerStep(statusPickerCtx.node.id, {
                    replace: { kind: 'replace', observationId: recordedBreaker.id, recordedAt: recordedBreaker.observed_at, hasPhotos },
                    current,
                  })
                }
                onChangeStatus={() => setPickerStep(statusPickerCtx.node.id, 'grid')}
                onDone={() => { closeBreakerStep(); void handleCancelStatusPicker(); }}
              />
            ) : (
            <div className="status-picker-grid">
              {(() => {
                const currentRec = (statusesByStem[statusPickerCtx.stem.id] ?? []).find(
                  s => s.plant_node_id === statusPickerCtx.node.id,
                );
                // Only the organization's enabled statuses; a hidden current status still shows, but can't be chosen.
                return pickerOptions(enabledStatuses, currentRec?.status).map(opt => {
                const tone = statusTone(opt.value, artVariety);
                const isActive = currentRec?.status === opt.value;
                return (
                  <button
                    key={opt.value}
                    className={`status-picker-btn${isActive ? ' active' : ''}`}
                    style={isActive ? { borderColor: tone.ring, background: tone.background } : {}}
                    onClick={() => {
                      if (saving || opt.hidden) return;
                      // Breaker: photograph front and back first (manual entry stays available).
                      // Already recorded this week: show that record, never start a second Breaker.
                      if (opt.value === 'BreakerFruit' && BREAKER_PHOTOS_ENABLED) setPickerStep(statusPickerCtx.node.id, recordedBreaker ? 'recorded' : 'capture');
                      else void handleSaveStatus(opt.value);
                    }}
                    disabled={saving || opt.hidden}
                    title={opt.hidden ? 'Current status. Not offered for new entries (Settings › Mobile status options).' : undefined}
                  >
                    <span className="status-picker-art"><StatusIcon status={opt.value} size={34} variety={artVariety} /></span>
                    <span>{opt.label}</span>
                  </button>
                );
                });
              })()}
            </div>
            )}
            <div className="modal-actions">
              <button className="btn btn-secondary" disabled={saving} onClick={() => { closeBreakerStep(); handleCancelStatusPicker(); }}>Cancel</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
