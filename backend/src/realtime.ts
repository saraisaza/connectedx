// Wrapper delgado sobre la API HTTPS de Cloudflare Realtime SFU
// (https://developers.cloudflare.com/realtime/sfu/, antes "Cloudflare Calls").
//
// Todo el tráfico de aquí sale del Worker/Durable Object, nunca del navegador,
// porque requiere el App Secret. El navegador solo habla con nuestro backend.
//
// Flujo confirmado contra la librería oficial `partytracks` (mantenida por
// Cloudflare) y el demo de referencia `cloudflare/meet`:
//   1. POST /apps/{appId}/sessions/new              -> crea una Session (1 RTCPeerConnection del lado SFU)
//   2. POST /apps/{appId}/sessions/{id}/tracks/new   -> publica tracks locales (con SDP offer) o
//                                                        suscribe a tracks remotos (location: 'remote')
//   3. PUT  /apps/{appId}/sessions/{id}/renegotiate  -> completa la negociación cuando el paso 2
//                                                        responde requiresImmediateRenegotiation
//   4. PUT  /apps/{appId}/sessions/{id}/tracks/close -> cierra tracks (mute duro / salida)

export interface RealtimeConfig {
  baseUrl: string // p.ej. https://rtc.live.cloudflare.com/v1
  appId: string
  appToken: string // secreto
}

export interface SessionDescription {
  type: 'offer' | 'answer'
  sdp: string
}

export interface TrackObject {
  location: 'local' | 'remote'
  trackName: string
  sessionId?: string // requerido cuando location === 'remote': de qué sesión viene el track
  mid?: string | null
}

interface ErrorResponse {
  errorCode?: string
  errorDescription?: string
}

export interface NewSessionResponse extends ErrorResponse {
  sessionId: string
  sessionDescription: SessionDescription
}

export interface TracksResponse extends ErrorResponse {
  sessionDescription: SessionDescription
  requiresImmediateRenegotiation: boolean
  tracks?: (TrackObject & ErrorResponse)[]
}

export interface RenegotiateResponse extends ErrorResponse {}

export class RealtimeApiError extends Error {
  constructor(
    message: string,
    public status: number
  ) {
    super(message)
    this.name = 'RealtimeApiError'
  }
}

async function callsFetch<T>(
  config: RealtimeConfig,
  path: string,
  init: { method: string; body?: unknown }
): Promise<T> {
  const res = await fetch(`${config.baseUrl}/apps/${config.appId}${path}`, {
    method: init.method,
    headers: {
      Authorization: `Bearer ${config.appToken}`,
      'Content-Type': 'application/json',
    },
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
  })

  const json = (await res.json().catch(() => ({}))) as T & ErrorResponse
  if (!res.ok || json.errorCode) {
    throw new RealtimeApiError(
      json.errorDescription ?? `Realtime SFU request failed: ${path} (${res.status})`,
      res.status
    )
  }
  return json
}

// Crea una nueva Session del lado del SFU. No se le pasa SDP: el offer real
// se negocia en el primer tracks/new (publicar) que use esta sessionId.
// No mandamos body: la API de Realtime SFU valida sessionDescription apenas
// detecta un body JSON (incluso "{}"), así que la única forma de crear una
// sesión sin SDP todavía (el offer real llega en el primer tracks/new) es no
// mandar body en absoluto.
export function createSession(config: RealtimeConfig): Promise<NewSessionResponse> {
  return callsFetch<NewSessionResponse>(config, '/sessions/new', {
    method: 'POST',
  })
}

// Publica track(s) locales: el cliente ya añadió transceivers sendonly y
// generó un offer: se lo mandamos al SFU y devolvemos su answer.
export function publishTracks(
  config: RealtimeConfig,
  sessionId: string,
  offer: SessionDescription,
  tracks: { mid: string; trackName: string }[]
): Promise<TracksResponse> {
  return callsFetch<TracksResponse>(config, `/sessions/${sessionId}/tracks/new`, {
    method: 'POST',
    body: {
      sessionDescription: offer,
      tracks: tracks.map((t) => ({ location: 'local', mid: t.mid, trackName: t.trackName })),
    },
  })
}

// Suscribe la sesión `sessionId` a uno o más tracks remotos publicados por
// otras sesiones. Es la función "explícita y parametrizable" que pide la
// Semana 1: hoy la llamamos con la lista completa de tracks del room, pero
// en Semana 3 el llamador puede pasar como máximo 10 (modelo Meet) sin tocar
// esta función.
//
// `preferredRid` (Parte C, solo aplica a tracks de VIDEO): qué capa de
// simulcast pedir de entrada -- 'q' (baja, ~180p) para un cuadrito chico del
// grid, 'f' (alta, ~720p) para quien está destacado/hablando. Confirmado
// contra el schema OpenAPI de Cloudflare: es un objeto `simulcast` por track
// dentro del mismo body de tracks/new, no un endpoint aparte.
export function subscribeToTracks(
  config: RealtimeConfig,
  subscriberSessionId: string,
  remoteTracks: { sessionId: string; trackName: string; preferredRid?: 'q' | 'f' }[]
): Promise<TracksResponse> {
  return callsFetch<TracksResponse>(config, `/sessions/${subscriberSessionId}/tracks/new`, {
    method: 'POST',
    body: {
      tracks: remoteTracks.map((t) => ({
        location: 'remote',
        sessionId: t.sessionId,
        trackName: t.trackName,
        ...(t.preferredRid ? { simulcast: { preferredRid: t.preferredRid } } : {}),
      })),
    },
  })
}

// Cambia la capa de simulcast de un track YA suscrito, sin recortar el video
// ni renegociar toda la sesión (Parte C). Confirmado contra el schema:
// PUT tracks/update con solo {mid, simulcast:{preferredRid}} responde
// requiresImmediateRenegotiation:false y SIN sessionDescription -- no hay SDP
// nueva que aplicar del lado del cliente. La propia doc de Cloudflare
// documenta que el SFU pide un keyframe completo (Full Intraframe Request)
// automáticamente al cambiar de capa, así el video no queda con artefactos.
export interface UpdateTrackLayerResponse extends ErrorResponse {
  requiresImmediateRenegotiation: boolean
  sessionDescription?: SessionDescription
}

export function updateTrackLayer(
  config: RealtimeConfig,
  sessionId: string,
  tracks: { mid: string; preferredRid: 'q' | 'f' }[]
): Promise<UpdateTrackLayerResponse> {
  return callsFetch<UpdateTrackLayerResponse>(config, `/sessions/${sessionId}/tracks/update`, {
    method: 'PUT',
    body: {
      tracks: tracks.map((t) => ({ mid: t.mid, simulcast: { preferredRid: t.preferredRid } })),
    },
  })
}

// Completa la negociación cuando publishTracks/subscribeToTracks devuelven
// requiresImmediateRenegotiation: true (típico al suscribirse a tracks remotos,
// donde el SFU manda un offer nuevo y el cliente debe contestar con un answer).
export function renegotiate(
  config: RealtimeConfig,
  sessionId: string,
  answer: SessionDescription
): Promise<RenegotiateResponse> {
  return callsFetch<RenegotiateResponse>(config, `/sessions/${sessionId}/renegotiate`, {
    method: 'PUT',
    body: { sessionDescription: answer },
  })
}

// Cierra tracks. Con force:true, el SFU corta el flujo de datos sin pedir
// renegociación SDP (confirmado contra la API real: PUT tracks/close con
// {force:true} y sin sessionDescription devuelve 200,
// requiresImmediateRenegotiation:false) -- es lo que usa
// unsubscribeFromTracks, porque no queremos tocar el PeerConnection del
// cliente solo para dejar de ver a alguien. Sin force (u offer provisto), se
// manda sessionDescription para una renegociación real -- no lo usa nadie
// esta semana, se deja disponible para un "salir prolijo" futuro.
export function closeTracks(
  config: RealtimeConfig,
  sessionId: string,
  mids: string[],
  opts: { force: boolean; offer?: SessionDescription }
): Promise<TracksResponse> {
  return callsFetch<TracksResponse>(config, `/sessions/${sessionId}/tracks/close`, {
    method: 'PUT',
    body: {
      tracks: mids.map((mid) => ({ mid })),
      force: opts.force,
      ...(opts.offer ? { sessionDescription: opts.offer } : {}),
    },
  })
}

// Credenciales ICE. Si hay credenciales TURN separadas configuradas, las usa;
// si no, cae a STUN público de Cloudflare (suficiente para la prueba local
// de dos navegadores en la misma red de esta semana).
export async function getIceServers(env: {
  CALLS_API_BASE_URL: string
  TURN_TOKEN_ID?: string
  TURN_TOKEN_SECRET?: string
}): Promise<RTCIceServerLike[]> {
  if (!env.TURN_TOKEN_ID || !env.TURN_TOKEN_SECRET) {
    return [{ urls: ['stun:stun.cloudflare.com:3478', 'stun:stun.cloudflare.com:53'] }]
  }

  const res = await fetch(
    `${env.CALLS_API_BASE_URL}/turn/keys/${env.TURN_TOKEN_ID}/credentials/generate-ice-servers`,
    {
      method: 'POST',
      body: JSON.stringify({ ttl: 86400 }),
      headers: { Authorization: `Bearer ${env.TURN_TOKEN_SECRET}` },
    }
  )
  if (!res.ok) {
    throw new RealtimeApiError('No se pudieron generar credenciales TURN', res.status)
  }
  const { iceServers } = (await res.json()) as { iceServers: RTCIceServerLike[] }
  return iceServers
}

interface RTCIceServerLike {
  urls: string | string[]
  username?: string
  credential?: string
}
