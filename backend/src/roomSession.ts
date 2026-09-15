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
// Semana 4 (subsalas): una subsala es otro RoomSession, igual que cualquier
// sala. Lo que NO decide este objeto: si la sala sigue abierta y a qué sala
// del grupo pertenece cada persona. Eso vive en D1 (`rooms` y
// `ubicacion_grupo`, ver db.ts). Este objeto guarda presencia viva y converge
// a D1 al aceptar cada conexión y en cada reconciliación periódica (alarm()).
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
  // Semana 4: secreto de esta conexión. Los endpoints /sfu/* lo exigen junto al
  // connectionId, que sí se reparte a toda la sala en `hello`: sin esto
  // cualquier participante podía operar la sesión SFU de otro.
  connectionSecret: string
  // Semana 4: grupo al que pertenece la sala y epoch con el que D1 aceptó esta
  // conexión. Si D1 pasa a tener un epoch mayor para esta persona, esta
  // conexión es un fantasma (ver alarm()).
  groupRoomId: string
  epoch: number
}

interface SimulcastConfig {
  lowHeight: number
  lowMaxBitrateBps: number
  highHeight: number
  highMaxBitrateBps: number
}

interface RoomDescriptor {
  id: string
  nombre: string
  tipo: 'principal' | 'subsala'
  groupRoomId: string
}

type ServerMessage =
  | {
      type: 'hello'
      connectionId: string
      connectionSecret: string
      participants: PublicParticipant[]
      maxVisibleTiles: number
      simulcast: SimulcastConfig
      screenShareMaxBitrateBps: number
      room: RoomDescriptor
      epoch: number
      // Solo cuando la persona llega desde otra sala del grupo: la sesión SFU
      // que ya tenía y que esta sala adopta (ver handleAdopt).
      sfuSessionId: string | null
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
  // Semana 4: el host cerró esta subsala y la principal sigue abierta; los
  // clientes vuelven solos a la principal.
  | { type: 'subsala-closed'; groupRoomId: string }
  // Semana 4: se crearon o cerraron subsalas del grupo; los clientes refrescan
  // la lista.
  | { type: 'subsalas-changed' }
  // Semana 4: la misma persona entró desde otra sala, pestaña o dispositivo.
  // Llega justo antes del cierre con 4001.
  | { type: 'superseded' }

interface PublicParticipant {
  connectionId: string
  nombre: string
  sfuSessionId: string | null
  tracks: { audio?: string; video?: string; screen?: string }
  camOn: boolean
}

const PARTICIPANT_PREFIX = 'participant:'
const ROOM_ID_KEY = 'roomId'
// Códigos de cierre propios (el rango 4000-4999 es para aplicaciones).
const CLOSE_CODE_SUPERSEDED = 4001 // la persona entró desde otra sala, pestaña o dispositivo: el cliente no reintenta
const CLOSE_CODE_ROOM_CLOSED = 4002 // la sala o la subsala se cerró
// Tope documentado de tracks por llamada a tracks/new del SFU.
const MAX_TRACKS_PER_CALL = 64

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

// Semana 4: nunca menos de 5 s, para que una var mal seteada no convierta la
// reconciliación en un bucle que despierta al objeto sin parar.
function reconcileIntervalMsFrom(env: { RECONCILE_INTERVAL_MS?: string }): number {
  const n = Number(env.RECONCILE_INTERVAL_MS)
  return Number.isFinite(n) && n >= 5_000 ? n : 60_000
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

  // Semana 4: relee el registro justo antes de escribirlo. Varios handlers
  // esperan una llamada a Cloudflare entre leer y escribir, y mientras tanto el
  // Durable Object atiende otras requests (los input gates no cubren fetch
  // salientes). Escribir la copia vieja podía pisar cambios o resucitar el
  // registro de una conexión que ya se había ido.
  private async updateParticipant(
    connectionId: string,
    mutate: (p: ParticipantRecord) => void
  ): Promise<ParticipantRecord | undefined> {
    const current = await this.getParticipant(connectionId)
    if (!current) return undefined
    mutate(current)
    await this.putParticipant(current)
    return current
  }

  // Semana 4: todo /sfu/* exige connectionId + connectionSecret.
  private async authorize(body: { connectionId?: string; connectionSecret?: string }): Promise<ParticipantRecord | Response> {
    const participant = body.connectionId ? await this.getParticipant(body.connectionId) : undefined
    if (!participant) return jsonResponse({ error: 'no_sfu_session' }, { status: 409 })
    if (!body.connectionSecret || body.connectionSecret !== participant.connectionSecret) {
      return jsonResponse({ error: 'connection_secret_invalido' }, { status: 403 })
    }
    return participant
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

  private closeSockets(connectionIds: Set<string> | 'all', code: number, reason: string): void {
    for (const ws of this.ctx.getWebSockets()) {
      const [connectionId] = this.ctx.getTags(ws)
      if (connectionIds !== 'all' && !connectionIds.has(connectionId)) continue
      try {
        ws.close(code, reason)
      } catch (err) {
        // Normalmente ya estaba cerrado; se registra por si no.
        console.warn('RoomSession: no se pudo cerrar un WebSocket', code, err)
      }
    }
  }

  // Aviso de mejor esfuerzo a otra sala del grupo (rutas /internal/*, que el
  // Worker no expone). Si se pierde, la reconciliación de esa sala corrige lo
  // mismo contra D1.
  private async notifyRoom(roomId: string, path: string, body: unknown): Promise<void> {
    try {
      const stub = this.env.ROOM_SESSION.get(this.env.ROOM_SESSION.idFromName(roomId))
      await stub.fetch(
        new Request(`https://room-session${path}`, {
          method: 'POST',
          body: JSON.stringify(body),
          headers: { 'content-type': 'application/json' },
        })
      )
    } catch {
      // mejor esfuerzo
    }
  }

  private async ensureReconcileAlarm(): Promise<void> {
    if ((await this.ctx.storage.getAlarm()) === null) {
      await this.ctx.storage.setAlarm(Date.now() + reconcileIntervalMsFrom(this.env))
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
    if (url.pathname === '/sfu/adopt' && request.method === 'POST') return this.handleAdopt(request)
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
    if (url.pathname === '/internal/superseded' && request.method === 'POST') return this.handleSuperseded(request)
    if (url.pathname === '/internal/closed' && request.method === 'POST') return this.handleRoomClosed(request)
    if (url.pathname === '/internal/subsalas-changed' && request.method === 'POST') {
      this.broadcast({ type: 'subsalas-changed' })
      return jsonResponse({ ok: true })
    }

    return jsonResponse({ error: 'not_found' }, { status: 404 })
  }

  // --- "Unirse": el upgrade a WebSocket ES el evento de entrada a la sala. ---
  // Con `moveId` es la llegada de un movimiento desde otra sala del grupo (los
  // pasos 4 a 7 del protocolo de transferencia); sin `moveId`, el primer
  // ingreso después de registrarse o una reconexión.
  private async handleWebSocketUpgrade(request: Request, url: URL): Promise<Response> {
    if (request.headers.get('Upgrade') !== 'websocket') {
      return jsonResponse({ error: 'expected_websocket' }, { status: 426 })
    }

    const userId = url.searchParams.get('userId')
    const nombre = url.searchParams.get('nombre')
    const roomId = url.searchParams.get('roomId')
    const moveId = url.searchParams.get('moveId')
    if (!userId || !nombre || !roomId) {
      return jsonResponse({ error: 'missing_userId_nombre_roomId' }, { status: 400 })
    }

    // Semana 4: si la sala sigue abierta lo dice D1. Antes era una marca en el
    // storage de este objeto, que el propio deleteAll() del cierre borraba: un
    // objeto cerrado "olvidaba" que lo estaba.
    const room = await db.getRoom(this.env.DB, roomId)
    if (!room) return jsonResponse({ error: 'room_not_found' }, { status: 404 })
    const groupRoomId = db.groupIdOf(room)
    const group = room.tipo === 'principal' ? room : await db.getRoom(this.env.DB, groupRoomId)
    if (room.estado === 'cerrada' || !group || group.estado === 'cerrada') {
      return jsonResponse({ error: 'room_closed' }, { status: 410 })
    }

    // Paso 4 del protocolo: la alarma de reconciliación queda programada ANTES
    // de escribir en D1. Si este objeto muere entre la transacción y aceptar la
    // conexión, la alarma igual cierra la asistencia que quede abierta sin
    // nadie conectado.
    await this.ctx.storage.put(ROOM_ID_KEY, roomId)
    await this.ensureReconcileAlarm()

    // Escala: este await bloquea el upgrade hasta que D1 confirme la
    // transacción. Con pocos participantes es imperceptible y garantiza que el
    // registro de asistencia exista apenas alguien entra. A 300 joins
    // simultáneos (arranque de un webinar) esto serializa escrituras contra D1
    // y se vuelve el cuello de botella del join.
    const attendanceId = crypto.randomUUID()
    let arrival: db.Arrival
    try {
      arrival = moveId
        ? await db.applyMove(this.env.DB, { groupRoomId, roomId, userId, moveId, attendanceId })
        : await db.arriveWithoutMove(this.env.DB, {
            groupRoomId,
            roomId,
            userId,
            attendanceId,
            graceSinceIso: new Date(Date.now() - attendanceGraceWindowMsFrom(this.env)).toISOString(),
          })
    } catch {
      // userId tiene que venir de un registro previo real (POST /register), que
      // es lo que crea la fila en `users` que `attendance.user_id` y
      // `ubicacion_grupo.user_id` referencian. Si no existe, la FOREIGN KEY
      // rechaza la transacción: se devuelve un 400 prolijo en vez de un 500.
      return jsonResponse({ error: 'invalid_user_or_room' }, { status: 400 })
    }
    if (arrival.roomId !== roomId || !arrival.attendanceId) {
      // D1 ubica a esta persona en otra sala (o esta sala se cerró en el medio):
      // no se acepta. Una reconexión vuelve a pedir su ubicación (/reauth).
      return jsonResponse(
        { error: moveId ? 'movimiento_rechazado' : 'sala_equivocada', roomId: arrival.roomId },
        { status: 409 }
      )
    }

    // Otra conexión de la misma persona en esta sala (otra pestaña, o la
    // conexión vieja de una reconexión que todavía no se vio cerrar): la nueva
    // la reemplaza y hereda su fila de asistencia.
    await this.supersede((p) => p.userId === userId, 'Reemplazada por una conexión nueva')

    const connectionId = crypto.randomUUID()
    const pair = new WebSocketPair()
    const [client, server] = Object.values(pair)

    const record: ParticipantRecord = {
      connectionId,
      userId,
      nombre,
      attendanceId: arrival.attendanceId,
      // Al llegar desde otra sala, la sesión SFU es la que ya tenía: se toma de
      // D1, nunca del navegador.
      sfuSessionId: moveId ? arrival.sfuSessionId : null,
      tracks: {},
      subscribedVideoTrackNames: [],
      camOn: true,
      connectionSecret: crypto.randomUUID(),
      groupRoomId,
      epoch: arrival.epoch,
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
        connectionSecret: record.connectionSecret,
        participants: selectTracksToSubscribe(existing),
        maxVisibleTiles: maxVisibleTilesFrom(this.env),
        simulcast: simulcastConfigFrom(this.env),
        screenShareMaxBitrateBps: screenShareMaxBitrateBpsFrom(this.env),
        room: { id: room.id, nombre: room.nombre, tipo: room.tipo, groupRoomId },
        epoch: record.epoch,
        sfuSessionId: record.sfuSessionId,
      } satisfies ServerMessage)
    )

    this.broadcast({ type: 'participant-joined', participant: toPublic(record) }, connectionId)

    // Paso 7 del protocolo: aviso de mejor esfuerzo a la sala de origen para que
    // cierre ya la conexión vieja. Si se pierde, la reconciliación de esa sala
    // la cierra igual en menos de un intervalo.
    if (moveId && arrival.moveApplied && arrival.previousRoomId && arrival.previousRoomId !== roomId) {
      this.ctx.waitUntil(this.notifyRoom(arrival.previousRoomId, '/internal/superseded', { userId, epoch: arrival.epoch }))
    }

    return new Response(null, { status: 101, webSocket: client })
  }

  // El cliente no manda mensajes de control por WS esta semana (ver comentario
  // arriba); si llega algo, no rompemos la conexión.
  webSocketMessage(_ws: WebSocket, _message: string | ArrayBuffer) {
    // reservado para heartbeats/futuros mensajes de cliente.
  }

  async webSocketClose(ws: WebSocket, code: number, _reason: string, _wasClean: boolean) {
    // Responde el cierre que pidió el cliente; sin respuesta, el navegador no
    // dispara su `close` hasta que vence su propia espera. 1005/1006 no se
    // pueden mandar en un frame de cierre.
    const replyCode = code === 1000 || code === 1001 || (code >= 3000 && code <= 4999) ? code : 1000
    try {
      ws.close(replyCode, 'cierre')
    } catch {
      // ya estaba cerrado: el cierre lo empezó el servidor
    }
    await this.handleDisconnect(ws)
  }

  async webSocketError(ws: WebSocket, _error: unknown) {
    await this.handleDisconnect(ws)
  }

  private async handleDisconnect(ws: WebSocket) {
    const [connectionId] = this.ctx.getTags(ws)
    if (!connectionId) return
    const participant = await this.getParticipant(connectionId)
    if (!participant) return // ya lo sacó un reemplazo o el cierre de la sala

    await this.ctx.storage.delete(PARTICIPANT_PREFIX + connectionId)
    // Semana 4: la asistencia se cierra solo si no queda otra conexión de la
    // misma persona en esta sala. Si la persona se movió, la transacción del
    // movimiento ya la cerró con motivo 'moved' y este UPDATE condicional no
    // cambia nada.
    const sameUserStillHere = (await this.listParticipants()).some((p) => p.userId === participant.userId)
    if (!sameUserStillHere) await db.recordLeave(this.env.DB, participant.attendanceId, 'disconnect')

    await this.releaseParticipant(participant)
  }

  // Saca de la sala las conexiones que cumplan `match`: las cierra con 4001 (el
  // cliente no reintenta) y avisa al resto. No toca la asistencia: decide quien
  // llama (un reemplazo en la misma sala la hereda; un movimiento ya la cerró).
  private async supersede(match: (p: ParticipantRecord) => boolean, reason: string): Promise<ParticipantRecord[]> {
    const removed = (await this.listParticipants()).filter(match)
    if (removed.length === 0) return removed
    for (const p of removed) await this.ctx.storage.delete(PARTICIPANT_PREFIX + p.connectionId)
    const ids = new Set(removed.map((p) => p.connectionId))
    // El aviso va también por mensaje, igual que el cierre de sala: el evento
    // `close` puede tardar en llegarle al cliente (el cierre queda a medias
    // hasta que alguien corta la conexión TCP; un cliente de Node no lo recibe
    // nunca), y el cliente actúa con lo primero que le llegue.
    const notice = JSON.stringify({ type: 'superseded' } satisfies ServerMessage)
    for (const ws of this.ctx.getWebSockets()) {
      const [connectionId] = this.ctx.getTags(ws)
      if (!ids.has(connectionId)) continue
      try {
        ws.send(notice)
      } catch {
        // socket muerto
      }
    }
    this.closeSockets(ids, CLOSE_CODE_SUPERSEDED, reason)
    for (const p of removed) await this.releaseParticipant(p)
    return removed
  }

  // Lo que hay que liberar cuando alguien deja la sala por cualquier motivo.
  private async releaseParticipant(participant: ParticipantRecord) {
    const connectionId = participant.connectionId

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
    const body = (await request.json()) as { connectionId?: string; connectionSecret?: string }
    const auth = await this.authorize(body)
    if (auth instanceof Response) return auth

    const session = await realtime.createSession(this.realtimeConfig())
    const updated = await this.updateParticipant(auth.connectionId, (p) => {
      p.sfuSessionId = session.sessionId
    })
    if (!updated) return jsonResponse({ error: 'no_sfu_session' }, { status: 409 })

    // Semana 4: la sesión queda anotada en la ubicación de D1 para que, si la
    // persona se mueve a otra sala del grupo, esa sala reutilice esta misma
    // sesión en vez de pedirle al navegador que cree otra.
    await db.setSfuSession(this.env.DB, {
      groupRoomId: updated.groupRoomId,
      userId: updated.userId,
      epoch: updated.epoch,
      sfuSessionId: session.sessionId,
    })

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
      connectionId?: string
      connectionSecret?: string
      offer: realtime.SessionDescription
      tracks: { mid: string; trackName: string; kind: 'audio' | 'video' | 'screen' }[]
    }
    const auth = await this.authorize(body)
    if (auth instanceof Response) return auth
    const participant = auth
    if (!participant.sfuSessionId) {
      return jsonResponse({ error: 'no_sfu_session' }, { status: 409 })
    }
    // Semana 4: el nombre de cada track se deriva del userId verificado. Si no,
    // alguien podía publicar con el nombre de otra persona y confundir a quién
    // pertenece cada track (resolveKind, adopción al moverse).
    if (!Array.isArray(body.tracks) || body.tracks.some((t) => t.trackName !== `${participant.userId}-${t.kind}`)) {
      return jsonResponse({ error: 'track_name_invalido' }, { status: 400 })
    }

    const wantsScreen = body.tracks.some((t) => t.kind === 'screen')
    let reservedScreenLock = false
    if (wantsScreen) {
      const currentHolder = await this.ctx.storage.get<string>('activeScreenShare')
      if (currentHolder && currentHolder !== participant.connectionId) {
        // Auto-sanación: si el dueño registrado ya no tiene ParticipantRecord
        // (se desconectó y por algún motivo handleDisconnect no llegó a
        // liberar el lock), lo tratamos como libre en vez de bloquear la sala
        // para siempre por un estado inconsistente.
        const holderStillHere = await this.getParticipant(currentHolder)
        if (holderStillHere) {
          return jsonResponse({ error: `${holderStillHere.nombre} ya está compartiendo pantalla` }, { status: 409 })
        }
      }
      if (currentHolder !== participant.connectionId) {
        await this.ctx.storage.put('activeScreenShare', participant.connectionId)
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

      const updated = await this.updateParticipant(participant.connectionId, (p) => {
        for (const t of body.tracks) p.tracks[t.kind] = t.trackName
      })

      if (updated?.sfuSessionId) {
        for (const t of body.tracks) {
          this.broadcast(
            {
              type: 'track-published',
              connectionId: updated.connectionId,
              kind: t.kind,
              sessionId: updated.sfuSessionId,
              trackName: t.trackName,
            },
            updated.connectionId
          )
        }
      }

      return jsonResponse(response)
    } catch (err) {
      if (reservedScreenLock) await this.ctx.storage.delete('activeScreenShare')
      const message = err instanceof realtime.RealtimeApiError ? err.message : 'unexpected_error'
      return jsonResponse({ error: 'sfu_publish_failed', message }, { status: 502 })
    }
  }

  // --- SFU: adoptar la sesión de quien llega desde otra sala del grupo (Semana 4) ---
  // La sesión SFU y los tracks publicados son los mismos que en la sala de
  // origen (en Cloudflare Realtime un track se puede jalar desde cualquier
  // sesión de la app). Solo hace falta que ESTA sala sepa qué tracks tiene la
  // persona y avise al resto para que se suscriban. Los nombres se derivan del
  // userId verificado; del cliente solo se toma qué kinds tiene publicados.
  private async handleAdopt(request: Request): Promise<Response> {
    const body = (await request.json()) as {
      connectionId?: string
      connectionSecret?: string
      kinds?: string[]
      camOn?: boolean
      micOn?: boolean
    }
    const auth = await this.authorize(body)
    if (auth instanceof Response) return auth
    if (!auth.sfuSessionId) return jsonResponse({ error: 'sin_sesion_para_adoptar' }, { status: 409 })

    const kinds = [...new Set(body.kinds ?? [])].filter((k): k is 'audio' | 'video' => k === 'audio' || k === 'video')
    const updated = await this.updateParticipant(auth.connectionId, (p) => {
      for (const kind of kinds) p.tracks[kind] = `${p.userId}-${kind}`
      p.camOn = body.camOn !== false
    })
    if (!updated?.sfuSessionId) return jsonResponse({ error: 'no_sfu_session' }, { status: 409 })

    for (const kind of kinds) {
      this.broadcast(
        {
          type: 'track-published',
          connectionId: updated.connectionId,
          kind,
          sessionId: updated.sfuSessionId,
          trackName: `${updated.userId}-${kind}`,
        },
        updated.connectionId
      )
    }
    this.broadcast(
      { type: 'media-state', connectionId: updated.connectionId, camOn: updated.camOn, micOn: body.micOn !== false },
      updated.connectionId
    )
    return jsonResponse({ sessionId: updated.sfuSessionId, tracks: updated.tracks })
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
      connectionId?: string
      connectionSecret?: string
      tracks: { sessionId: string; trackName: string; kind?: 'audio' | 'video'; preferredRid?: 'q' | 'f' }[]
    }
    const auth = await this.authorize(body)
    if (auth instanceof Response) return auth
    const participant = auth
    if (!participant.sfuSessionId) {
      return jsonResponse({ error: 'no_sfu_session' }, { status: 409 })
    }
    // Semana 4: Cloudflare acepta hasta 64 tracks por llamada; el cliente parte
    // los pedidos más grandes (ver sfu.ts requestSubscription).
    if (!Array.isArray(body.tracks) || body.tracks.length > MAX_TRACKS_PER_CALL) {
      return jsonResponse({ error: 'too_many_tracks', max: MAX_TRACKS_PER_CALL }, { status: 400 })
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
          await this.updateParticipant(participant.connectionId, (p) => {
            p.subscribedVideoTrackNames = p.subscribedVideoTrackNames.filter((name) => !failedVideoNames.includes(name))
          })
        }
      }

      const body2 = wouldExceedCap ? { ...response, videoRejected: true, max: maxVisibleTiles } : response
      return jsonResponse(body2)
    } catch (err) {
      if (videoToRequest.length > 0) {
        // Revertir la reserva: la llamada real falló, esos cupos no se usaron.
        await this.updateParticipant(participant.connectionId, (p) => {
          p.subscribedVideoTrackNames = p.subscribedVideoTrackNames.filter((name) => !newVideoNames.includes(name))
        })
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
      connectionId?: string
      connectionSecret?: string
      tracks: { mid: string; trackName: string }[]
    }
    const auth = await this.authorize(body)
    if (auth instanceof Response) return auth
    const participant = auth
    if (!participant.sfuSessionId) {
      return jsonResponse({ error: 'no_sfu_session' }, { status: 409 })
    }
    if (!Array.isArray(body.tracks) || body.tracks.length > MAX_TRACKS_PER_CALL) {
      return jsonResponse({ error: 'too_many_tracks', max: MAX_TRACKS_PER_CALL }, { status: 400 })
    }

    const response = await realtime.closeTracks(
      this.realtimeConfig(),
      participant.sfuSessionId,
      body.tracks.map((t) => t.mid),
      { force: true }
    )

    const closedNames = new Set(body.tracks.map((t) => t.trackName))
    await this.updateParticipant(participant.connectionId, (p) => {
      p.subscribedVideoTrackNames = p.subscribedVideoTrackNames.filter((name) => !closedNames.has(name))
    })

    return jsonResponse(response)
  }

  // --- SFU: completar renegociación (típico tras suscribirse) ---
  private async handleRenegotiate(request: Request): Promise<Response> {
    const body = (await request.json()) as {
      connectionId?: string
      connectionSecret?: string
      answer: realtime.SessionDescription
    }
    const auth = await this.authorize(body)
    if (auth instanceof Response) return auth
    if (!auth.sfuSessionId) {
      return jsonResponse({ error: 'no_sfu_session' }, { status: 409 })
    }

    const response = await realtime.renegotiate(this.realtimeConfig(), auth.sfuSessionId, body.answer)
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
      connectionId?: string
      connectionSecret?: string
      tracks: { mid: string; trackName: string; preferredRid: 'q' | 'f' }[]
    }
    const auth = await this.authorize(body)
    if (auth instanceof Response) return auth
    if (!auth.sfuSessionId) {
      return jsonResponse({ error: 'no_sfu_session' }, { status: 409 })
    }

    const validTracks = (body.tracks ?? []).filter((t) => t.mid && (t.preferredRid === 'q' || t.preferredRid === 'f'))
    if (validTracks.length === 0) {
      return jsonResponse({ error: 'no_valid_tracks' }, { status: 400 })
    }

    const response = await realtime.updateTrackLayer(
      this.realtimeConfig(),
      auth.sfuSessionId,
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
    const body = (await request.json()) as { connectionId?: string; connectionSecret?: string; mid: string }
    const auth = await this.authorize(body)
    if (auth instanceof Response) return auth
    if (!auth.sfuSessionId) {
      return jsonResponse({ error: 'no_sfu_session' }, { status: 409 })
    }

    const response = await realtime.closeTracks(this.realtimeConfig(), auth.sfuSessionId, [body.mid], {
      force: true,
    })

    await this.updateParticipant(auth.connectionId, (p) => {
      delete p.tracks.screen
    })

    if ((await this.ctx.storage.get('activeScreenShare')) === auth.connectionId) {
      await this.ctx.storage.delete('activeScreenShare')
    }
    this.broadcast({ type: 'screen-share-stopped', connectionId: auth.connectionId })

    return jsonResponse(response)
  }

  // --- Señalización de estado de medios (Parte D) ---
  // Puramente informativo para la UI de los demás (mostrar avatar vs. video,
  // ver CallScreen.tsx) -- no valida nada de negocio, mismo espíritu que
  // track-published.
  private async handleMediaState(request: Request): Promise<Response> {
    const body = (await request.json()) as { connectionId?: string; connectionSecret?: string; camOn: boolean; micOn: boolean }
    const auth = await this.authorize(body)
    if (auth instanceof Response) return auth

    await this.updateParticipant(auth.connectionId, (p) => {
      p.camOn = body.camOn
    })

    this.broadcast(
      { type: 'media-state', connectionId: auth.connectionId, camOn: body.camOn, micOn: body.micOn },
      auth.connectionId
    )
    return jsonResponse({ ok: true })
  }

  // --- Internas (Semana 4): avisos entre salas del grupo y desde el Worker ---

  // Otra sala del grupo (o un registro nuevo de la misma persona) avisa que
  // D1 ya tiene un epoch más nuevo para esa persona: sus conexiones acá son
  // fantasmas.
  private async handleSuperseded(request: Request): Promise<Response> {
    const { userId, epoch } = (await request.json()) as { userId?: string; epoch?: number }
    if (!userId || typeof epoch !== 'number') return jsonResponse({ error: 'bad_request' }, { status: 400 })
    const removed = await this.supersede((p) => p.userId === userId && p.epoch < epoch, 'Entraste desde otra sala o pestaña')
    for (const p of removed) await db.recordLeave(this.env.DB, p.attendanceId, 'moved')
    return jsonResponse({ ok: true, cerradas: removed.length })
  }

  // El Worker ya marcó el cierre en D1 y avisa. Solo se actúa si D1 lo
  // confirma: un aviso suelto no puede vaciar una sala abierta.
  private async handleRoomClosed(request: Request): Promise<Response> {
    const { roomId } = (await request.json()) as { roomId?: string }
    const id = roomId ?? (await this.ctx.storage.get<string>(ROOM_ID_KEY))
    if (!id) return jsonResponse({ ok: true })
    const room = await db.getRoom(this.env.DB, id)
    if (room && room.estado === 'activa') {
      const group = room.tipo === 'subsala' ? await db.getRoom(this.env.DB, db.groupIdOf(room)) : room
      if (group?.estado === 'activa') return jsonResponse({ error: 'room_still_open' }, { status: 409 })
    }
    await this.closeLocally(room)
    return jsonResponse({ ok: true })
  }

  // Cierre local de una sala que D1 ya marcó cerrada (o cuyo grupo se cerró).
  // Una subsala cerrada con la principal abierta avisa 'subsala-closed' (los
  // clientes vuelven solos a la principal); si se cerró el grupo, 'room-closed'.
  private async closeLocally(room: db.Room | null): Promise<void> {
    let openGroupId: string | null = null
    if (room?.tipo === 'subsala') {
      const group = await db.getRoom(this.env.DB, db.groupIdOf(room))
      if (group?.estado === 'activa') openGroupId = group.id
    }
    this.broadcast(openGroupId ? { type: 'subsala-closed', groupRoomId: openGroupId } : { type: 'room-closed' })

    for (const p of await this.listParticipants()) {
      await db.recordLeave(this.env.DB, p.attendanceId, 'room_closed')
    }
    this.closeSockets('all', CLOSE_CODE_ROOM_CLOSED, openGroupId ? 'Subsala cerrada' : 'Sala cerrada')

    // Con compatibility_date anterior a 2026-02-24, deleteAll() no borra la
    // alarma programada: se borra aparte.
    await this.ctx.storage.deleteAlarm()
    await this.ctx.storage.deleteAll()
  }

  // --- Reconciliación periódica (Semana 4) ---
  // Corre mientras la sala tenga gente conectada o asistencia abierta, y
  // converge la presencia de este objeto a lo que dice D1:
  //   1. si la sala (o su grupo) está cerrada en D1, cierra todo acá;
  //   2. conexiones fantasma: D1 ubica a esa persona en otra sala o con un
  //      epoch más nuevo -> se cierran con 4001;
  //   3. asistencia huérfana: filas abiertas de esta sala sin ninguna conexión
  //      viva de esa persona desde hace más de un intervalo -> 'orphan'.
  // Las alarmas se ejecutan al menos una vez y pueden repetirse: cada paso es
  // idempotente.
  async alarm(): Promise<void> {
    const roomId = await this.ctx.storage.get<string>(ROOM_ID_KEY)
    if (!roomId) return
    const room = await db.getRoom(this.env.DB, roomId)
    if (!room) return
    const groupRoomId = db.groupIdOf(room)
    const group = room.tipo === 'principal' ? room : await db.getRoom(this.env.DB, groupRoomId)
    if (room.estado === 'cerrada' || !group || group.estado === 'cerrada') {
      await this.closeLocally(room)
      return
    }

    const interval = reconcileIntervalMsFrom(this.env)
    let participants = await this.listParticipants()
    if (participants.length > 0) {
      const ubicaciones = new Map((await db.listUbicacionesDelGrupo(this.env.DB, groupRoomId)).map((u) => [u.user_id, u]))
      const ghostIds = new Set(
        participants
          .filter((p) => {
            const u = ubicaciones.get(p.userId)
            return !u || u.room_id !== roomId || u.epoch > p.epoch
          })
          .map((p) => p.connectionId)
      )
      if (ghostIds.size > 0) {
        const removed = await this.supersede((p) => ghostIds.has(p.connectionId), 'Tu ubicación cambió')
        for (const p of removed) await db.recordLeave(this.env.DB, p.attendanceId, 'moved')
        participants = await this.listParticipants()
      }
    }

    const live = new Set(participants.map((p) => p.userId))
    const cutoff = new Date(Date.now() - interval).toISOString()
    const open = await db.listOpenAttendance(this.env.DB, roomId)
    const orphans = open.filter((a) => !live.has(a.user_id) && a.joined_at < cutoff)
    if (orphans.length > 0) {
      console.warn('RoomSession alarm: asistencia huérfana cerrada', roomId, orphans.length)
      await db.closeAttendanceRows(this.env.DB, orphans.map((a) => a.id), 'orphan')
    }

    if (participants.length > 0 || open.length > orphans.length) {
      await this.ctx.storage.setAlarm(Date.now() + interval)
    }
  }
}
