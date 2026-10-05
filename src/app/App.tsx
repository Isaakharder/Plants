import { QueryClientProvider } from '@tanstack/react-query'
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom'
import { AuthProvider } from '../features/auth/AuthProvider'
import { CollectorHomePage } from '../features/collector/CollectorHomePage'
import { CollectorLayout } from '../features/collector/CollectorLayout'
import { RowCanvasPage } from '../features/collector/RowCanvasPage'
import { CropDetailPage } from '../features/crops/CropDetailPage'
import { WeeklyPlantDataTab } from '../features/projections/WeeklyPlantDataTab'
import { queryClient } from '../lib/queryClient'
import { NotFoundPage } from '../pages/NotFoundPage'
import { PlantsPage } from '../pages/PlantsPage'
import { ProjectionsPage } from '../pages/ProjectionsPage'
import { SettingsPage } from '../pages/SettingsPage'
import { AppGate } from './AppGate'
import { AppLayout } from './AppLayout'

export function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <BrowserRouter>
          <AppGate>
            <Routes>
              {/* Mobile greenhouse collector: its own full-screen UI, no desktop top bar. */}
              <Route path="mobile" element={<CollectorLayout />}>
                <Route index element={<CollectorHomePage />} />
                <Route path="measurements" element={<CollectorHomePage />} />
                <Route path="row/:rowId" element={<RowCanvasPage />} />
              </Route>
              <Route element={<AppLayout />}>
                {/* Settings is the only built-out page so far; Projections becomes home later. */}
                <Route index element={<Navigate to="/settings" replace />} />
                <Route path="projections" element={<ProjectionsPage />}>
                  <Route index element={<Navigate to="weekly-plant-data" replace />} />
                  <Route path="weekly-plant-data" element={<WeeklyPlantDataTab />} />
                </Route>
                <Route path="plants" element={<PlantsPage />} />
                <Route path="settings" element={<SettingsPage />} />
                <Route path="settings/varieties/:cropId" element={<CropDetailPage />} />
                <Route path="*" element={<NotFoundPage />} />
              </Route>
            </Routes>
          </AppGate>
        </BrowserRouter>
      </AuthProvider>
    </QueryClientProvider>
  )
}
