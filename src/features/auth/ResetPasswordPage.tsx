import { useState, type FormEvent } from 'react'
import { Navigate, useNavigate } from 'react-router-dom'
import { CenteredPanel } from '../../components/CenteredPanel'
import { supabase } from '../../lib/supabase'
import { signOut, useAuth, usePasswordRecovery } from './AuthProvider'
import { EXPIRED_LINK, MIN_PASSWORD_LENGTH, newPasswordProblem, updatePasswordMessage } from './passwordReset'

/** /reset-password: the page the emailed reset link opens, signed in with a recovery session. */
export function ResetPasswordPage() {
  const { session } = useAuth()
  const { recovery, endRecovery } = usePasswordRecovery()
  const navigate = useNavigate()
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [done, setDone] = useState(false)

  const leave = (state?: { forgot: true }) => {
    endRecovery()
    navigate('/', { replace: true, state })
  }

  if (done) {
    return (
      <CenteredPanel title="Plants" subtitle="Password changed">
        <p className="form-notice" role="status">Your password has been changed. Use it the next time you sign in.</p>
        <button className="button button-primary button-block" type="button" onClick={() => leave()}>
          Continue to Plants
        </button>
      </CenteredPanel>
    )
  }

  // Signed in normally (no reset link): nothing to do here.
  if (!recovery && session) return <Navigate to="/" replace />

  if (recovery?.kind === 'error' || !session) {
    return (
      <CenteredPanel title="Plants" subtitle="Reset your password">
        <p className="form-error" role="alert">{recovery?.kind === 'error' ? recovery.message : EXPIRED_LINK}</p>
        <button className="button button-primary button-block" type="button" onClick={() => leave({ forgot: true })}>
          Request a new link
        </button>
        <button className="button button-link" type="button" onClick={() => leave()}>
          Back to sign in
        </button>
      </CenteredPanel>
    )
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    const problem = newPasswordProblem(password, confirm)
    if (problem) return setError(problem)
    setBusy(true)
    setError(null)
    const { error } = await supabase.auth.updateUser({ password })
    setBusy(false)
    if (error) return setError(updatePasswordMessage(error))
    setDone(true)
  }

  return (
    <CenteredPanel title="Plants" subtitle="Choose a new password">
      <form className="form" onSubmit={handleSubmit} noValidate>
        <p className="field-hint" style={{ margin: 0 }}>
          For {session.user.email}. Use at least {MIN_PASSWORD_LENGTH} characters.
        </p>
        <label className="field">
          <span className="field-label">New password</span>
          <input className="input" type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} autoFocus />
        </label>
        <label className="field">
          <span className="field-label">Confirm new password</span>
          <input className="input" type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} />
        </label>
        {error && <p className="form-error" role="alert">{error}</p>}
        <button className="button button-primary button-block" type="submit" disabled={busy}>
          {busy ? 'Please wait…' : 'Save new password'}
        </button>
      </form>
      <button className="button button-link" type="button" disabled={busy} onClick={() => void signOut().then(() => leave())}>
        Cancel and sign out
      </button>
    </CenteredPanel>
  )
}
