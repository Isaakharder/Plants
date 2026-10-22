import { AuthApiError, AuthRetryableFetchError, AuthSessionMissingError, AuthWeakPasswordError } from '@supabase/supabase-js'
import { describe, expect, it } from 'vitest'
import { EXPIRED_LINK, newPasswordProblem, recoveryLinkFromUrl, resetRedirectUrl, resetRequestOutcome, updatePasswordMessage } from './passwordReset'

describe('the emailed link', () => {
  it('returns to the reset page of the app that asked (localhost or deployed)', () => {
    expect(resetRedirectUrl('http://127.0.0.1:5173')).toBe('http://127.0.0.1:5173/reset-password')
    expect(resetRedirectUrl('https://plants.example.app')).toBe('https://plants.example.app/reset-password')
  })

  it('recognises a recovery session, wherever Supabase redirected', () => {
    const hash = '#access_token=a.b.c&expires_in=3600&refresh_token=r&token_type=bearer&type=recovery'
    expect(recoveryLinkFromUrl({ pathname: '/reset-password', hash })).toEqual({ kind: 'recovery' })
    expect(recoveryLinkFromUrl({ pathname: '/', hash })).toEqual({ kind: 'recovery' }) // fell back to the site URL
    expect(recoveryLinkFromUrl({ pathname: '/', hash: '#access_token=a.b.c&type=signup' })).toBeNull()
    expect(recoveryLinkFromUrl({ pathname: '/settings', hash: '' })).toBeNull()
  })

  it('explains an expired or used link on the reset page', () => {
    const expired = '#error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid+or+has+expired'
    expect(recoveryLinkFromUrl({ pathname: '/reset-password', hash: expired })).toEqual({ kind: 'error', message: EXPIRED_LINK })
    expect(recoveryLinkFromUrl({ pathname: '/reset-password', hash: '#error=server_error&error_description=Boom' })).toEqual({ kind: 'error', message: 'Boom' })
    expect(recoveryLinkFromUrl({ pathname: '/reset-password', hash: '' })).toBeNull()
  })
})

describe('requesting a reset never reveals whether an account exists', () => {
  it('answers success, and the errors only an existing account can cause, the same way', () => {
    expect(resetRequestOutcome(null)).toEqual({ sent: true })
    // Per-address resend limit and email failures happen only for real accounts.
    expect(resetRequestOutcome(new AuthApiError('For security purposes, you can only request this after 42 seconds.', 429, 'over_email_send_rate_limit'))).toEqual({ sent: true })
    expect(resetRequestOutcome(new AuthApiError('Error sending recovery email', 500, 'unexpected_failure'))).toEqual({ sent: true })
  })

  it('shows problems that are the same for every address', () => {
    expect(resetRequestOutcome(new AuthRetryableFetchError('Failed to fetch', 0))).toMatchObject({ sent: false, message: expect.stringMatching(/connection/) })
    expect(resetRequestOutcome(new AuthApiError('Unable to validate email address: invalid format', 400, 'validation_failed'))).toEqual({ sent: false, message: 'Enter a valid email address.' })
  })
})

describe('choosing the new password', () => {
  it('checks length and confirmation before sending', () => {
    expect(newPasswordProblem('short', 'short')).toBe('Use at least 8 characters.')
    expect(newPasswordProblem('long-enough-1', 'long-enough-2')).toBe('The passwords don’t match.')
    expect(newPasswordProblem('long-enough-1', 'long-enough-1')).toBeNull()
  })

  it('explains a refused update', () => {
    expect(updatePasswordMessage(new AuthApiError('New password should be different from the old password.', 422, 'same_password'))).toBe('Choose a password different from your current one.')
    expect(updatePasswordMessage(new AuthWeakPasswordError('Password should be at least 10 characters.', 422, ['length']))).toBe('Password should be at least 10 characters.')
    expect(updatePasswordMessage(new AuthSessionMissingError())).toBe(EXPIRED_LINK)
    expect(updatePasswordMessage(new AuthApiError('invalid JWT', 401, 'bad_jwt'))).toBe(EXPIRED_LINK)
    expect(updatePasswordMessage(new AuthRetryableFetchError('Failed to fetch', 0))).toMatch(/connection/)
  })
})
