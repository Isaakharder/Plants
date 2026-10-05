import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'
import { isAuthRetryableFetchError, type Session } from '@supabase/supabase-js'
import { authStorageKey, supabase } from '../../lib/supabase'

type AuthState = { session: Session | null; loading: boolean }

const AuthContext = createContext<AuthState>({ session: null, loading: true })

/**
 * The session saved on this device, even if its access token has expired.
 * Offline, supabase-js can't refresh an expired token, so it keeps the saved
 * session but reports none. The mobile collector must still open in the
 * greenhouse with no signal: cached data is shown, writes are queued, and
 * supabase-js refreshes the token once the connection returns. Nothing is
 * sent to the server with this session; RLS still applies to every request.
 */
function savedSession(): Session | null {
  try {
    const saved = JSON.parse(localStorage.getItem(authStorageKey) ?? 'null') as Session | null
    return saved?.refresh_token && saved.user?.id ? saved : null
  } catch {
    return null
  }
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AuthState>({ session: null, loading: true })

  useEffect(() => {
    // Offline with an expired token, supabase-js retries the refresh for up to
    // 30 s before answering. Don't keep the collector waiting that long: use the
    // saved session straight away when the device is offline (after 3 s when it
    // only looks online), and let getSession() correct it when it answers.
    let answered = false
    const saved = savedSession()
    const provisional = saved
      ? window.setTimeout(() => !answered && setState({ session: saved, loading: false }), navigator.onLine ? 3000 : 0)
      : undefined
    supabase.auth.getSession().then(({ data, error }) => {
      answered = true
      window.clearTimeout(provisional)
      const offline = !data.session && isAuthRetryableFetchError(error)
      setState({ session: data.session ?? (offline ? savedSession() : null), loading: false })
    })
    const { data } = supabase.auth.onAuthStateChange((event, session) => {
      // The initial state comes from getSession() above, which can tell an
      // offline refresh failure apart from being signed out.
      if (event === 'INITIAL_SESSION') return
      setState({ session, loading: false })
    })
    return () => data.subscription.unsubscribe()
  }, [])

  return <AuthContext.Provider value={state}>{children}</AuthContext.Provider>
}

export const useAuth = () => useContext(AuthContext)

export const signOut = () => supabase.auth.signOut()
