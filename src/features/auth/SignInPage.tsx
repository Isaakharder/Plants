import { useState, type FormEvent } from 'react'
import { supabase } from '../../lib/supabase'
import { CenteredPanel } from '../../components/CenteredPanel'

type Mode = 'sign-in' | 'sign-up'

export function SignInPage() {
  const [mode, setMode] = useState<Mode>('sign-in')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    setBusy(true)
    setError(null)
    setNotice(null)
    const { data, error } =
      mode === 'sign-in'
        ? await supabase.auth.signInWithPassword({ email, password })
        : await supabase.auth.signUp({ email, password })
    setBusy(false)
    if (error) return setError(error.message)
    if (mode === 'sign-up' && !data.session) setNotice('Check your email to confirm your account, then sign in.')
  }

  return (
    <CenteredPanel title="Plants" subtitle={mode === 'sign-in' ? 'Sign in to your greenhouse' : 'Create your account'}>
      <form className="form" onSubmit={handleSubmit}>
        <label className="field">
          <span className="field-label">Email</span>
          <input className="input" type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
        </label>
        <label className="field">
          <span className="field-label">Password</span>
          <input
            className="input"
            type="password"
            autoComplete={mode === 'sign-in' ? 'current-password' : 'new-password'}
            minLength={8}
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </label>
        {error && <p className="form-error" role="alert">{error}</p>}
        {notice && <p className="form-notice">{notice}</p>}
        <button className="button button-primary button-block" type="submit" disabled={busy}>
          {busy ? 'Please wait…' : mode === 'sign-in' ? 'Sign in' : 'Create account'}
        </button>
      </form>
      <button className="button button-link" type="button" onClick={() => setMode(mode === 'sign-in' ? 'sign-up' : 'sign-in')}>
        {mode === 'sign-in' ? 'New to Plants? Create an account' : 'Already have an account? Sign in'}
      </button>
    </CenteredPanel>
  )
}
