import { useState, type FormEvent } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { supabase } from '../../lib/supabase'
import { useAuth } from '../auth/AuthProvider'
import { CenteredPanel } from '../../components/CenteredPanel'
import { organizationQueryKey } from './OrganizationProvider'

export function CreateOrganizationPage() {
  const userId = useAuth().session!.user.id
  const queryClient = useQueryClient()
  const [name, setName] = useState('')

  const create = useMutation({
    mutationFn: async (orgName: string) => {
      const { error } = await supabase.rpc('create_organization', { org_name: orgName })
      if (error) throw error
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: organizationQueryKey(userId) }),
  })

  function handleSubmit(e: FormEvent) {
    e.preventDefault()
    if (name.trim()) create.mutate(name.trim())
  }

  return (
    <CenteredPanel title="Welcome to Plants" subtitle="What's the name of your greenhouse operation?">
      <form className="form" onSubmit={handleSubmit}>
        <label className="field">
          <span className="field-label">Greenhouse name</span>
          <input className="input" required maxLength={120} autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. North Range Greenhouses" />
        </label>
        {create.error && <p className="form-error" role="alert">{create.error.message}</p>}
        <button className="button button-primary button-block" type="submit" disabled={create.isPending}>
          {create.isPending ? 'Creating…' : 'Continue'}
        </button>
      </form>
    </CenteredPanel>
  )
}
