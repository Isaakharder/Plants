import { useState, type FormEvent } from 'react'
import { useLocation } from 'react-router-dom'
import { supabase } from '../../lib/supabase'
import { CenteredPanel } from '../../components/CenteredPanel'
import { PASSWORD_RESET_ENABLED, resetRedirectUrl, resetRequestOutcome } from './passwordReset'

type Mode = 'sign-in' | 'sign-up' | 'forgot'

export function SignInPage() {
  // "Request a new link" on an expired reset link opens the reset form.
  const location = useLocation()
  const [mode, setMode] = useState<Mode>(PASSWORD_RESET_ENABLED && (location.state as { forgot?: boolean } | null)?.forgot ? 'forgot' : 'sign-in')
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

  // The same answer whether or not the address has an account (see resetRequestOutcome).
  async function handleForgot(e: FormEvent) {
    e.preventDefault()
    setBusy(true)
    setError(null)
    setNotice(null)
    const { error } = await supabase.auth.resetPasswordForEmail(email.trim(), { redirectTo: resetRedirectUrl(window.location.origin) })
    setBusy(false)
    const outcome = resetRequestOutcome(error)
    if (!outcome.sent) return setError(outcome.message)
    setNotice(`If an account exists for ${email.trim()}, we’ve sent it a link to choose a new password. The link works for 1 hour. Check your spam folder if it doesn’t arrive in a few minutes.`)
  }

  const switchMode = (next: Mode) => {
    setMode(next)
    setError(null)
    setNotice(null)
  }

  if (mode === 'forgot') {
    return (
      <CenteredPanel title="Plants" subtitle="Reset your password">
        <form className="form" onSubmit={handleForgot}>
          <p className="field-hint" style={{ margin: 0 }}>Enter the email you sign in with and we’ll send you a link to choose a new password.</p>
          <label className="field">
            <span className="field-label">Email</span>
            <input className="input" type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} autoFocus />
          </label>
          {error && <p className="form-error" role="alert">{error}</p>}
          {notice && <p className="form-notice" role="status">{notice}</p>}
          <button className="button button-primary button-block" type="submit" disabled={busy}>
            {busy ? 'Please wait…' : 'Send reset link'}
          </button>
        </form>
        <button className="button button-link" type="button" onClick={() => switchMode('sign-in')}>
          Back to sign in
        </button>
      </CenteredPanel>
    )
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
        {mode === 'sign-in' && PASSWORD_RESET_ENABLED && (
          <button className="forgot-password-link" type="button" onClick={() => switchMode('forgot')}>
            Forgot password?
          </button>
        )}
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
