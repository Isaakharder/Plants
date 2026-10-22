// Password reset with Supabase Auth's recovery flow. "Forgot password?" asks
// Supabase to email a link; the link opens /reset-password on the same origin
// the request came from (localhost or the deployed app), signed in with a
// short-lived recovery session: tokens in the URL hash, which supabase-js reads,
// or an error in the hash when the link is expired or already used. Pure, so
// it can be tested.

import { isAuthRetryableFetchError, isAuthSessionMissingError, type AuthError } from '@supabase/supabase-js'

export const RESET_PATH = '/reset-password'

/**
 * Shown only when VITE_PASSWORD_RESET is "on": off by default until Supabase
 * sends the reset emails through a real email provider (Resend). Off, the
 * sign-in page has no "Forgot password?" link and reset links are ignored.
 */
export const PASSWORD_RESET_ENABLED = import.meta.env.VITE_PASSWORD_RESET === 'on'

/** Same minimum as sign-up. */
export const MIN_PASSWORD_LENGTH = 8

/** Where the emailed link sends the user: this app's own reset page. */
export const resetRedirectUrl = (origin: string) => `${origin}${RESET_PATH}`

export type RecoveryLink = { kind: 'recovery' } | { kind: 'error'; message: string }

export const EXPIRED_LINK = 'This reset link has expired or was already used. Request a new one.'

/** What the emailed link carried in the URL, read before supabase-js clears the hash. */
export function recoveryLinkFromUrl(location: { pathname: string; hash: string }): RecoveryLink | null {
  const params = new URLSearchParams(location.hash.replace(/^#/, ''))
  if (params.get('type') === 'recovery' && params.get('access_token')) return { kind: 'recovery' }
  if (location.pathname !== RESET_PATH) return null
  const code = params.get('error_code')
  if (code === 'otp_expired' || code === 'access_denied') return { kind: 'error', message: EXPIRED_LINK }
  if (code || params.get('error')) return { kind: 'error', message: params.get('error_description') || EXPIRED_LINK }
  return null
}

export type RequestOutcome = { sent: true } | { sent: false; message: string }

/**
 * The answer to a reset request. It never reveals whether the address has an
 * account. Supabase answers an unknown address with success, so the errors
 * that only an existing account can produce (the per-address resend limit, a
 * failed email) get the same answer as success. Only problems that are the
 * same for every address are shown: no connection, or an invalid email.
 */
export function resetRequestOutcome(error: AuthError | null): RequestOutcome {
  if (!error) return { sent: true }
  if (isAuthRetryableFetchError(error)) return { sent: false, message: 'Couldn’t reach the server. Check your connection and try again.' }
  if (error.code === 'validation_failed' || error.code === 'email_address_invalid') return { sent: false, message: 'Enter a valid email address.' }
  return { sent: true }
}

/** Client-side checks before the new password is sent. */
export function newPasswordProblem(password: string, confirm: string): string | null {
  if (password.length < MIN_PASSWORD_LENGTH) return `Use at least ${MIN_PASSWORD_LENGTH} characters.`
  if (password !== confirm) return 'The passwords don’t match.'
  return null
}

/** A failed password update, in plain words. */
export function updatePasswordMessage(error: AuthError): string {
  if (isAuthRetryableFetchError(error)) return 'Couldn’t reach the server. Check your connection and try again.'
  if (error.code === 'same_password') return 'Choose a password different from your current one.'
  if (error.code === 'weak_password') return error.message
  if (error.status === 401 || error.status === 403 || isAuthSessionMissingError(error) || error.code === 'session_not_found' || error.code === 'bad_jwt')
    return EXPIRED_LINK
  return error.message
}
