import type { Env } from './types'
import * as db from './db'
import * as realtime from './realtime'

// ---------------------------------------------------------------------------
// RoomSession: un Durable Object por sala ACTIVA (id de sala === id del DO,
// vía idFromName(roomId)). Es la fuente de verdad de:
//   - qué participantes están conectados ahora mismo
//   - qué tracks tiene publicados cada uno en el SFU
//   - la coordinación de señalización (quién debe suscribirse a qué)
//
// Transporte: los clientes abren UN WebSocket al DO puramente para recibir
// notificaciones push (alguien entró / salió / publicó un track). Las
// operaciones que sí cambian estado (crear sesión SFU, publicar, suscribir,
// renegociar) viajan como fetch() normales al DO, no por el WebSocket — así
// evitamos inventar un protocolo de request/response sobre WS.
//
// Escala: usamos la Hibernatable WebSocket API (ctx.acceptWebSocket) en vez
// de addEventListener('message', ...). Con eso, el runtime puede descargar
// el DO de memoria entre eventos sin cerrar los WebSockets — importante para
// el escenario de 300 personas con cámara en un webinar, donde la mayoría
// del tiempo cada conexión está inactiva. Ver notas de escala más abajo.
// ---------------------------------------------------------------------------

interface ParticipantRecord {
  connectionId: string
  userId: string
  nombre: string
  attendanceId: string
  sfuSessionId: string | null
  tracks: {
    audio?: string // trackName publicado en el SFU
    video?: string
    screen?: string // Parte D: pantalla compartida, track adicional (no reemplaza video)
  }
  // Tracks de VIDEO que ESTE participante (como espectador) tiene suscritos
  // ahora mismo -- separado de `tracks` de arriba, que es lo que él publica.
  // Es contra esto que se valida MAX_VISIBLE_TILES (ver handleSubscribe).
  // El audio nunca se guarda acá: no tiene límite (screen tampoco, Parte D).
  subscribedVideoTrackNames: string[]
  // Parte D: si la cámara está apagada (modo solo audio), el track de video
  // sigue "publicado" (mismo trackName, ver sfu.ts setCameraEnabled) pero sin
  // datos fluyendo -- otros participantes necesitan esta señal EXPLÍCITA para
  // mostrar avatar en vez de un frame congelado, `hasLiveVideo` del lado
  // cliente no alcanza (ver comentario en CallScreen.tsx).
  camOn: boolean
}

interface SimulcastConfig {
  lowHeight: number
  lowMaxBitrateBps: number
  highHeight: number
  highMaxBitrateBps: number
}

type ServerMessage =
  | {
      type: 'hello'
      connectionId: string
      participants: PublicParticipant[]
      maxVisibleTiles: number
      simulcast: SimulcastConfig
      screenShareMaxBitrateBps: number
    }
  | { type: 'participant-joined'; participant: PublicParticipant }
  | { type: 'participant-left'; connectionId: string }
  | {
      type: 'track-published'
      connectionId: string
      kind: 'audio' | 'video' | 'screen'
      sessionId: string
      trackName: string
    }
  | { type: 'screen-share-stopped'; connectionId: string }
  | { type: 'media-state'; connectionId: string; camOn: boolean; micOn: boolean }
  | { type: 'room-closed' }

interface PublicParticipant {
  connectionId: string
  nombre: string
  sfuSessionId: string | null
  tracks: { audio?: string; video?: string; screen?: string }
  camOn: boolean
}

const PARTICIPANT_PREFIX = 'participant:'

// Función explícita y parametrizable de selección de PARTICIPANTES (no de
// tracks): decide a quiénes se les manda info en `hello`/reordenamiento
// futuro. A propósito NO es el lugar donde se aplica MAX_VISIBLE_TILES: cada
// PublicParticipant trae audio+video juntos, así que cortar esta lista
// cortaría también el audio de los participantes de más — y el audio nunca
// se capa (ver handleSubscribe, que es donde vive el cap real, solo sobre
// video). Esta función queda para cuando el active speaker (Parte B) necesite
// reordenar `available` antes de mandarlo.
function selectTracksToSubscribe(
  available: PublicParticipant[],
  opts: { excludeConnectionId?: string; maxTracks?: number } = {}
): PublicParticipant[] {
  const { excludeConnectionId, maxTracks = Infinity } = opts
  return available.filter((p) => p.connectionId !== excludeConnectionId).slice(0, maxTracks)
}

function toPublic(p: ParticipantRecord): PublicParticipant {
  return { connectionId: p.connectionId, nombre: p.nombre, sfuSessionId: p.sfuSessionId, tracks: p.tracks, camOn: p.camOn }
}

// Verdad del lado del servidor sobre qué kind es un trackName: NUNCA se
// confía en el `kind` que manda el cliente en /sfu/subscribe para decidir
// qué cuenta contra MAX_VISIBLE_TILES -- un cliente podría pedir un track de
// video etiquetándolo "audio" para saltarse el cap (Cloudflare identifica
// tracks por sessionId+trackName, nunca por kind, así que igual se lo
// entregaría). Se resuelve contra lo que cada participante publicó de
// verdad. 'screen' entra en el mismo balde que 'audio' en handleSubscribe
// (nunca cappeado) -- ver Parte D.
function resolveKind(all: ParticipantRecord[], trackName: string): 'audio' | 'video' | 'screen' | 'unknown' {
  for (const p of all) {
    if (p.tracks.audio === trackName) return 'audio'
    if (p.tracks.video === trackName) return 'video'
    if (p.tracks.screen === trackName) return 'screen'
  }
  return 'unknown'
}

// Number(env var) desnudo es peligroso acá: si MAX_VISIBLE_TILES viniera
// mal seteada (vacía, no numérica), Number(...) da NaN, y CUALQUIER
// comparación "count > NaN" es false -- el cap quedaría deshabilitado en
// silencio (fail-open) en vez de fail-closed. Mejor un fallback explícito.
function maxVisibleTilesFrom(env: { MAX_VISIBLE_TILES: string }): number {
  const n = Number(env.MAX_VISIBLE_TILES)
  return Number.isFinite(n) && n > 0 ? n : 10
}

// Mismo cuidado que maxVisibleTilesFrom: una var mal seteada no puede tirar
// el `hello` completo ni degradar en silencio a NaN/Infinity -- cae a un
// fallback numérico seguro por campo.
function simulcastConfigFrom(env: {
  SIMULCAST_LOW_HEIGHT: string
  SIMULCAST_LOW_MAX_BITRATE_BPS: string
  SIMULCAST_HIGH_HEIGHT: string
  SIMULCAST_HIGH_MAX_BITRATE_BPS: string
}): SimulcastConfig {
  const num = (value: string, fallback: number) => {
    const n = Number(value)
    return Number.isFinite(n) && n > 0 ? n : fallback
  }
  return {
    lowHeight: num(env.SIMULCAST_LOW_HEIGHT, 180),
    lowMaxBitrateBps: num(env.SIMULCAST_LOW_MAX_BITRATE_BPS, 150_000),
    highHeight: num(env.SIMULCAST_HIGH_HEIGHT, 720),
    highMaxBitrateBps: num(env.SIMULCAST_HIGH_MAX_BITRATE_BPS, 1_500_000),
  }
}

function screenShareMaxBitrateBpsFrom(env: { SCREEN_SHARE_MAX_BITRATE_BPS: string }): number {
  const n = Number(env.SCREEN_SHARE_MAX_BITRATE_BPS)
  return Number.isFinite(n) && n > 0 ? n : 2_500_000
}

function attendanceGraceWindowMsFrom(env: { ATTENDANCE_GRACE_WINDOW_MS: string }): number {
  const n = Number(env.ATTENDANCE_GRACE_WINDOW_MS)
  return Number.isFinite(n) && n > 0 ? n : 90_000
}

function jsonResponse(body: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: { 'content-type': 'application/json', ...init?.headers },
  })
}

export class RoomSession {
  private ctx: DurableObjectState
  private env: Env

  constructor(ctx: DurableObjectState, env: Env) {
    this.ctx = ctx
    this.env = env
  }

  private realtimeConfig(): realtime.RealtimeConfig {
    return {
      baseUrl: this.env.CALLS_API_BASE_URL,
      appId: this.env.CALLS_APP_ID,
      appToken: this.env.CALLS_APP_SECRET,
    }
  }

  private async getParticipant(connectionId: string): Promise<ParticipantRecord | undefined> {
    return this.ctx.storage.get<ParticipantRecord>(PARTICIPANT_PREFIX + connectionId)
  }

  private async putParticipant(p: ParticipantRecord): Promise<void> {
    await this.ctx.storage.put(PARTICIPANT_PREFIX + p.connectionId, p)
  }

  private async listParticipants(): Promise<ParticipantRecord[]> {
    const map = await this.ctx.storage.list<ParticipantRecord>({ prefix: PARTICIPANT_PREFIX })
    return [...map.values()]
  }

  // Manda `message` a todos los WebSockets aceptados salvo el excluido.
  // ctx.getWebSockets() también devuelve los que están hibernados: el
  // runtime los despierta solos al llamarles .send().
  private broadcast(message: ServerMessage, excludeConnectionId?: string) {
    const payload = JSON.stringify(message)
    for (const ws of this.ctx.getWebSockets()) {
      const [connectionId] = this.ctx.getTags(ws)
      if (excludeConnectionId && connectionId === excludeConnectionId) continue
      try {
        ws.send(payload)
      } catch {
        // socket muerto; webSocketClose/Error lo van a limpiar por su cuenta.
      }
    }
  }

  // Semana 4 (prueba con 16 participantes): renegotiate, unsubscribe,
  // track-quality, crear sesión y detener pantalla no atrapaban las fallas de
  // Cloudflare Realtime. Una excepción sin manejar se convierte en un 500 de
  // texto plano sin headers CORS, y el navegador lo reporta como "bloqueado
  // por CORS" en vez del error real (se vio: "Session appears to be
  // disconnected" en un renegotiate bajo carga). Este borde atrapa todo lo
  // que los handlers no atrapan y devuelve JSON estructurado; subscribe y
  // publish mantienen su propio try/catch porque además revierten reservas.
  async fetch(request: Request): Promise<Response> {
    try {
      return await this.route(request)
    } catch (err) {
      console.error('RoomSession', new URL(request.url).pathname, err)
      const message = err instanceof realtime.RealtimeApiError ? err.message : 'unexpected_error'
      return jsonResponse({ error: 'sfu_request_failed', message }, { status: 502 })
    }
  }

  private async route(request: Request): Promise<Response> {
    const url = new URL(request.url)

    if (url.pathname === '/ws') return this.handleWebSocketUpgrade(request, url)
    if (url.pathname === '/sfu/session' && request.method === 'POST') return this.handleCreateSfuSession(request)
    if (url.pathname === '/sfu/publish' && request.method === 'POST') return this.handlePublish(request)
    if (url.pathname === '/sfu/subscribe' && request.method === 'POST') return this.handleSubscribe(request)
    if (url.pathname === '/sfu/unsubscribe' && request.method === 'PUT') return this.handleUnsubscribe(request)
    if (url.pathname === '/sfu/renegotiate' && request.method === 'PUT') return this.handleRenegotiate(request)
    if (url.pathname === '/sfu/track-quality' && request.method === 'PUT') return this.handleTrackQuality(request)
    if (url.pathname === '/sfu/screen-share/stop' && request.method === 'PUT') return this.handleScreenShareStop(request)
    if (url.pathname === '/sfu/media-state' && request.method === 'PUT') return this.handleMediaState(request)
    if (url.pathname === '/participants' && request.method === 'GET') {
      const participants = (await this.listParticipants()).map(toPublic)
      return jsonResponse({ participants })
    }
    if (url.pathname === '/force-close' && request.method === 'POST') return this.handleForceClose()

    return jsonResponse({ error: 'not_found' }, { status: 404 })
  }

  // --- "Unirse": el upgrade a WebSocket ES el evento de entrada a la sala. ---
  private async handleWebSocketUpgrade(request: Request, url: URL): Promise<Response> {
    if (request.headers.get('Upgrade') !== 'websocket') {
      return jsonResponse({ error: 'expected_websocket' }, { status: 426 })
    }
    if (await this.ctx.storage.get('closed')) {
      return jsonResponse({ error: 'room_closed' }, { status: 410 })
    }

    const userId = url.searchParams.get('userId')
    const nombre = url.searchParams.get('nombre')
    const roomId = url.searchParams.get('roomId')
    if (!userId || !nombre || !roomId) {
      return jsonResponse({ error: 'missing_userId_nombre_roomId' }, { status: 400 })
    }

    const connectionId = crypto.randomUUID()

    // Parte D (reconexión básica): si este mismo userId+sala tiene una fila
    // de attendance que se cerró hace poco (dentro de la ventana de gracia),
    // la reusamos (le borramos left_at) en vez de insertar una nueva -- así
    // una reconexión rápida (corte de wifi de unos segundos, con el
    // connectionId SIEMPRE nuevo por diseño, ver más abajo) no aparece como
    // dos asistencias separadas en el reporte de Semana 6. Una desconexión
    // más larga que la ventana de gracia SÍ genera una fila nueva a
    // propósito -- la persona realmente no estuvo presente durante ese hueco.
    const graceWindowMs = attendanceGraceWindowMsFrom(this.env)
    const sinceIso = new Date(Date.now() - graceWindowMs).toISOString()
    const recent = await db.findRecentAttendance(this.env.DB, { roomId, userId, sinceIso })

    let attendanceId: string
    if (recent) {
      await db.resumeAttendance(this.env.DB, recent.id)
      attendanceId = recent.id
    } else {
      attendanceId = crypto.randomUUID()
      // userId tiene que venir de un registro previo real (POST /register),
      // que es lo que crea la fila en `users` que `attendance.user_id`
      // referencia. Si no existe (cliente viejo, id inventado, etc.), el
      // INSERT de abajo viola la FOREIGN KEY: lo atajamos acá para devolver
      // un 400 prolijo en vez de un 500 con un error crudo de D1.
      //
      // Escala: este await bloquea el upgrade hasta que D1 confirme el
      // INSERT. Con pocos participantes (esta semana) es imperceptible y
      // garantiza que el registro de asistencia exista apenas alguien entra.
      // A 300 joins simultáneos (arranque de un webinar) esto serializa
      // escrituras contra D1 y se vuelve el cuello de botella del join. La
      // salida a esa escala: aceptar el WebSocket primero y mover este
      // INSERT a ctx.waitUntil(...) (fire-and-forget), aceptando que un
      // crash justo en ese instante podría perder un registro de asistencia
      // aislado.
      try {
        await db.recordJoin(this.env.DB, { id: attendanceId, roomId, userId })
      } catch {
        return jsonResponse({ error: 'invalid_user_or_room' }, { status: 400 })
      }
    }

    const pair = new WebSocketPair()
    const [client, server] = Object.values(pair)

    const record: ParticipantRecord = {
      connectionId,
      userId,
      nombre,
      attendanceId,
      sfuSessionId: null,
      tracks: {},
      subscribedVideoTrackNames: [],
      camOn: true,
    }
    await this.putParticipant(record)

    this.ctx.acceptWebSocket(server, [connectionId])

    const existing = (await this.listParticipants())
      .filter((p) => p.connectionId !== connectionId)
      .map(toPublic)

    server.send(
      JSON.stringify({
        type: 'hello',
        connectionId,
        participants: selectTracksToSubscribe(existing),
        maxVisibleTiles: maxVisibleTilesFrom(this.env),
        simulcast: simulcastConfigFrom(this.env),
        screenShareMaxBitrateBps: screenShareMaxBitrateBpsFrom(this.env),
      } satisfies ServerMessage)
    )

    this.broadcast({ type: 'participant-joined', participant: toPublic(record) }, connectionId)

    return new Response(null, { status: 101, webSocket: client })
  }

  // El cliente no manda mensajes de control por WS esta semana (ver comentario
  // arriba); si llega algo, no rompemos la conexión.
  webSocketMessage(_ws: WebSocket, _message: string | ArrayBuffer) {
    // reservado para heartbeats/futuros mensajes de cliente.
  }

  async webSocketClose(ws: WebSocket, _code: number, _reason: string, _wasClean: boolean) {
    await this.handleDisconnect(ws)
  }

  async webSocketError(ws: WebSocket, _error: unknown) {
    await this.handleDisconnect(ws)
  }

  private async handleDisconnect(ws: WebSocket) {
    const [connectionId] = this.ctx.getTags(ws)
    if (!connectionId) return
    const participant = await this.getParticipant(connectionId)
    if (!participant) return

    await this.ctx.storage.delete(PARTICIPANT_PREFIX + connectionId)
    await db.recordLeave(this.env.DB, participant.attendanceId)

    // Reconciliación de cupo: si quien se fue publicaba video, cualquier
    // otro participante que lo tuviera suscrito queda con un cupo "pegado"
    // para siempre si no llega a desuscribirse a mano (desconexión abrupta,
    // pestaña cerrada, etc.) -- a 300 participantes con alta rotación esto
    // se nota. No hace falta avisarle nada a Cloudflare acá: el track del
    // publicador ya se garbage-collecta solo a los 30s de inactividad
    // (documentado en el README), esto es solo para que el contador de cada
    // suscriptor no mienta.
    const leavingVideoTrack = participant.tracks.video
    if (leavingVideoTrack) {
      const others = await this.listParticipants()
      for (const other of others) {
        if (!other.subscribedVideoTrackNames.includes(leavingVideoTrack)) continue
        other.subscribedVideoTrackNames = other.subscribedVideoTrackNames.filter((t) => t !== leavingVideoTrack)
        await this.putParticipant(other)
      }
    }

    // Parte D: si quien se fue estaba compartiendo pantalla y se desconectó
    // sin avisar (cerró la pestaña, perdió la red) en vez de detenerla a
    // mano vía /sfu/screen-share/stop, ese PUT nunca llega -- sin esto la
    // sala queda bloqueada para compartir pantalla para siempre.
    if ((await this.ctx.storage.get('activeScreenShare')) === connectionId) {
      await this.ctx.storage.delete('activeScreenShare')
      this.broadcast({ type: 'screen-share-stopped', connectionId })
    }

    this.broadcast({ type: 'participant-left', connectionId })
  }

  // --- SFU: crear sesión ---
  private async handleCreateSfuSession(request: Request): Promise<Response> {
    const { connectionId } = (await request.json()) as { connectionId: string }
    const participant = await this.getParticipant(connectionId)
    if (!participant) return jsonResponse({ error: 'unknown_connection' }, { status: 404 })

    const session = await realtime.createSession(this.realtimeConfig())
    participant.sfuSessionId = session.sessionId
    await this.putParticipant(participant)

    return jsonResponse({ sessionId: session.sessionId })
  }

  // --- SFU: publicar tracks locales (mic/cámara, y Parte D: pantalla) ---
  // Screen share es exclusivo por sala (un lock en ctx.storage, no por
  // participante) con la MISMA disciplina de "reservar antes del fetch de
  // red" que ya usa handleSubscribe para el cap de video -- entre el
  // chequeo y la reserva no hay ningún await de red de por medio (solo
  // operaciones de ctx.storage), así que los input gates de Durable Objects
  // sí protegen esta sección contra dos publish de screen concurrentes.
  private async handlePublish(request: Request): Promise<Response> {
    const body = (await request.json()) as {
      connectionId: string
      offer: realtime.SessionDescription
      tracks: { mid: string; trackName: string; kind: 'audio' | 'video' | 'screen' }[]
    }
    const participant = await this.getParticipant(body.connectionId)
    if (!participant || !participant.sfuSessionId) {
      return jsonResponse({ error: 'no_sfu_session' }, { status: 409 })
    }

    const wantsScreen = body.tracks.some((t) => t.kind === 'screen')
    let reservedScreenLock = false
    if (wantsScreen) {
      const currentHolder = await this.ctx.storage.get<string>('activeScreenShare')
      if (currentHolder && currentHolder !== body.connectionId) {
        // Auto-sanación: si el dueño registrado ya no tiene ParticipantRecord
        // (se desconectó y por algún motivo handleDisconnect no llegó a
        // liberar el lock), lo tratamos como libre en vez de bloquear la sala
        // para siempre por un estado inconsistente.
        const holderStillHere = await this.getParticipant(currentHolder)
        if (holderStillHere) {
          return jsonResponse({ error: `${holderStillHere.nombre} ya está compartiendo pantalla` }, { status: 409 })
        }
      }
      if (currentHolder !== body.connectionId) {
        await this.ctx.storage.put('activeScreenShare', body.connectionId)
        reservedScreenLock = true
      }
    }

    try {
      const response = await realtime.publishTracks(
        this.realtimeConfig(),
        participant.sfuSessionId,
        body.offer,
        body.tracks.map((t) => ({ mid: t.mid, trackName: t.trackName }))
      )

      for (const t of body.tracks) {
        participant.tracks[t.kind] = t.trackName
      }
      await this.putParticipant(participant)

      for (const t of body.tracks) {
        this.broadcast(
          {
            type: 'track-published',
            connectionId: participant.connectionId,
            kind: t.kind,
            sessionId: participant.sfuSessionId,
            trackName: t.trackName,
          },
          participant.connectionId
        )
      }

      return jsonResponse(response)
    } catch (err) {
      if (reservedScreenLock) await this.ctx.storage.delete('activeScreenShare')
      const message = err instanceof realtime.RealtimeApiError ? err.message : 'unexpected_error'
      return jsonResponse({ error: 'sfu_publish_failed', message }, { status: 502 })
    }
  }

  // --- SFU: suscribirse a tracks remotos ---
  // Recibe la lista de tracks a pedir ya decidida por el llamador (frontend),
  // que a su vez la arma con los datos que el DO le mandó en `hello` o en
  // `track-published`. El propio DO también podría decidir la lista acá
  // usando selectTracksToSubscribe(...) si en el futuro se quiere centralizar
  // esa decisión del lado servidor en vez de confiar en el cliente.
  //
  // MAX_VISIBLE_TILES se valida ACÁ, no solo en el frontend -- un cliente que
  // se salte el frontend y pida 11+ videos de un saque tiene que rechazarse
  // igual. Dos cuidados no obvios:
  //   1. El `kind` de cada track NUNCA se toma del body: se resuelve contra
  //      lo que cada participante publicó de verdad (resolveKind). Si no,
  //      alcanza con mandar kind:"audio" en un track que en realidad es
  //      video para saltarse el cap -- Cloudflare identifica tracks por
  //      sessionId+trackName, nunca por kind, así que igual entregaría el
  //      video.
  //   2. La reserva de cupo (mutar subscribedVideoTrackNames + persistir) se
  //      hace ANTES de llamar a realtime.subscribeToTracks, no después. Los
  //      "input gates" de Durable Objects protegen operaciones de
  //      ctx.storage, pero NO llamadas fetch() salientes -- mientras esta
  //      función espera la respuesta HTTP de Cloudflare, el runtime puede
  //      procesar otra request concurrente al mismo DO. Si reservara
  //      después del fetch, dos subscribe concurrentes del mismo cliente
  //      podrían leer el mismo contador viejo y las dos pasar el chequeo,
  //      superando el cap entre las dos. Reservando antes, la segunda
  //      request ve la reserva de la primera.
  private async handleSubscribe(request: Request): Promise<Response> {
    const body = (await request.json()) as {
      connectionId: string
      tracks: { sessionId: string; trackName: string; kind?: 'audio' | 'video'; preferredRid?: 'q' | 'f' }[]
    }
    const participant = await this.getParticipant(body.connectionId)
    if (!participant || !participant.sfuSessionId) {
      return jsonResponse({ error: 'no_sfu_session' }, { status: 409 })
    }

    const allParticipants = await this.listParticipants()
    const maxVisibleTiles = maxVisibleTilesFrom(this.env)

    const audioTracks = body.tracks.filter((t) => resolveKind(allParticipants, t.trackName) === 'audio')
    const videoTracks = body.tracks.filter((t) => resolveKind(allParticipants, t.trackName) === 'video')
    // Screen share (Parte D) nunca cappea, mismo trato que audio -- a 300
    // participantes es el mismo patrón de fan-out sin cap que ya escala para
    // audio, no un mecanismo nuevo.
    const screenTracks = body.tracks.filter((t) => resolveKind(allParticipants, t.trackName) === 'screen')

    const alreadySubscribed = new Set(participant.subscribedVideoTrackNames)
    const newVideoNames = [...new Set(videoTracks.map((t) => t.trackName))].filter(
      (name) => !alreadySubscribed.has(name)
    )
    const wouldExceedCap = alreadySubscribed.size + newVideoNames.length > maxVisibleTiles

    if (wouldExceedCap && audioTracks.length === 0 && screenTracks.length === 0) {
      // Todo lo pedido era video y no entra: no hay nada que reenviar.
      return jsonResponse(
        { error: 'video_tile_limit', max: maxVisibleTiles, current: alreadySubscribed.size },
        { status: 409 }
      )
    }

    // Video solo se pide si entra completo (all-or-nothing sobre la porción
    // de video); audio y screen de la misma request se mandan igual aunque
    // el video se rechace -- ninguno de los dos se capa, ni siquiera por una
    // request mixta mal armada.
    const videoToRequest = wouldExceedCap ? [] : videoTracks
    const tracksToRequest = [...audioTracks, ...screenTracks, ...videoToRequest]

    if (tracksToRequest.length === 0) {
      return jsonResponse({ error: 'no_valid_tracks' }, { status: 400 })
    }

    if (videoToRequest.length > 0) {
      // Reserva síncrona (sin await de por medio) antes de tocar Cloudflare.
      participant.subscribedVideoTrackNames = [...alreadySubscribed, ...newVideoNames]
      await this.putParticipant(participant)
    }

    const videoToRequestNames = new Set(videoToRequest.map((t) => t.trackName))

    try {
      const response = await realtime.subscribeToTracks(
        this.realtimeConfig(),
        participant.sfuSessionId,
        tracksToRequest.map((t) => ({
          sessionId: t.sessionId,
          trackName: t.trackName,
          // El simulcast (preferredRid) solo tiene sentido en video -- audio
          // nunca publica dos capas (ver sfu.ts publishLocalTracks). Default
          // 'q' (baja) si el cliente no mandó preferencia: la opción más
          // barata gana cuando no hay señal explícita de que ese cuadrito
          // está destacado.
          preferredRid: videoToRequestNames.has(t.trackName) ? (t.preferredRid === 'f' ? 'f' : 'q') : undefined,
        }))
      )

      // Cloudflare puede devolver 200 general con errores POR TRACK dentro
      // de tracks[] (visto en la práctica: "not_found_track_error" cuando
      // el publicador todavía no terminó de estabilizar ese track en el
      // instante exacto de un subscribe masivo -- no es un bug nuestro, es
      // una condición de carrera real del lado de Cloudflare al suscribir
      // muchos tracks de una vez). Eso no tira excepción, así que la
      // reserva optimista de arriba puede quedar "pegada" contando un video
      // que en realidad nunca llegó a fluir. Se corrige acá contra el
      // resultado real, track por track -- sin esto, un cliente puede
      // quedar con un cupo fantasma ocupado para siempre en esa sesión.
      if (videoToRequest.length > 0) {
        const requestedVideoNames = new Set(videoToRequest.map((t) => t.trackName))
        const failedVideoNames = (response.tracks ?? [])
          .filter((t) => requestedVideoNames.has(t.trackName) && (t.errorCode || !t.mid))
          .map((t) => t.trackName)
        if (failedVideoNames.length > 0) {
          const current = await this.getParticipant(participant.connectionId)
          if (current) {
            current.subscribedVideoTrackNames = current.subscribedVideoTrackNames.filter(
              (name) => !failedVideoNames.includes(name)
            )
            await this.putParticipant(current)
          }
        }
      }

      const body2 = wouldExceedCap ? { ...response, videoRejected: true, max: maxVisibleTiles } : response
      return jsonResponse(body2)
    } catch (err) {
      if (videoToRequest.length > 0) {
        // Revertir la reserva: la llamada real falló, esos cupos no se usaron.
        const reverted = await this.getParticipant(participant.connectionId)
        if (reverted) {
          reverted.subscribedVideoTrackNames = reverted.subscribedVideoTrackNames.filter(
            (name) => !newVideoNames.includes(name)
          )
          await this.putParticipant(reverted)
        }
      }
      // Antes esto re-tiraba el error tal cual, y el runtime de Workers lo
      // convierte en un 500 de texto plano genérico ("Internal Server
      // Error") sin CORS ni body -- el cliente no tenía forma de saber qué
      // pasó, y a mí (debuggeando) tampoco sin acceso a la terminal de
      // `wrangler dev`. Cloudflare Realtime SFU es un upstream real: puede
      // fallar (rate limit, timeout, error transitorio) sin que sea un bug
      // nuestro -- lo correcto es devolver un error estructurado, no dejar
      // que se escape como una excepción sin manejar.
      const message = err instanceof realtime.RealtimeApiError ? err.message : 'unexpected_error'
      return jsonResponse({ error: 'sfu_subscribe_failed', message }, { status: 502 })
    }
  }

  // --- SFU: desuscribirse de tracks remotos ---
  // force:true (ver realtime.ts) corta el flujo de datos sin renegociación
  // SDP -- no hace falta tocar el PeerConnection del cliente solo para dejar
  // de ver a alguien. Acá no hace falta la misma disciplina de "reservar
  // antes del fetch" que en subscribe: subcontar de más (dejar un track
  // como "todavía suscrito" por un instante de más si hay una carrera) es
  // el lado seguro, no un bypass del cap.
  private async handleUnsubscribe(request: Request): Promise<Response> {
    const body = (await request.json()) as {
      connectionId: string
      tracks: { mid: string; trackName: string }[]
    }
    const participant = await this.getParticipant(body.connectionId)
    if (!participant || !participant.sfuSessionId) {
      return jsonResponse({ error: 'no_sfu_session' }, { status: 409 })
    }

    const response = await realtime.closeTracks(
      this.realtimeConfig(),
      participant.sfuSessionId,
      body.tracks.map((t) => t.mid),
      { force: true }
    )

    const closedNames = new Set(body.tracks.map((t) => t.trackName))
    participant.subscribedVideoTrackNames = participant.subscribedVideoTrackNames.filter(
      (name) => !closedNames.has(name)
    )
    await this.putParticipant(participant)

    return jsonResponse(response)
  }

  // --- SFU: completar renegociación (típico tras suscribirse) ---
  private async handleRenegotiate(request: Request): Promise<Response> {
    const body = (await request.json()) as {
      connectionId: string
      answer: realtime.SessionDescription
    }
    const participant = await this.getParticipant(body.connectionId)
    if (!participant || !participant.sfuSessionId) {
      return jsonResponse({ error: 'no_sfu_session' }, { status: 409 })
    }

    const response = await realtime.renegotiate(this.realtimeConfig(), participant.sfuSessionId, body.answer)
    return jsonResponse(response)
  }

  // --- SFU: cambiar la capa de simulcast de un track YA suscrito (Parte C) ---
  // El `mid` lo manda el cliente (mismo patrón que handleUnsubscribe) -- el
  // backend hoy no trackea mid del lado servidor, y agregarlo solo para esto
  // sería estado duplicado sin necesidad real. A diferencia del cap de video
  // (Parte A), acá no hay ningún límite que un cliente pueda saltarse pidiendo
  // un mid ajeno: como mucho pide más bitrate para SU PROPIA sesión, nunca
  // afecta a otros participantes ni bypasea MAX_VISIBLE_TILES -- por eso no
  // amerita la misma disciplina de "nunca confiar el kind del cliente" que sí
  // aplica en handleSubscribe.
  private async handleTrackQuality(request: Request): Promise<Response> {
    const body = (await request.json()) as {
      connectionId: string
      tracks: { mid: string; trackName: string; preferredRid: 'q' | 'f' }[]
    }
    const participant = await this.getParticipant(body.connectionId)
    if (!participant || !participant.sfuSessionId) {
      return jsonResponse({ error: 'no_sfu_session' }, { status: 409 })
    }

    const validTracks = body.tracks.filter((t) => t.mid && (t.preferredRid === 'q' || t.preferredRid === 'f'))
    if (validTracks.length === 0) {
      return jsonResponse({ error: 'no_valid_tracks' }, { status: 400 })
    }

    const response = await realtime.updateTrackLayer(
      this.realtimeConfig(),
      participant.sfuSessionId,
      validTracks.map((t) => ({ mid: t.mid, preferredRid: t.preferredRid }))
    )
    return jsonResponse(response)
  }

  // --- SFU: detener la propia pantalla compartida (Parte D) ---
  // Mismo mecanismo que handleUnsubscribe (realtime.closeTracks con
  // force:true, sin renegociar) pero aplicado a la PROPIA sesión de quien
  // llama en vez de la de un suscriptor -- closeTracks no distingue
  // publicador de suscriptor, identifica todo por sessionId+mid.
  private async handleScreenShareStop(request: Request): Promise<Response> {
    const body = (await request.json()) as { connectionId: string; mid: string }
    const participant = await this.getParticipant(body.connectionId)
    if (!participant || !participant.sfuSessionId) {
      return jsonResponse({ error: 'no_sfu_session' }, { status: 409 })
    }

    const response = await realtime.closeTracks(this.realtimeConfig(), participant.sfuSessionId, [body.mid], {
      force: true,
    })

    delete participant.tracks.screen
    await this.putParticipant(participant)

    if ((await this.ctx.storage.get('activeScreenShare')) === body.connectionId) {
      await this.ctx.storage.delete('activeScreenShare')
    }
    this.broadcast({ type: 'screen-share-stopped', connectionId: body.connectionId })

    return jsonResponse(response)
  }

  // --- Señalización de estado de medios (Parte D) ---
  // Puramente informativo para la UI de los demás (mostrar avatar vs. video,
  // ver CallScreen.tsx) -- no valida nada de negocio, mismo espíritu que
  // track-published.
  private async handleMediaState(request: Request): Promise<Response> {
    const body = (await request.json()) as { connectionId: string; camOn: boolean; micOn: boolean }
    const participant = await this.getParticipant(body.connectionId)
    if (!participant) return jsonResponse({ error: 'unknown_connection' }, { status: 404 })

    participant.camOn = body.camOn
    await this.putParticipant(participant)

    this.broadcast(
      { type: 'media-state', connectionId: body.connectionId, camOn: body.camOn, micOn: body.micOn },
      body.connectionId
    )
    return jsonResponse({ ok: true })
  }

  // --- Admin: cerrar la sala a la fuerza ---
  private async handleForceClose(): Promise<Response> {
    await this.ctx.storage.put('closed', true)
    this.broadcast({ type: 'room-closed' })

    const participants = await this.listParticipants()
    for (const p of participants) {
      await db.recordLeave(this.env.DB, p.attendanceId)
    }
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.close(1000, 'Room closed by admin')
      } catch {
        // ya estaba cerrado
      }
    }
    await this.ctx.storage.deleteAll()

    return jsonResponse({ ok: true })
  }
}
