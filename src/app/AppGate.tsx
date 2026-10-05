import type { ReactNode } from 'react'
import { CenteredPanel } from '../components/CenteredPanel'
import { ErrorState, LoadingState } from '../components/States'
import { useAuth } from '../features/auth/AuthProvider'
import { SignInPage } from '../features/auth/SignInPage'
import { CreateOrganizationPage } from '../features/organization/CreateOrganizationPage'
import { OrganizationProvider, useOrganizationState } from '../features/organization/OrganizationProvider'
import { isSupabaseConfigured } from '../lib/supabase'

/** Renders the app only once there is a configured backend, a session and an organization. */
export function AppGate({ children }: { children: ReactNode }) {
  const { session, loading } = useAuth()

  if (!isSupabaseConfigured) {
    return (
      <CenteredPanel title="Plants" subtitle="Supabase is not configured.">
        <p className="form-notice">
          Set <code>VITE_SUPABASE_URL</code> and <code>VITE_SUPABASE_ANON_KEY</code> (see <code>.env.example</code>) and rebuild.
        </p>
      </CenteredPanel>
    )
  }
  if (loading) return <FullPageLoading />
  if (!session) return <SignInPage />

  return (
    <OrganizationProvider>
      <OrganizationGate>{children}</OrganizationGate>
    </OrganizationProvider>
  )
}

function OrganizationGate({ children }: { children: ReactNode }) {
  const { organization, loading, error } = useOrganizationState()
  if (loading) return <FullPageLoading />
  if (error) return <CenteredPanel title="Plants"><ErrorState error={error} /></CenteredPanel>
  if (!organization) return <CreateOrganizationPage />
  return <>{children}</>
}

function FullPageLoading() {
  return (
    <div className="centered-panel">
      <LoadingState />
    </div>
  )
}
