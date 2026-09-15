// Credencial de sesión (Semana 2): firmada con HMAC-SHA256 sobre
// SESSION_SIGNING_SECRET, no hay estado del lado del servidor (no hace
// falta una tabla `sessions`). La emite POST /register y la exige
// GET /ws antes de reenviar nada al Durable Object — ver index.ts.
//
// Formato: base64url(JSON payload) + "." + base64url(firma HMAC del payload).
// Verificación con crypto.subtle.verify (tiempo constante), no comparación
// manual de strings.

export interface SessionPayload {
  roomId: string
  userId: string
  nombre: string
  exp: number // epoch ms
}

function toBase64Url(bytes: Uint8Array): string {
  let binary = ''
  for (const b of bytes) binary += String.fromCharCode(b)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function fromBase64Url(s: string): Uint8Array {
  const padded = s.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(s.length / 4) * 4, '=')
  const binary = atob(padded)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, [
    'sign',
    'verify',
  ])
}

export async function signSessionToken(
  env: { SESSION_SIGNING_SECRET: string },
  payload: Omit<SessionPayload, 'exp'>,
  ttlSeconds: number
): Promise<string> {
  const full: SessionPayload = { ...payload, exp: Date.now() + ttlSeconds * 1000 }
  const payloadB64 = toBase64Url(new TextEncoder().encode(JSON.stringify(full)))
  const key = await hmacKey(env.SESSION_SIGNING_SECRET)
  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payloadB64))
  return `${payloadB64}.${toBase64Url(new Uint8Array(signature))}`
}

export async function verifySessionToken(
  env: { SESSION_SIGNING_SECRET: string },
  token: string,
  expectedRoomId: string
): Promise<SessionPayload | null> {
  const parts = token.split('.')
  if (parts.length !== 2) return null
  const [payloadB64, sigB64] = parts

  const key = await hmacKey(env.SESSION_SIGNING_SECRET)
  const valid = await crypto.subtle.verify(
    'HMAC',
    key,
    fromBase64Url(sigB64),
    new TextEncoder().encode(payloadB64)
  )
  if (!valid) return null

  let payload: SessionPayload
  try {
    payload = JSON.parse(new TextDecoder().decode(fromBase64Url(payloadB64)))
  } catch {
    return null
  }

  if (payload.roomId !== expectedRoomId) return null
  if (payload.exp < Date.now()) return null
  return payload
}
