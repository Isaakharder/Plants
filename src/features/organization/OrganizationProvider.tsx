import { createContext, useContext, type ReactNode } from 'react'
import { useQuery } from '@tanstack/react-query'
import { supabase } from '../../lib/supabase'
import { useAuth } from '../auth/AuthProvider'

export type Organization = { id: string; name: string; role: 'owner' | 'member' }

type OrganizationState = {
  organization: Organization | null
  loading: boolean
  error: Error | null
}

const OrganizationContext = createContext<OrganizationState>({ organization: null, loading: true, error: null })

export const organizationQueryKey = (userId: string) => ['organization', userId] as const

async function fetchOrganization(userId: string): Promise<Organization | null> {
  const { data, error } = await supabase
    .from('organization_members')
    .select('role, organizations(id, name)')
    .eq('user_id', userId)
    .order('created_at')
    .limit(1)
    .maybeSingle()
  if (error) throw error
  if (!data?.organizations) return null
  return { id: data.organizations.id, name: data.organizations.name, role: data.role }
}

// Users currently work in a single organization (their first membership).
// Multi-organization switching can be layered on here later.
export function OrganizationProvider({ children }: { children: ReactNode }) {
  const userId = useAuth().session?.user.id
  const query = useQuery({
    queryKey: organizationQueryKey(userId ?? ''),
    queryFn: () => fetchOrganization(userId!),
    enabled: Boolean(userId),
  })

  return (
    <OrganizationContext.Provider value={{ organization: query.data ?? null, loading: query.isPending, error: query.error }}>
      {children}
    </OrganizationContext.Provider>
  )
}

export const useOrganizationState = () => useContext(OrganizationContext)

/** For use inside screens that only render once an organization exists. */
export function useOrganization(): Organization {
  const { organization } = useContext(OrganizationContext)
  if (!organization) throw new Error('useOrganization used outside an organization')
  return organization
}
