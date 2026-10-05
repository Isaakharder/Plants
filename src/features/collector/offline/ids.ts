/**
 * A new record ID, generated on the device before the record is queued. The
 * same ID is sent on every retry, so the database stores the record once.
 *
 * crypto.randomUUID only exists in secure contexts (HTTPS or localhost). When
 * the dev server is opened from a phone over plain http://<LAN IP>, fall back
 * to an equivalent RFC 4122 v4 UUID built from crypto.getRandomValues.
 */
export function newId(): string {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID()
  const b = crypto.getRandomValues(new Uint8Array(16))
  b[6] = (b[6] & 0x0f) | 0x40
  b[8] = (b[8] & 0x3f) | 0x80
  const h = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('')
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`
}
