export const API_BASE = (import.meta.env.VITE_API_BASE as string | undefined) ?? 'http://localhost:8787'

export async function postJson<T>(path: string, body: unknown, method: 'POST' | 'PUT' = 'POST'): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  const data = (await res.json().catch(() => ({}))) as T & { error?: string; errorDescription?: string }
  if (!res.ok) {
    throw new Error(data.errorDescription ?? data.error ?? `Request failed: ${path} (${res.status})`)
  }
  return data
}

export interface IceServer {
  urls: string | string[]
  username?: string
  credential?: string
}

export async function fetchIceServers(roomId: string): Promise<IceServer[]> {
  const res = await fetch(`${API_BASE}/api/rooms/${roomId}/sfu/ice-servers`)
  const data = (await res.json()) as { iceServers: IceServer[] }
  return data.iceServers
}

export interface RegisterParams {
  nombre: string
  correo: string
  rol: 'participante' | 'admin'
}

export interface RegisterResult {
  roomId: string
  userId: string
  nombre: string
  token: string
}

export async function registerForRoom(roomId: string, params: RegisterParams): Promise<RegisterResult> {
  const res = await fetch(`${API_BASE}/api/rooms/${roomId}/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(params),
  })
  const data = (await res.json().catch(() => ({}))) as Partial<RegisterResult> & { error?: string }
  if (!res.ok || !data.userId || !data.token) throw new Error(data.error ?? 'No se pudo registrar el usuario')
  return { roomId: data.roomId!, userId: data.userId, nombre: data.nombre!, token: data.token }
}

// Parte D (reconexión): token fresco de 120s para un userId ya registrado,
// sin pasar por el formulario de nuevo -- ver roomSession.ts POST /reauth.
// Mismo shape de respuesta/errores que registerForRoom, así el llamador
// puede tratar un 410 (sala cerrada mientras estaba desconectado) igual que
// ya trata ese caso en el flujo normal de pre-chequeo.
export async function reauthForRoom(roomId: string, userId: string): Promise<RegisterResult> {
  const res = await fetch(`${API_BASE}/api/rooms/${roomId}/reauth`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ userId }),
  })
  const data = (await res.json().catch(() => ({}))) as Partial<RegisterResult> & { error?: string }
  if (!res.ok || !data.userId || !data.token) {
    const err = new Error(data.error ?? 'No se pudo renovar la sesión') as Error & { status?: number }
    err.status = res.status
    throw err
  }
  return { roomId: data.roomId!, userId: data.userId, nombre: data.nombre!, token: data.token }
}

export interface RoomInfo {
  id: string
  nombre: string
  estado: 'activa' | 'cerrada'
}

// null significa "no existe" (404) — lo distinguimos de "cerrada" (existe,
// devuelve 200 con estado 'cerrada') para poder mostrar mensajes distintos
// en la pantalla de pre-chequeo.
export async function fetchRoom(roomId: string): Promise<RoomInfo | null> {
  const res = await fetch(`${API_BASE}/api/rooms/${roomId}`)
  if (res.status === 404) return null
  if (!res.ok) throw new Error('No se pudo consultar la sala')
  return (await res.json()) as RoomInfo
}
