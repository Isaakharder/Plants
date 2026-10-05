import { QueryClientProvider } from '@tanstack/react-query'
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom'
import { AuthProvider } from '../features/auth/AuthProvider'
import { CropDetailPage } from '../features/crops/CropDetailPage'
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
              <Route element={<AppLayout />}>
                {/* Settings is the only built-out page so far; Projections becomes home later. */}
                <Route index element={<Navigate to="/settings" replace />} />
                <Route path="projections" element={<ProjectionsPage />} />
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
