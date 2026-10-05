import { useQueryClient } from '@tanstack/react-query'
import { useEffect } from 'react'
import { Outlet } from 'react-router-dom'
import { useAuth } from '../auth/AuthProvider'
import { collectorKeys } from './api'
import { onSynced, startCollectorSync } from './offline/networkStatus'
import './collector.css'

/**
 * Root of the mobile collector (/mobile/*): its own visual environment, outside
 * the desktop AppLayout. All collector CSS is scoped beneath .collector-app.
 */
export function CollectorLayout() {
  const userId = useAuth().session!.user.id
  const queryClient = useQueryClient()

  useEffect(() => startCollectorSync(userId), [userId])
  // Once queued writes reach the database, reload server data.
  useEffect(() => onSynced(() => void queryClient.invalidateQueries({ queryKey: collectorKeys.all })), [queryClient])

  return (
    <div className="collector-app">
      <Outlet />
    </div>
  )
}
