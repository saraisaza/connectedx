export const API_BASE = (import.meta.env.VITE_API_BASE as string | undefined) ?? 'http://localhost:8787'

// Error de la API con su status HTTP, para que quien llama distinga una sala
// cerrada (410) o una credencial vencida (401) de una falla de red.
export class ApiError extends Error {
  constructor(
    message: string,
    public status: number
  ) {
    super(message)
    this.name = 'ApiError'
  }
}

async function requestJson<T>(
  path: string,
  init: { method?: string; body?: unknown; headers?: Record<string, string> } = {}
): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    method: init.method ?? (init.body === undefined ? 'GET' : 'POST'),
    headers: { ...(init.body === undefined ? {} : { 'content-type': 'application/json' }), ...init.headers },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  })
  const data = (await res.json().catch(() => ({}))) as T & { error?: string; errorDescription?: string }
  if (!res.ok) {
    throw new ApiError(data.errorDescription ?? data.error ?? `Request failed: ${path} (${res.status})`, res.status)
  }
  return data
}

export async function postJson<T>(path: string, body: unknown, method: 'POST' | 'PUT' = 'POST'): Promise<T> {
  return requestJson<T>(path, { method, body })
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
  // Semana 4: credencial de grupo (12 h). Con ella se entra a las subsalas y
  // se renueva la sesión al reconectar, sin volver a registrarse.
  credencial: string
}

export async function registerForRoom(roomId: string, params: RegisterParams): Promise<RegisterResult> {
  const data = await requestJson<Partial<RegisterResult>>(`/api/rooms/${roomId}/register`, { body: params })
  if (!data.userId || !data.token || !data.credencial) throw new Error('No se pudo registrar el usuario')
  return { roomId: data.roomId!, userId: data.userId, nombre: data.nombre!, token: data.token, credencial: data.credencial }
}

// Token de sesión para una sala concreta del grupo, con lo que hace falta
// mostrar de esa sala.
export interface RoomToken {
  roomId: string
  nombre: string
  tipo: 'principal' | 'subsala'
  token: string
}

// Parte D (reconexión) + Semana 4: token fresco con la credencial de grupo.
// Devuelve la sala donde D1 ubica a la persona, que no tiene por qué ser la de
// la URL (puede estar en una subsala). Un 410 significa que la reunión se
// cerró mientras estaba desconectada; un 401, que la credencial venció.
export async function reauthForGroup(groupRoomId: string, credencial: string): Promise<RoomToken> {
  return requestJson<RoomToken>(`/api/rooms/${groupRoomId}/reauth`, { body: { credencial } })
}

// Semana 4: pedir entrar a otra sala del grupo. El move_id lo genera quien se
// mueve y se reusa si hay que reintentar el mismo movimiento.
export async function requestEntrada(roomId: string, credencial: string, moveId: string): Promise<RoomToken> {
  return requestJson<RoomToken>(`/api/rooms/${roomId}/entrada`, { body: { credencial, moveId } })
}

export interface RoomInfo {
  id: string
  nombre: string
  estado: 'activa' | 'cerrada'
  tipo: 'principal' | 'subsala'
  parentRoomId: string | null
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

export interface GroupRoom {
  id: string
  nombre: string
  tipo: 'principal' | 'subsala'
  personas: number
}

function authHeaders(auth: { credencial?: string | null; hostKey?: string | null }): Record<string, string> {
  const headers: Record<string, string> = {}
  if (auth.credencial) headers['x-credencial'] = auth.credencial
  if (auth.hostKey) headers['x-host-key'] = auth.hostKey
  return headers
}

// Salas abiertas de la reunión (la principal primero) con cuántas personas hay
// en cada una. `host` confirma que la llave de host es válida.
export async function fetchGroupRooms(
  groupRoomId: string,
  auth: { credencial?: string | null; hostKey?: string | null }
): Promise<{ rooms: GroupRoom[]; max: number; host: boolean }> {
  return requestJson(`/api/rooms/${groupRoomId}/subsalas`, { headers: authHeaders(auth) })
}

export async function createSubsalas(groupRoomId: string, hostKey: string, cantidad: number): Promise<{ omitidas: number }> {
  return requestJson(`/api/rooms/${groupRoomId}/subsalas`, { body: { cantidad }, headers: authHeaders({ hostKey }) })
}

// Cierra una subsala (su gente vuelve a la principal) o, si es la principal,
// la reunión entera.
export async function closeRoomAsHost(roomId: string, hostKey: string): Promise<void> {
  await requestJson(`/api/rooms/${roomId}/close`, { method: 'POST', body: {}, headers: authHeaders({ hostKey }) })
}
