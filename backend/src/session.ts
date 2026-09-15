// Credenciales firmadas (Semana 2, ampliadas en Semana 4 para subsalas):
// HMAC-SHA256 sobre SESSION_SIGNING_SECRET, sin estado del lado del servidor
// (no hace falta una tabla `sessions`).
//
// Formato: base64url(JSON payload) + "." + base64url(firma HMAC del payload).
// Verificación con crypto.subtle.verify (tiempo constante), no comparación
// manual de strings.
//
// Hay dos tipos y cada payload lleva su `kind`, para que una credencial nunca
// se pueda usar como la otra:
//   - 'sesion' (120 s): la exige GET /ws de UNA sala antes de reenviar nada al
//     Durable Object (ver index.ts). Si la emitió POST /entrada, lleva el
//     move_id de ese movimiento.
//   - 'grupo' (12 h): la entrega /register. Con ella se piden tokens de sesión
//     para cualquier sala del grupo (la principal o una subsala abierta) sin
//     volver a registrarse, y se renueva la sesión al reconectar.

export interface SessionPayload {
  kind: 'sesion'
  roomId: string
  userId: string
  nombre: string
  moveId?: string
  exp: number // epoch ms
}

export interface GroupCredentialPayload {
  kind: 'grupo'
  groupRoomId: string
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

async function signPayload(env: { SESSION_SIGNING_SECRET: string }, payload: object): Promise<string> {
  const payloadB64 = toBase64Url(new TextEncoder().encode(JSON.stringify(payload)))
  const key = await hmacKey(env.SESSION_SIGNING_SECRET)
  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payloadB64))
  return `${payloadB64}.${toBase64Url(new Uint8Array(signature))}`
}

// Devuelve el payload solo si la firma es válida y no venció. Un token mal
// formado (base64 o JSON inválido) es simplemente inválido, nunca un 500.
async function verifyPayload(env: { SESSION_SIGNING_SECRET: string }, token: string): Promise<Record<string, unknown> | null> {
  const parts = token.split('.')
  if (parts.length !== 2) return null
  const [payloadB64, sigB64] = parts

  const key = await hmacKey(env.SESSION_SIGNING_SECRET)
  let valid = false
  try {
    valid = await crypto.subtle.verify('HMAC', key, fromBase64Url(sigB64), new TextEncoder().encode(payloadB64))
  } catch {
    return null
  }
  if (!valid) return null

  let payload: Record<string, unknown>
  try {
    payload = JSON.parse(new TextDecoder().decode(fromBase64Url(payloadB64)))
  } catch {
    return null
  }
  if (typeof payload.exp !== 'number' || payload.exp < Date.now()) return null
  return payload
}

export async function signSessionToken(
  env: { SESSION_SIGNING_SECRET: string },
  payload: Omit<SessionPayload, 'exp' | 'kind'>,
  ttlSeconds: number
): Promise<string> {
  const full: SessionPayload = { kind: 'sesion', ...payload, exp: Date.now() + ttlSeconds * 1000 }
  return signPayload(env, full)
}

export async function verifySessionToken(
  env: { SESSION_SIGNING_SECRET: string },
  token: string,
  expectedRoomId: string
): Promise<SessionPayload | null> {
  const payload = await verifyPayload(env, token)
  if (!payload || payload.kind !== 'sesion' || payload.roomId !== expectedRoomId) return null
  return payload as unknown as SessionPayload
}

export async function signGroupCredential(
  env: { SESSION_SIGNING_SECRET: string },
  payload: Omit<GroupCredentialPayload, 'exp' | 'kind'>,
  ttlSeconds: number
): Promise<string> {
  const full: GroupCredentialPayload = { kind: 'grupo', ...payload, exp: Date.now() + ttlSeconds * 1000 }
  return signPayload(env, full)
}

export async function verifyGroupCredential(
  env: { SESSION_SIGNING_SECRET: string },
  credential: string | null | undefined
): Promise<GroupCredentialPayload | null> {
  if (!credential) return null
  const payload = await verifyPayload(env, credential)
  if (!payload || payload.kind !== 'grupo') return null
  if (typeof payload.groupRoomId !== 'string' || typeof payload.userId !== 'string' || typeof payload.nombre !== 'string') {
    return null
  }
  return payload as unknown as GroupCredentialPayload
}

// Llave de host (Semana 4): secreto aleatorio que se entrega UNA sola vez, al
// crear la sala principal. En D1 queda solo su hash, así que ni quien pueda
// leer la base puede hacerse pasar por el host.
export function generateHostKey(): string {
  const bytes = new Uint8Array(32)
  crypto.getRandomValues(bytes)
  return toBase64Url(bytes)
}

export async function hashHostKey(key: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(key))
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

export async function hostKeyMatches(key: string | null | undefined, expectedHash: string | null): Promise<boolean> {
  if (!key || !expectedHash) return false
  const actual = await hashHostKey(key)
  if (actual.length !== expectedHash.length) return false
  let diff = 0
  for (let i = 0; i < actual.length; i++) diff |= actual.charCodeAt(i) ^ expectedHash.charCodeAt(i)
  return diff === 0
}
