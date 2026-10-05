// Adapted from CropLink client/src/pages/MobileMeasurementsPage.tsx.
// Same screen; varieties are now the organization's active Plants crops and
// all data access goes through ./api (Supabase + offline queue).

import { useEffect, useMemo, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from 'react-router-dom';
import { useAuth } from '../auth/AuthProvider';
import { cropStatus } from '../crops/model';
import { useOrganization } from '../organization/OrganizationProvider';
import { NotOnDeviceError, prefetchRowCanvases, useCollectorActions, useCollectorCrops, useRowCards } from './api';
import { OfflineBanner } from './components/OfflineBanner';
import { TextPromptModal } from './components/TextPromptModal';
import { useGreenhouseWeek } from './greenhouseWeek';
import type { CollectorCrop, MobileRowCard } from './types';
import { cropColorVar, type CanvasState } from './display';

export function CollectorHomePage() {
  const { week: currentWeek, dayLabel: todayLabel } = useGreenhouseWeek(); // greenhouse (Toronto) week, not the device clock

  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const organization = useOrganization();
  const userId = useAuth().session!.user.id;
  const actions = useCollectorActions();

  const cropsQuery = useCollectorCrops(organization.id, userId);
  const rowCardsQuery = useRowCards(organization.id, userId);
  const [addRowTarget, setAddRowTarget] = useState<CollectorCrop | null>(null);

  // Active plantings (between planting and pullout dates), by name — CropLink
  // listed the season's active varieties by name.
  const varieties = useMemo(
    () => (cropsQuery.data ?? []).filter(c => cropStatus(c) === 'active'),
    [cropsQuery.data],
  );
  const loadingVarieties = cropsQuery.data === undefined;

  const rowCardsByVariety = useMemo(() => {
    if (!rowCardsQuery.data) return {} as Record<string, MobileRowCard[] | undefined>;
    const byCrop: Record<string, MobileRowCard[] | undefined> = {};
    for (const variety of varieties) {
      byCrop[variety.id] = rowCardsQuery.data
        .filter(r => r.crop_id === variety.id)
        .sort((a, b) => a.sort_order - b.sort_order || a.row_name.localeCompare(b.row_name));
    }
    return byCrop;
  }, [rowCardsQuery.data, varieties]);

  // Keep every row of the active varieties on the device for offline use.
  const activeRowIds = useMemo(
    () => Object.values(rowCardsByVariety).flatMap(cards => (cards ?? []).map(c => c.id)),
    [rowCardsByVariety],
  );
  useEffect(() => {
    if (activeRowIds.length > 0 && rowCardsQuery.isFetchedAfterMount) void prefetchRowCanvases(queryClient, activeRowIds, userId);
  }, [activeRowIds, rowCardsQuery.isFetchedAfterMount, queryClient, userId]);

  async function handleAddRow(variety: CollectorCrop, rowName: string) {
    await actions.createRow(variety.id, rowName, (rowCardsByVariety[variety.id]?.length ?? 0) + 1);
  }

  function openCanvas(row: MobileRowCard, variety: CollectorCrop) {
    const state: CanvasState = {
      rowName: row.row_name,
      varietyId: variety.id,
      varietyName: variety.name,
      varietyColor: cropColorVar(variety.color),
    };
    navigate(`/mobile/row/${row.id}`, { state });
  }


  return (
    <div className="mobile-page">
      <header className="mobile-header">
        <div>
          <h1>Measurements</h1>
          <p>{todayLabel} &middot; Week {currentWeek}</p>
        </div>
        <Link className="btn btn-secondary" to="/plants">Desktop</Link>
      </header>

      <OfflineBanner />
      <div className="mobile-content">
        {cropsQuery.error instanceof NotOnDeviceError && loadingVarieties ? (
          <div className="collector-empty card">Offline. Varieties will load when the connection returns.</div>
        ) : cropsQuery.isError && loadingVarieties ? (
          <div className="collector-empty card">Couldn&rsquo;t load varieties. {cropsQuery.error.message}</div>
        ) : loadingVarieties ? (
          <div className="collector-empty card">Loading varieties…</div>
        ) : varieties.length === 0 ? (
          <div className="collector-empty card">No active varieties. Add them in Settings.</div>
        ) : (
          varieties.map(variety => {
            const rowCards = rowCardsByVariety[variety.id];
            const varietyColor = cropColorVar(variety.color);
            return (
              <section key={variety.id} style={{ marginBottom: 28 }}>
                <div className="variety-section-header">
                  <div className="variety-section-title">
                    <span className="variety-color-dot" style={{ background: varietyColor }} />
                    <span>{variety.name}</span>
                  </div>
                  <button
                    className="btn btn-primary btn-sm"
                    onClick={() => setAddRowTarget(variety)}
                  >
                    + Add Row
                  </button>
                </div>

                {rowCards === undefined ? (
                  <div style={{ color: 'var(--gray-400)', fontSize: 13, padding: '8px 0' }}>
                    {rowCardsQuery.error instanceof NotOnDeviceError
                      ? 'Offline. Rows will load when the connection returns.'
                      : rowCardsQuery.isError ? `Couldn’t load rows. ${rowCardsQuery.error.message}` : 'Loading rows…'}
                  </div>
                ) : rowCards.length === 0 ? (
                  <div className="collector-empty" style={{ padding: 16, fontSize: 13 }}>
                    No rows yet. Tap + Add Row to create one.
                  </div>
                ) : (
                  <div className="row-card-grid">
                    {rowCards.map(row => (
                      <button
                        key={row.id}
                        className="row-card"
                        onClick={() => openCanvas(row, variety)}
                      >
                        <div className="row-card-name">{row.row_name}</div>
                        <div className="row-card-meta">
                          <span>{row.stem_count} stem{row.stem_count !== 1 ? 's' : ''}</span>
                          <span>Wk {currentWeek}</span>
                        </div>
                        <div className="row-card-footer">
                          <span>
                            {new Date(row.last_updated).toLocaleDateString(undefined, {
                              month: 'short',
                              day: 'numeric',
                            })}
                          </span>
                          <span className="row-card-color-dot" style={{ background: varietyColor }} />
                        </div>
                      </button>
                    ))}
                  </div>
                )}
              </section>
            );
          })
        )}
      </div>

      {addRowTarget && (
        <TextPromptModal
          title={`Add Row — ${addRowTarget.name}`}
          label="Row number or name"
          defaultValue="Row "
          onClose={() => setAddRowTarget(null)}
          onSave={async value => {
            await handleAddRow(addRowTarget, value);
          }}
        />
      )}
    </div>
  );
}
