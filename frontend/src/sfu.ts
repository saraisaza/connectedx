import { API_BASE, fetchIceServers, postJson } from './api'

// ---------------------------------------------------------------------------
// Cliente WebRTC mínimo contra Cloudflare Realtime SFU, hablando siempre a
// través de nuestro backend (nunca directo a Cloudflare: el App Secret vive
// solo en el Worker/Durable Object).
//
// Flujo (confirmado contra la librería oficial `partytracks` y el demo
// `cloudflare/meet` de Cloudflare, ver backend/src/realtime.ts):
//   1. abrir WebSocket -> el server contesta "hello" con connectionId +
//      participantes existentes (con sus tracks ya publicados)
//   2. crear una Session del lado del SFU
//   3. publicar los tracks locales (offer propio -> answer del SFU)
//   4. suscribirse a los tracks remotos que ya existían + los que se vayan
//      publicando después (llegan como evento "track-published" por WS)
//
// Semana 4 (subsalas): moveTo() cambia de sala sin reconectar. El
// RTCPeerConnection, la sesión SFU y los tracks publicados siguen siendo los
// mismos; cambian el WebSocket de señalización y qué tracks remotos se reciben.
//
// La API HTTP de Realtime SFU no tiene un endpoint de intercambio de ICE
// candidates (no soporta trickle ICE), así que esperamos a que termine la
// recolección de candidatos (iceGatheringState === 'complete') antes de
// mandar cualquier SDP.
// ---------------------------------------------------------------------------

type Kind = 'audio' | 'video' | 'screen'

// Detección de "está hablando" (Parte B) -- ver investigación en el plan:
// ni RealtimeKit ni la extensión RTP ssrc-audio-level están disponibles acá
// (Cloudflare no la reenvía al suscriptor, confirmado empíricamente), así
// que se mide sobre el audio ya decodificado con Web Audio API.
const AUDIO_POLL_MS = 150
const AUDIO_LEVEL_EMA_DECAY = 0.7 // más alto = más lento a reaccionar, menos jitter
// Calibrados contra RMS real medido en verificación (no a ojo): un tono de
// prueba fuerte (gain 0.9) de punta a punta contra el SFU real dio ~0.065-
// 0.070 -- el valor original acá (0.12) estaba por ENCIMA de eso, así que
// nada real podía cruzarlo nunca. Encontrado recién al ver que la promoción
// a destacado nunca disparaba con un hablante real fuerte. Dejo margen
// debajo del techo medido (~0.065), no pegado a él.
const SPEAKING_ENTER_THRESHOLD = 0.035
const SPEAKING_ENTER_SUSTAIN_MS = 150
const SPEAKING_EXIT_THRESHOLD = 0.015
const SPEAKING_EXIT_SUSTAIN_MS = 500 // bajar cuesta más que subir, a propósito

// Adaptación al ancho de banda (Parte C) -- mismo patrón que el detector de
// "hablando" de arriba: umbral + histéresis, sin nada sofisticado. Se mide
// sobre getStats() sobre los inbound-rtp de VIDEO cada BANDWIDTH_CHECK_MS,
// mirando packetsLost (ratio de pérdida en la ventana) y freezeCount (freezes
// reales ya detectados por el navegador -- señal más directa que la pérdida
// sola). Dos escalones, no uno: nivel 1 (pérdida sostenida) baja todo a capa
// baja -- barato, reversible al instante; nivel 2 (sigue mal) además reduce
// cuántos cuadritos de video se piden -- más agresivo, solo si nivel 1 no
// alcanzó. Recuperar exige más ventanas buenas seguidas que las malas que
// hicieron falta para degradar, a propósito (mismo espíritu que "bajar
// cuesta más que subir" del detector de audio, acá invertido: recuperar
// cuesta más que degradar, para no oscilar).
const BANDWIDTH_CHECK_MS = 2500
const BANDWIDTH_BAD_LOSS_RATIO = 0.08
const BANDWIDTH_GOOD_LOSS_RATIO = 0.02
const BANDWIDTH_LEVEL1_BAD_WINDOWS = 2 // ~5s sostenido
const BANDWIDTH_LEVEL2_BAD_WINDOWS = 5 // ~12.5s sostenido
const BANDWIDTH_RECOVER_GOOD_WINDOWS = 3 // ~7.5s de mejora sostenida

// Parte D: umbral de seguridad para la salvaguarda de garbage collection de
// Cloudflare. El propio backend documenta (roomSession.ts) que un track
// publicado se garbage-colecta a los ~30s de inactividad -- si "modo solo
// audio"/mute estuvo apagado más que esto, un replaceTrack() solo para
// volver a prender puede estar reviviendo un track que el SFU ya purgó en
// silencio. Margen bajo los 30s documentados, no pegado al límite.
const MEDIA_STALE_THRESHOLD_MS = 25_000

// Esperas entre reintentos de un pull de audio o pantalla que Cloudflare
// rechazó porque el publicador todavía no mandaba paquetes (ver
// retryUncappedLater). Suman unos 45 s.
const UNCAPPED_RETRY_DELAYS_MS = [700, 1500, 3000, 5000, 8000, 12000, 15000]

// Semana 4: Cloudflare acepta hasta 64 tracks por llamada. Los pedidos más
// grandes (entrar a una sala de 300) se parten.
const MAX_TRACKS_PER_CALL = 64

// Semana 4: cuánto se espera a que ICE se recupere de un 'disconnected' antes
// de reconstruir la sesión (ver handleConnectionStateChange).
const ICE_DISCONNECT_GRACE_MS = 5000

// Semana 4: códigos con los que el servidor cierra el WebSocket a propósito
// (ver roomSession.ts).
const CLOSE_CODE_SUPERSEDED = 4001

// Semana 4: si el AudioContext de medición falla, se rearma a lo sumo una vez
// por intervalo (evita un bucle si el dispositivo sigue fallando).
const AUDIO_REBUILD_MIN_INTERVAL_MS = 10_000

interface PublicParticipant {
  connectionId: string
  nombre: string
  sfuSessionId: string | null
  tracks: { audio?: string; video?: string; screen?: string }
  camOn: boolean
}

// Resolución objetivo (alto en px) y bitrate máximo (bps) de cada capa de
// simulcast -- viene del `hello` del servidor (ver roomSession.ts), nunca
// hardcodeado acá, para que SIMULCAST_LOW_HEIGHT/etc. en wrangler.toml sean
// la única fuente de verdad.
interface SimulcastConfig {
  lowHeight: number
  lowMaxBitrateBps: number
  highHeight: number
  highMaxBitrateBps: number
}

// Semana 4: la sala a la que pertenece ahora esta conexión.
export interface RoomDescriptor {
  id: string
  nombre: string
  tipo: 'principal' | 'subsala'
  groupRoomId: string
}

interface HelloMessage {
  type: 'hello'
  connectionId: string
  connectionSecret: string
  participants: PublicParticipant[]
  maxVisibleTiles: number
  simulcast: SimulcastConfig
  screenShareMaxBitrateBps: number
  room: RoomDescriptor
  epoch: number
  sfuSessionId: string | null
}

type ServerMessage =
  | HelloMessage
  | { type: 'participant-joined'; participant: PublicParticipant }
  | { type: 'participant-left'; connectionId: string }
  | { type: 'track-published'; connectionId: string; kind: Kind; sessionId: string; trackName: string }
  | { type: 'screen-share-stopped'; connectionId: string }
  | { type: 'media-state'; connectionId: string; camOn: boolean; micOn: boolean }
  | { type: 'room-closed' }
  | { type: 'subsala-closed'; groupRoomId: string }
  | { type: 'subsalas-changed' }
  // Semana 4: la misma persona entró desde otra sala, pestaña o dispositivo.
  | { type: 'superseded' }

export interface SFUCallbacks {
  onParticipantJoined?: (participant: { connectionId: string; nombre: string; camOn: boolean }) => void
  onParticipantLeft?: (connectionId: string) => void
  onRemoteTrack?: (connectionId: string, kind: Kind, track: MediaStreamTrack) => void
  // Se dispara cada vez que alguien publica un track nuevo (antes de decidir
  // si se auto-suscribe o no) -- lo usa App.tsx para saber que ya puede
  // pedir el video de alguien que recién se unió y todavía no tenía cámara
  // publicada cuando se calculó la lista de "quién debería verse".
  onTrackPublished?: (connectionId: string, kind: Kind) => void
  // Nivel de audio suavizado (0-1) + si ya cruzó el umbral de "hablando" con
  // histéresis aplicada (Parte B) -- no es solo el nivel crudo.
  onAudioLevel?: (connectionId: string, level: number, speaking: boolean) => void
  // Escalón de degradación de ancho de banda detectado (Parte C): 0 = ok,
  // 1 = bajar todo a capa baja, 2 = además reducir cuántos cuadritos de video
  // se piden. Solo dispara en las TRANSICIONES de escalón, no en cada chequeo.
  onBandwidthDegraded?: (level: 0 | 1 | 2) => void
  // Parte D: alguien (posiblemente remoto) prendió/apagó su cámara de
  // verdad -- señal explícita, no inferida de si el MediaStream tiene un
  // track (ver comentario largo en CallScreen.tsx).
  onMediaState?: (connectionId: string, camOn: boolean) => void
  onScreenShareStopped?: (connectionId: string) => void
  // Semana 4: esta conexión pasó a pertenecer a otra sala (al entrar y en cada
  // moveTo). Llega ANTES de los participantes de la sala nueva, así App.tsx
  // puede vaciar los de la sala anterior.
  onRoomChanged?: (room: RoomDescriptor) => void
  // Semana 4: el host cerró la subsala actual; hay que volver a la principal.
  onSubsalaClosed?: (groupRoomId: string) => void
  // Semana 4: se crearon o cerraron subsalas en la reunión.
  onSubsalasChanged?: () => void
  // Reusa el mismo callback para reportar 'disconnected' (conexión perdida
  // de forma inesperada -- App.tsx arranca su loop de reconexión) además de
  // los pc.connectionState normales -- no se agregan callbacks nuevos para
  // esto, ver join(). Semana 4: también 'superseded' (la persona entró desde
  // otra sala, pestaña o dispositivo; no hay que reconectar).
  onStatus?: (status: string) => void
  onError?: (error: Error) => void
}

function waitForIceGatheringComplete(pc: RTCPeerConnection, timeoutMs = 4000): Promise<void> {
  if (pc.iceGatheringState === 'complete') return Promise.resolve()
  return new Promise((resolve) => {
    const onChange = () => {
      if (pc.iceGatheringState === 'complete') {
        pc.removeEventListener('icegatheringstatechange', onChange)
        clearTimeout(timer)
        resolve()
      }
    }
    const timer = setTimeout(() => {
      pc.removeEventListener('icegatheringstatechange', onChange)
      resolve()
    }, timeoutMs)
    pc.addEventListener('icegatheringstatechange', onChange)
  })
}

export interface SFUClientOptions {
  roomId: string
  userId: string // usado para nombrar los tracks publicados (`${userId}-audio`/`-video`)
  // Credencial emitida por POST /register, /reauth o /entrada (ver api.ts):
  // sin esto GET /ws rechaza el upgrade con 401 antes de llegar al Durable
  // Object. El servidor deriva el nombre a mostrar de este token, no hace
  // falta mandarlo por separado.
  token: string
  callbacks: SFUCallbacks
}

type SubscriptionItem = { sessionId: string; trackName: string; connectionId: string; kind: Kind; preferredRid?: 'q' | 'f' }

export class SFUClient {
  private pc: RTCPeerConnection | null = null
  private ws: WebSocket | null = null
  private connectionId: string | null = null
  // Semana 4: secreto de esta conexión; el backend lo exige en todo /sfu/*.
  private connectionSecret: string | null = null
  private room: RoomDescriptor | null = null

  // Serializa toda operación que toque signalingState del RTCPeerConnection:
  // publish/subscribe/renegotiate no pueden pisarse entre sí.
  private negotiationQueue: Promise<unknown> = Promise.resolve()

  // trackName -> dueño (para poder mapear el evento 'track' del pc, que solo
  // trae el mid, de vuelta a "quién lo publicó y de qué tipo es").
  private pendingTrackOwners = new Map<string, { connectionId: string; kind: Kind }>()
  private midOwners = new Map<string, { connectionId: string; kind: Kind }>()

  // Registro de todo track conocido (publicado por alguien), suscrito o no
  // -- lo que permite exponer subscribeToTracks/unsubscribeFromTracks(trackNames)
  // como una API que solo recibe nombres, sin que el llamador tenga que
  // cargar con sessionId/connectionId/kind.
  private knownTracks = new Map<string, { connectionId: string; sessionId: string; kind: Kind }>()
  // trackName -> mid del transceiver local que lo está recibiendo (necesario
  // para pedirle a Cloudflare que corte ESE track específico al desuscribirse).
  private trackNameToMid = new Map<string, string>()
  // Cap de video (Parte A): cuántos tracks de VIDEO tenemos suscritos ahora
  // mismo. El audio nunca entra acá -- no tiene límite.
  private subscribedVideoTrackNames = new Set<string>()
  // Viene del `hello` del servidor (ver roomSession.ts) -- nunca hardcodeado
  // acá, para no poder desincronizarse del valor real de MAX_VISIBLE_TILES.
  private maxVisibleTiles = Infinity

  // Audio (Parte B): un AudioContext compartido, y por participante remoto un
  // <audio> que lo reproduce más un grafo source->analyser que lo mide (así
  // suena siempre, sin importar si su tile está en la página visible), y un
  // único setInterval de polling en vez de uno por participante.
  private audioContext: AudioContext | null = null
  private audioGraphs = new Map<
    string,
    {
      element: HTMLAudioElement
      source: MediaStreamAudioSourceNode
      analyser: AnalyserNode
      buffer: Uint8Array<ArrayBuffer>
      smoothedLevel: number
      speaking: boolean
      aboveEnterSince: number | null
      belowExitSince: number | null
    }
  >()
  private audioLevelInterval: ReturnType<typeof setInterval> | null = null
  private lastAudioRebuildAt = 0

  // Simulcast (Parte C): resuelto del `hello` del servidor apenas se conoce
  // -- publishLocalTracks() lo necesita para armar sendEncodings, y siempre
  // corre después de que join() ya recibió el hello (ver join()).
  private simulcastConfig: SimulcastConfig | null = null

  // Adaptación al ancho de banda (Parte C): un solo setInterval sobre
  // getStats(), igual patrón que el polling de audio -- no uno por track.
  private bandwidthInterval: ReturnType<typeof setInterval> | null = null
  private lastVideoStatsTotals: { packetsLost: number; packetsReceived: number; freezeCount: number } | null = null
  private bandwidthLevel: 0 | 1 | 2 = 0
  private consecutiveBadBandwidthWindows = 0
  private consecutiveGoodBandwidthWindows = 0

  // Parte D: senders de los tracks LOCALES propios (cámara/mic), para poder
  // apagarlos/prenderlos de verdad vía replaceTrack sin renegociar (ver
  // applyLocalTrack). Separados de midOwners/trackNameToMid, que son sobre
  // tracks REMOTOS que recibimos, no los que publicamos.
  private audioSender: RTCRtpSender | null = null
  private videoSender: RTCRtpSender | null = null
  private camOn = true
  private micOn = true
  // Desde cuándo está apagado cada uno (null = prendido) -- salvaguarda
  // contra el garbage collection de Cloudflare a los ~30s de inactividad
  // documentado en el backend (ver MEDIA_STALE_THRESHOLD_MS).
  private mediaOffSince: { audio: number | null; video: number | null } = { audio: null, video: null }

  // Pantalla compartida (Parte D): track ADICIONAL, transceiver propio, sin
  // simulcast. Solo puede haber una persona compartiendo por sala (lo valida
  // el backend) -- este campo es null si no soy yo quien comparte.
  private screenShareMaxBitrateBps: number | null = null
  private screenTransceiver: RTCRtpTransceiver | null = null

  // Reconexión (Parte D): esta instancia se da por muerta apenas detecta una
  // desconexión inesperada (ws cerrado sin que nosotros lo pidiéramos, o el
  // pc pasa a failed) -- App.tsx es quien arma una instancia NUEVA para
  // reconectar (ver plan), esta solo necesita reportarlo una vez y
  // limpiarse. `intentionalClose` distingue un cierre nuestro (leave() o el
  // servidor avisando room-closed) de uno inesperado -- sin esto, cerrar la
  // sesión a propósito dispararía un intento de reconexión.
  private intentionalClose = false
  private unexpectedlyDisconnected = false
  private iceGraceTimer: ReturnType<typeof setTimeout> | null = null
  // Semana 4: el servidor avisó por mensaje que cierra la sala; el cierre del
  // WebSocket que sigue no es una desconexión inesperada.
  private expectingRoomClose = false

  private roomId: string
  private userId: string
  private token: string
  private callbacks: SFUCallbacks

  constructor(options: SFUClientOptions) {
    this.roomId = options.roomId
    this.userId = options.userId
    this.token = options.token
    this.callbacks = options.callbacks
  }

  private runExclusive<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.negotiationQueue.then(fn, fn)
    this.negotiationQueue = result.then(
      () => undefined,
      () => undefined
    )
    return result
  }

  // Semana 4: identificación de esta conexión en cada llamada a /sfu/*.
  private auth(): { connectionId: string | null; connectionSecret: string | null } {
    return { connectionId: this.connectionId, connectionSecret: this.connectionSecret }
  }

  async join(localStream: MediaStream): Promise<void> {
    const iceServers = await fetchIceServers(this.roomId)
    const pc = new RTCPeerConnection({ iceServers, bundlePolicy: 'max-bundle' })
    this.pc = pc
    pc.addEventListener('track', (event) => this.handleTrackEvent(event))
    pc.addEventListener('connectionstatechange', () => this.handleConnectionStateChange(pc))

    const { ws, hello } = await this.openWebSocket(this.roomId, this.token)
    this.ws = ws
    this.applyHello(hello)

    await this.createSfuSession()
    await this.publishLocalTracks(localStream)
    this.startBandwidthMonitor()
    await this.subscribeToHelloParticipants(hello)
  }

  // Semana 4: cambiar de sala dentro de la misma reunión sin reconectar. Si algo
  // falla ANTES de que la sala destino acepte la conexión, esta instancia sigue
  // en la sala actual como si nada. Si falla DESPUÉS, D1 ya ubica a la persona
  // en la sala destino: se trata como una desconexión y la reconexión de
  // App.tsx la lleva ahí.
  async moveTo(target: { roomId: string; token: string }): Promise<void> {
    if (!this.pc || this.isDisconnected()) throw new Error('No hay una conexión activa para cambiar de sala')

    const previousWs = this.ws
    const wasExpectingClose = this.expectingRoomClose
    // La sala destino le avisa a la de origen apenas acepta la conexión nueva,
    // y ese cierre de la conexión vieja (4001) puede llegar antes que el hello:
    // durante el cambio es un cierre esperado.
    this.expectingRoomClose = true
    // El audio de la sala actual se silencia al instante para no mezclar
    // conversaciones mientras dura el cambio.
    this.setRemoteAudioMuted(true)
    let opened: { ws: WebSocket; hello: HelloMessage }
    try {
      opened = await this.openWebSocket(target.roomId, target.token)
    } catch (err) {
      this.setRemoteAudioMuted(false)
      this.expectingRoomClose = wasExpectingClose
      // Si la conexión vieja ya no está abierta (la sala destino alcanzó a
      // aceptar el movimiento, o la subsala se cerró), no hay dónde quedarse:
      // se reconstruye y la reconexión va a donde diga D1.
      if (!previousWs || previousWs.readyState !== WebSocket.OPEN) this.handleUnexpectedDisconnect()
      throw err
    }

    try {
      // Desde acá esta instancia pertenece a la sala destino: el cierre del
      // WebSocket viejo ya no dispara reconexión (ver openWebSocket).
      const received = [...this.trackNameToMid.entries()].map(([trackName, mid]) => ({ trackName, mid }))
      this.ws = opened.ws
      this.roomId = target.roomId
      this.token = target.token
      this.expectingRoomClose = false
      this.resetRemoteState()
      this.applyHello(opened.hello)
      try {
        previousWs?.close(1000, 'Cambio de sala')
      } catch {
        // ya estaba cerrado (por ejemplo, la subsala se cerró)
      }

      // Se suelta sin renegociar todo lo que se recibía de la sala anterior.
      // La sesión SFU es la misma, así que se pide a través de la sala nueva.
      if (received.length > 0) await this.unsubscribeItems(received).catch(() => {})

      // La sala destino adopta la sesión y los tracks que ya se publicaban.
      if (!opened.hello.sfuSessionId) throw new Error('La sala destino no recibió la sesión de video')
      const kinds: ('audio' | 'video')[] = []
      if (this.audioSender) kinds.push('audio')
      if (this.videoSender) kinds.push('video')
      await postJson(`/api/rooms/${this.roomId}/sfu/adopt`, { ...this.auth(), kinds, camOn: this.camOn, micOn: this.micOn })

      await this.subscribeToHelloParticipants(opened.hello)
    } catch (err) {
      this.handleUnexpectedDisconnect()
      throw err
    }
  }

  // Semana 4: para cuando App.tsx necesita abandonar esta conexión y
  // reconstruir desde cero (por ejemplo, si no pudo volver a la principal
  // después de que se cerró la subsala).
  reconnectFromScratch(): void {
    this.handleUnexpectedDisconnect()
  }

  private applyHello(hello: HelloMessage): void {
    this.connectionId = hello.connectionId
    this.connectionSecret = hello.connectionSecret
    this.maxVisibleTiles = hello.maxVisibleTiles
    this.simulcastConfig = hello.simulcast
    this.screenShareMaxBitrateBps = hello.screenShareMaxBitrateBps
    this.room = hello.room
    this.callbacks.onRoomChanged?.(hello.room)
  }

  // Audio y pantalla compartida de TODOS los participantes, siempre (no
  // tienen límite) -- se auto-suscriben acá mismo. Video NO se
  // auto-suscribe más: quién ve a quién ahora lo decide usePagedGallery
  // del lado de App.tsx (Parte B), llamando a subscribeToParticipantVideo()
  // explícitamente una vez que sabe el orden real (active speaker,
  // paginación). Antes de Parte B esto vivía acá como "los primeros N en
  // el orden del backend" -- ya no.
  private async subscribeToHelloParticipants(hello: HelloMessage): Promise<void> {
    const initialUncappedTracks: SubscriptionItem[] = []
    for (const p of hello.participants) {
      this.callbacks.onParticipantJoined?.({ connectionId: p.connectionId, nombre: p.nombre, camOn: p.camOn })
      if (!p.sfuSessionId) continue
      if (p.tracks.audio) {
        this.registerKnownTrack(p.tracks.audio, p.connectionId, p.sfuSessionId, 'audio')
        initialUncappedTracks.push({ sessionId: p.sfuSessionId, trackName: p.tracks.audio, connectionId: p.connectionId, kind: 'audio' })
      }
      if (p.tracks.video) {
        this.registerKnownTrack(p.tracks.video, p.connectionId, p.sfuSessionId, 'video')
      }
      if (p.tracks.screen) {
        this.registerKnownTrack(p.tracks.screen, p.connectionId, p.sfuSessionId, 'screen')
        initialUncappedTracks.push({ sessionId: p.sfuSessionId, trackName: p.tracks.screen, connectionId: p.connectionId, kind: 'screen' })
      }
    }
    if (initialUncappedTracks.length > 0) await this.requestSubscription(initialUncappedTracks)
  }

  // Semana 4: todo lo que esta instancia sabe de los participantes REMOTOS de
  // la sala actual. Lo propio (PeerConnection, senders, sesión SFU) no se toca.
  private resetRemoteState(): void {
    for (const connectionId of [...this.audioGraphs.keys()]) this.teardownAudioGraph(connectionId)
    this.knownTracks.clear()
    this.trackNameToMid.clear()
    this.midOwners.clear()
    this.pendingTrackOwners.clear()
    this.subscribedVideoTrackNames.clear()
  }

  // Parte B (usePagedGallery) necesita este número para paginar -- viene del
  // `hello` del servidor, nunca hardcodeado del lado del cliente.
  getMaxVisibleTiles(): number {
    return this.maxVisibleTiles
  }

  // Parte D: App.tsx lo necesita para saber si UNA pantalla compartida
  // dada es la propia (no llega por broadcast -- el servidor excluye al
  // propio publicador, ver roomSession.ts handlePublish).
  getConnectionId(): string | null {
    return this.connectionId
  }

  getRoom(): RoomDescriptor | null {
    return this.room
  }

  // Semana 4: App.tsx lo usa para no instalar como cliente activo uno que se
  // cayó mientras terminaba su propio join() durante una reconexión.
  isDisconnected(): boolean {
    return this.unexpectedlyDisconnected || this.intentionalClose
  }

  leave(): void {
    this.intentionalClose = true
    this.clearIceGrace()
    this.ws?.close()
    this.pc?.close()
    if (this.audioLevelInterval) clearInterval(this.audioLevelInterval)
    if (this.bandwidthInterval) clearInterval(this.bandwidthInterval)
    for (const connectionId of [...this.audioGraphs.keys()]) this.teardownAudioGraph(connectionId)
    this.audioContext?.close().catch(() => {})
  }

  // Parte D: se dispara UNA sola vez por instancia (ws close y pc failed
  // pueden llegar casi juntos para el mismo evento de red -- sin este guard,
  // dispararían dos avisos/limpiezas). Reporta la pérdida por el mismo
  // `onStatus` de siempre (string 'disconnected') y se limpia -- NO intenta
  // reconectarse a sí misma, eso lo hace App.tsx armando una instancia nueva
  // (ver plan: "reconstruir, no resucitar").
  private handleUnexpectedDisconnect(): void {
    if (this.unexpectedlyDisconnected) return
    this.unexpectedlyDisconnected = true
    this.callbacks.onStatus?.('disconnected')
    this.leave()
  }

  // Un 'failed' inesperado (nunca si el cierre lo pedimos nosotros) dispara
  // el flujo de reconexión -- ver handleUnexpectedDisconnect. Semana 4:
  // 'disconnected' ya no lo dispara al instante. ICE suele recuperarse solo de
  // un corte breve, y reconstruir la sesión hace que el resto de la sala vea a
  // la persona salir y volver a entrar (pasó en la prueba de 16): se espera
  // ICE_DISCONNECT_GRACE_MS. Cualquier otro estado sigue reportándose tal
  // cual por onStatus.
  private handleConnectionStateChange(pc: RTCPeerConnection): void {
    if (this.intentionalClose) return
    const state = pc.connectionState
    if (state === 'failed') {
      this.clearIceGrace()
      this.handleUnexpectedDisconnect()
      return
    }
    if (state === 'disconnected') {
      if (!this.iceGraceTimer) {
        this.iceGraceTimer = setTimeout(() => {
          this.iceGraceTimer = null
          if (pc.connectionState === 'disconnected' || pc.connectionState === 'failed') this.handleUnexpectedDisconnect()
        }, ICE_DISCONNECT_GRACE_MS)
      }
      return
    }
    this.clearIceGrace()
    this.callbacks.onStatus?.(state)
  }

  private clearIceGrace(): void {
    if (this.iceGraceTimer) clearTimeout(this.iceGraceTimer)
    this.iceGraceTimer = null
  }

  private registerKnownTrack(trackName: string, connectionId: string, sessionId: string, kind: Kind): void {
    this.knownTracks.set(trackName, { connectionId, sessionId, kind })
  }

  // API pública explícita que pide el enunciado: el llamador solo maneja
  // nombres de track, no tiene que cargar con sessionId/connectionId/kind
  // (se resuelven acá contra knownTracks, poblado por hello/participant-joined/
  // track-published). Esta semana no hay UI que las dispare directamente
  // (grid/paginación es Parte B) -- las usa internamente join()/track-published,
  // y quedan listas para cuando esa UI exista.
  async subscribeToTracks(trackNames: string[]): Promise<void> {
    const items = trackNames
      .map((name) => {
        const info = this.knownTracks.get(name)
        return info ? { sessionId: info.sessionId, trackName: name, connectionId: info.connectionId, kind: info.kind } : null
      })
      .filter((x): x is SubscriptionItem => x !== null)
    if (items.length > 0) await this.requestSubscription(items)
  }

  // Conveniencia sobre subscribeToTracks/unsubscribeFromTracks para el caso
  // de uso real de Parte B: App.tsx (vía usePagedGallery) razona en
  // connectionId, no en trackName -- no debería tener que saber que un
  // participante "es" un trackName de video en algún momento dado. Resuelve
  // acá contra knownTracks; si el participante todavía no publicó video
  // (recién se unió), se omite silenciosamente -- se resuelve solo cuando
  // llegue su track-published (ver callback onTrackPublished).
  //
  // BATCHEADAS a propósito -- una sola llamada al backend para TODOS los
  // connectionId pedidos, no una por participante. La primera versión de
  // esto (Parte B inicial) llamaba una vez por connectionId dentro de un
  // for-loop en App.tsx: con 10 cuadritos cambiando de página de una, eso
  // eran 10 round-trips HTTP separados en vez de 1 -- a escala real (300
  // personas, cambios de página frecuentes) generaba ráfagas de requests
  // concurrentes contra el mismo Durable Object que en pruebas reales con
  // ~15 participantes ya producían 500s reales del lado del SFU (verificado
  // con 25 participantes reales vía Playwright: `/sfu/subscribe` y
  // `/sfu/renegotiate` empezaban a fallar con errores enmascarados como CORS
  // -- el navegador reporta "bloqueado por CORS" cuando en realidad es una
  // excepción sin headers de CORS en la respuesta de error). Devuelve el
  // subconjunto de connectionIds que sí tenían un track de video real para
  // pedir -- el llamador reintenta más tarde los que no.
  // `featuredIds` (Parte C) decide con qué capa arranca cada suscripción
  // nueva: 'f' (alta) para quien está hablando/recién destacado, 'q' (baja)
  // para el resto -- así un cuadrito nunca arranca pidiendo más de lo que
  // necesita, sin depender de un cambio de calidad posterior para corregirlo.
  async subscribeToParticipantVideos(connectionIds: string[], featuredIds: Set<string>): Promise<Set<string>> {
    const items: SubscriptionItem[] = []
    for (const connectionId of connectionIds) {
      const trackName = this.videoTrackNameFor(connectionId)
      if (!trackName) continue
      const info = this.knownTracks.get(trackName)
      if (!info) continue
      items.push({
        sessionId: info.sessionId,
        trackName,
        connectionId,
        kind: 'video',
        preferredRid: featuredIds.has(connectionId) ? 'f' : 'q',
      })
    }
    if (items.length > 0) await this.requestSubscription(items)
    return new Set(items.map((i) => i.connectionId))
  }

  // Cambia la capa de un track de video YA suscrito (Parte C) -- fluido, sin
  // renegociar: /sfu/track-quality no toca signalingState (ver realtime.ts
  // updateTrackLayer), así que no hace falta pasar por runExclusive como sí
  // hace falta en publish/subscribe/renegotiate.
  async setTrackQuality(connectionId: string, quality: 'high' | 'low'): Promise<void> {
    const trackName = this.videoTrackNameFor(connectionId)
    if (!trackName) return
    const mid = this.trackNameToMid.get(trackName)
    if (!mid) return
    await postJson(
      `/api/rooms/${this.roomId}/sfu/track-quality`,
      { ...this.auth(), tracks: [{ mid, trackName, preferredRid: quality === 'high' ? 'f' : 'q' }] },
      'PUT'
    )
  }

  async unsubscribeFromParticipantVideos(connectionIds: string[]): Promise<void> {
    const trackNames = connectionIds
      .map((id) => this.videoTrackNameFor(id))
      .filter((name): name is string => name !== null)
    if (trackNames.length > 0) await this.unsubscribeFromTracks(trackNames)
  }

  private videoTrackNameFor(connectionId: string): string | null {
    for (const [name, info] of this.knownTracks) {
      if (info.connectionId === connectionId && info.kind === 'video') return name
    }
    return null
  }

  async unsubscribeFromTracks(trackNames: string[]): Promise<void> {
    const items = trackNames
      .map((name) => {
        const mid = this.trackNameToMid.get(name)
        return mid ? { mid, trackName: name } : null
      })
      .filter((x): x is { mid: string; trackName: string } => x !== null)
    if (items.length === 0) return

    await this.unsubscribeItems(items)

    for (const item of items) {
      this.trackNameToMid.delete(item.trackName)
      this.subscribedVideoTrackNames.delete(item.trackName)
      this.midOwners.delete(item.mid)
    }
  }

  // force:true del lado del servidor: corta el flujo sin renegociar. De a
  // MAX_TRACKS_PER_CALL por llamada.
  private async unsubscribeItems(items: { mid: string; trackName: string }[]): Promise<void> {
    for (let i = 0; i < items.length; i += MAX_TRACKS_PER_CALL) {
      const chunk = items.slice(i, i + MAX_TRACKS_PER_CALL)
      await this.runExclusive(async () => {
        await postJson(`/api/rooms/${this.roomId}/sfu/unsubscribe`, { ...this.auth(), tracks: chunk }, 'PUT')
      })
    }
  }

  // Abre el WebSocket de señalización de una sala y espera su `hello`. No
  // instala el socket como el actual: lo hace quien llama (join o moveTo).
  // Mensajes y cierres de un socket que ya no es el actual se ignoran, así el
  // WebSocket de la sala anterior no puede disparar nada después de un cambio.
  private openWebSocket(roomId: string, token: string): Promise<{ ws: WebSocket; hello: HelloMessage }> {
    return new Promise((resolve, reject) => {
      const wsBase = API_BASE.replace(/^http/, 'ws')
      const url = `${wsBase}/api/rooms/${roomId}/ws?token=${encodeURIComponent(token)}`
      const ws = new WebSocket(url)
      let settled = false

      const onFirstMessage = (event: MessageEvent) => {
        const msg = JSON.parse(event.data) as ServerMessage
        if (msg.type !== 'hello') return // no debería pasar, pero no rompemos si pasa
        ws.removeEventListener('message', onFirstMessage)
        ws.addEventListener('message', (e) => {
          if (ws === this.ws) this.handleServerMessage(JSON.parse(e.data))
        })
        settled = true
        resolve({ ws, hello: msg })
      }
      ws.addEventListener('message', onFirstMessage)
      ws.addEventListener('error', () => {
        if (settled) return
        settled = true
        reject(new Error('No se pudo abrir el WebSocket de señalización'))
      })
      // Parte D: un cierre que NOSOTROS no pedimos (leave()/room-closed
      // marcan intentionalClose ANTES de cerrar) es una desconexión
      // inesperada -- dispara el mismo flujo que un pc failed.
      ws.addEventListener('close', (event) => {
        if (!settled) {
          settled = true
          reject(new Error('No se pudo abrir el WebSocket de señalización'))
          return
        }
        if (ws !== this.ws || this.intentionalClose) return
        // Cierre esperado: la sala avisó por mensaje que cierra (room-closed o
        // subsala-closed), o hay un cambio de sala en curso y la sala de origen
        // cierra la conexión vieja con 4001 antes de que llegue el hello de la
        // sala destino (ver moveTo).
        if (this.expectingRoomClose) return
        // Semana 4: 4001 = la persona entró desde otra sala, pestaña o
        // dispositivo. Reconectar solo volvería a desplazar a la otra conexión.
        if (event.code === CLOSE_CODE_SUPERSEDED) {
          this.callbacks.onStatus?.('superseded')
          this.leave()
          return
        }
        // Sin aviso previo, se reconecta: /reauth dirá si la sala se cerró o a
        // qué sala volver.
        this.handleUnexpectedDisconnect()
      })
    })
  }

  private handleServerMessage(msg: ServerMessage) {
    switch (msg.type) {
      case 'participant-joined':
        this.callbacks.onParticipantJoined?.(msg.participant)
        break
      case 'participant-left': {
        // Se sueltan TODOS los tracks que se recibían de quien se fue, no solo
        // el video: antes el audio seguía llegando (y costando ancho de banda)
        // aunque ya no sonara. Con subsalas importa más: a quien se mudó a otra
        // sala no se lo debe seguir recibiendo acá. Best-effort: el servidor
        // igual libera el cupo de video (ver roomSession.ts handleDisconnect).
        const received = [...this.knownTracks.entries()]
          .filter(([trackName, info]) => info.connectionId === msg.connectionId && this.trackNameToMid.has(trackName))
          .map(([trackName]) => trackName)
        if (received.length > 0) this.unsubscribeFromTracks(received).catch(() => {})
        for (const [trackName, info] of this.knownTracks) {
          if (info.connectionId === msg.connectionId) this.knownTracks.delete(trackName)
        }
        this.teardownAudioGraph(msg.connectionId)
        this.callbacks.onParticipantLeft?.(msg.connectionId)
        break
      }
      case 'track-published': {
        this.registerKnownTrack(msg.trackName, msg.connectionId, msg.sessionId, msg.kind)
        this.callbacks.onTrackPublished?.(msg.connectionId, msg.kind)
        // Audio y pantalla compartida siempre se auto-suscriben (ninguno
        // tiene cap, Parte D). Video NO se auto-suscribe -- lo pide App.tsx
        // explícitamente vía subscribeToParticipantVideo() si este
        // participante ya debería estar visible (ver comentario en join()).
        if (msg.kind === 'audio' || msg.kind === 'screen') {
          this.requestSubscription([
            { sessionId: msg.sessionId, trackName: msg.trackName, connectionId: msg.connectionId, kind: msg.kind },
          ]).catch((err) => this.callbacks.onError?.(err instanceof Error ? err : new Error(String(err))))
        }
        break
      }
      case 'screen-share-stopped': {
        // Limpieza de bookkeeping local -- el force:true del lado del
        // publicador (ver roomSession.ts handleScreenShareStop) corta el
        // flujo real, pero no limpia nuestros mids/knownTracks locales.
        // Best-effort: si esta llamada falla, igual quedó libre para
        // volver a compartir (el trackName es determinístico por userId, no
        // por sesión).
        for (const [trackName, info] of this.knownTracks) {
          if (info.connectionId !== msg.connectionId || info.kind !== 'screen') continue
          if (this.trackNameToMid.has(trackName)) this.unsubscribeFromTracks([trackName]).catch(() => {})
          this.knownTracks.delete(trackName)
        }
        this.callbacks.onScreenShareStopped?.(msg.connectionId)
        break
      }
      case 'media-state':
        this.callbacks.onMediaState?.(msg.connectionId, msg.camOn)
        break
      case 'room-closed':
        this.expectingRoomClose = true
        this.callbacks.onStatus?.('room-closed')
        this.leave()
        break
      case 'subsala-closed':
        // La conexión con esta subsala se va a cerrar; la PeerConnection sigue
        // viva para que App.tsx mueva a la persona a la principal.
        this.expectingRoomClose = true
        this.callbacks.onSubsalaClosed?.(msg.groupRoomId)
        break
      case 'subsalas-changed':
        this.callbacks.onSubsalasChanged?.()
        break
      case 'superseded':
        // Mismo significado que el cierre con 4001, pero llega antes: el
        // evento `close` depende de que termine el cierre de la conexión.
        // Durante un cambio de sala es la sala de origen soltando la conexión
        // vieja (ver moveTo), no otra pestaña.
        if (this.expectingRoomClose) break
        this.callbacks.onStatus?.('superseded')
        this.leave()
        break
    }
  }

  private handleTrackEvent(event: RTCTrackEvent) {
    const mid = event.transceiver.mid
    if (!mid) return
    const owner = this.midOwners.get(mid)
    if (!owner) return
    if (owner.kind === 'audio') {
      // El audio ya no se manda a la UI vía onRemoteTrack: arma su propio
      // grafo de Web Audio y suena solo, sin depender de que su tile esté
      // montado (ver Parte B -- con paginación real, "montado" ya no
      // significa "visible ahora mismo").
      this.setupAudioGraph(owner.connectionId, event.track)
      return
    }
    this.callbacks.onRemoteTrack?.(owner.connectionId, owner.kind, event.track)
  }

  // --- Audio (Parte B): medición de nivel + reproducción, desacoplada de la UI ---

  private ensureAudioContext(): AudioContext {
    if (!this.audioContext) {
      const ctx = new AudioContext()
      // Semana 4: si el dispositivo o el renderer de audio fallan, Chromium
      // detiene el contexto y emite 'error' (Chrome 127+). Se rearma la
      // medición; la reproducción no depende de esto (va por <audio>).
      ctx.addEventListener('error', () => this.rebuildAudioAnalysis())
      // Requiere gesto de usuario en algunos navegadores; join() siempre se
      // dispara desde el submit real del formulario, así que ya estamos
      // dentro de ese gesto acá.
      ctx.resume().catch(() => {})
      this.audioContext = ctx
    }
    return this.audioContext
  }

  private rebuildAudioAnalysis(): void {
    if (this.intentionalClose) return
    const now = Date.now()
    if (now - this.lastAudioRebuildAt < AUDIO_REBUILD_MIN_INTERVAL_MS) return
    this.lastAudioRebuildAt = now

    const previous = this.audioContext
    this.audioContext = null
    previous?.close().catch(() => {})
    const ctx = this.ensureAudioContext()
    for (const graph of this.audioGraphs.values()) {
      graph.source.disconnect()
      graph.analyser.disconnect()
      const stream = graph.element.srcObject
      if (!(stream instanceof MediaStream)) continue
      graph.source = ctx.createMediaStreamSource(stream)
      graph.analyser = ctx.createAnalyser()
      graph.analyser.fftSize = 512
      graph.source.connect(graph.analyser)
      graph.smoothedLevel = 0
    }
  }

  private setupAudioGraph(connectionId: string, track: MediaStreamTrack): void {
    // Si la misma persona vuelve a llegar (resuscripción), el <audio> anterior
    // no puede quedar sonando al mismo tiempo que el nuevo.
    this.teardownAudioGraph(connectionId)
    const ctx = this.ensureAudioContext()
    const stream = new MediaStream([track])
    // Semana 4: el audio remoto suena por un <audio> propio y WebAudio queda
    // solo para medir quién habla. Chromium no decodifica un track WebRTC
    // remoto que ningún elemento de medios reproduce: conectado solo a
    // ctx.destination llegaba en silencio. Medido con 3 participantes y el
    // publicador mandando un tono: 0 muestras decodificadas por segundo y RMS
    // 0; con un <audio> reproduciendo el mismo track, 48.480 muestras/s y RMS
    // 0,65. Por eso el active speaker de Parte B nunca marcaba a nadie.
    const element = new Audio()
    element.autoplay = true
    element.srcObject = stream
    element.play().catch(() => {})
    const source = ctx.createMediaStreamSource(stream)
    const analyser = ctx.createAnalyser()
    analyser.fftSize = 512
    source.connect(analyser)
    this.audioGraphs.set(connectionId, {
      element,
      source,
      analyser,
      buffer: new Uint8Array(new ArrayBuffer(analyser.fftSize)),
      smoothedLevel: 0,
      speaking: false,
      aboveEnterSince: null,
      belowExitSince: null,
    })
    if (!this.audioLevelInterval) {
      this.audioLevelInterval = setInterval(() => this.pollAudioLevels(), AUDIO_POLL_MS)
    }
  }

  private teardownAudioGraph(connectionId: string): void {
    const graph = this.audioGraphs.get(connectionId)
    if (!graph) return
    graph.element.pause()
    graph.element.srcObject = null
    graph.source.disconnect()
    graph.analyser.disconnect()
    this.audioGraphs.delete(connectionId)
  }

  // Semana 4: silenciar el audio de los demás sin soltar nada (mientras dura
  // un cambio de sala).
  private setRemoteAudioMuted(muted: boolean): void {
    for (const graph of this.audioGraphs.values()) graph.element.muted = muted
  }

  private pollAudioLevels(): void {
    const now = Date.now()
    for (const [connectionId, graph] of this.audioGraphs) {
      graph.analyser.getByteTimeDomainData(graph.buffer)
      let sumSquares = 0
      for (let i = 0; i < graph.buffer.length; i++) {
        const v = (graph.buffer[i] - 128) / 128
        sumSquares += v * v
      }
      const rms = Math.sqrt(sumSquares / graph.buffer.length)
      graph.smoothedLevel = graph.smoothedLevel * AUDIO_LEVEL_EMA_DECAY + rms * (1 - AUDIO_LEVEL_EMA_DECAY)

      // Histéresis: subir a "hablando" exige estar sostenido sobre
      // ENTER_THRESHOLD; bajar exige estar sostenido bajo EXIT_THRESHOLD
      // (más laxo que subir, a propósito) -- así no parpadea con cada
      // respiración o ruido de fondo breve.
      if (graph.smoothedLevel >= SPEAKING_ENTER_THRESHOLD) {
        if (graph.aboveEnterSince === null) graph.aboveEnterSince = now
        graph.belowExitSince = null
        if (!graph.speaking && now - graph.aboveEnterSince >= SPEAKING_ENTER_SUSTAIN_MS) {
          graph.speaking = true
        }
      } else if (graph.smoothedLevel <= SPEAKING_EXIT_THRESHOLD) {
        if (graph.belowExitSince === null) graph.belowExitSince = now
        graph.aboveEnterSince = null
        if (graph.speaking && now - graph.belowExitSince >= SPEAKING_EXIT_SUSTAIN_MS) {
          graph.speaking = false
        }
      }

      this.callbacks.onAudioLevel?.(connectionId, graph.smoothedLevel, graph.speaking)
    }
  }

  // --- Adaptación al ancho de banda (Parte C) ---
  //
  // No hay señal del SFU para esto (mismo caso que "quién habla" -- ver
  // investigación de Parte B): se mide del lado del cliente con lo estándar
  // de WebRTC, getStats() sobre los inbound-rtp de VIDEO. packetsLost da la
  // tasa de pérdida de la ventana reciente; freezeCount son freezes REALES
  // que el navegador ya detectó (señal más directa que la pérdida sola, une
  // decodificación/jitter buffer, no solo la red). Ambos son contadores
  // acumulados desde que arrancó la sesión -- por eso se guarda el total
  // anterior y se compara por DELTA, igual que bytesReceived en las pruebas
  // de Parte B.
  private startBandwidthMonitor(): void {
    this.bandwidthInterval = setInterval(() => {
      this.checkBandwidth().catch(() => {})
    }, BANDWIDTH_CHECK_MS)
  }

  private async checkBandwidth(): Promise<void> {
    const pc = this.pc
    if (!pc) return

    let packetsLost = 0
    let packetsReceived = 0
    let freezeCount = 0
    const stats = await pc.getStats()
    stats.forEach((report) => {
      if (report.type !== 'inbound-rtp' || report.kind !== 'video') return
      packetsLost += report.packetsLost ?? 0
      packetsReceived += report.packetsReceived ?? 0
      freezeCount += report.freezeCount ?? 0
    })

    const prev = this.lastVideoStatsTotals
    this.lastVideoStatsTotals = { packetsLost, packetsReceived, freezeCount }
    if (!prev) return // primera muestra: todavía no hay ventana para medir un delta

    const deltaLost = Math.max(0, packetsLost - prev.packetsLost)
    const deltaReceived = Math.max(0, packetsReceived - prev.packetsReceived)
    const deltaFreeze = Math.max(0, freezeCount - prev.freezeCount)
    const totalDelta = deltaLost + deltaReceived
    const lossRatio = totalDelta > 0 ? deltaLost / totalDelta : 0

    const isBadWindow = lossRatio >= BANDWIDTH_BAD_LOSS_RATIO || deltaFreeze > 0
    const isGoodWindow = lossRatio <= BANDWIDTH_GOOD_LOSS_RATIO && deltaFreeze === 0

    if (isBadWindow) {
      this.consecutiveBadBandwidthWindows++
      this.consecutiveGoodBandwidthWindows = 0
    } else if (isGoodWindow) {
      this.consecutiveGoodBandwidthWindows++
      this.consecutiveBadBandwidthWindows = 0
    }
    // Ventana ambigua (ni claramente mala ni claramente buena): no cuenta
    // para ningún lado, pero tampoco reinicia el contador contrario -- un
    // solo paquete perdido aislado no debería descartar varias ventanas
    // buenas seguidas.

    const previousLevel = this.bandwidthLevel
    if (this.consecutiveBadBandwidthWindows >= BANDWIDTH_LEVEL2_BAD_WINDOWS) {
      this.bandwidthLevel = 2
    } else if (this.consecutiveBadBandwidthWindows >= BANDWIDTH_LEVEL1_BAD_WINDOWS) {
      this.bandwidthLevel = Math.max(this.bandwidthLevel, 1) as 0 | 1 | 2
    } else if (this.consecutiveGoodBandwidthWindows >= BANDWIDTH_RECOVER_GOOD_WINDOWS && this.bandwidthLevel > 0) {
      this.bandwidthLevel = (this.bandwidthLevel - 1) as 0 | 1 | 2
      this.consecutiveGoodBandwidthWindows = 0 // exige otra ventana sostenida completa para bajar el próximo escalón
    }

    if (this.bandwidthLevel !== previousLevel) {
      this.callbacks.onBandwidthDegraded?.(this.bandwidthLevel)
    }
  }

  private async createSfuSession(): Promise<void> {
    // La DO ya guarda el sessionId contra el participante; acá solo
    // necesitamos que la sesión quede creada del lado del SFU antes de
    // publicar/suscribir tracks.
    await postJson<{ sessionId: string }>(`/api/rooms/${this.roomId}/sfu/session`, this.auth())
  }

  private async publishLocalTracks(stream: MediaStream): Promise<void> {
    const pc = this.pc!
    const entries: { transceiver: RTCRtpTransceiver; trackName: string; kind: Kind }[] = []

    const audioTrack = stream.getAudioTracks()[0]
    const videoTrack = stream.getVideoTracks()[0]
    if (audioTrack) {
      const transceiver = pc.addTransceiver(audioTrack, { direction: 'sendonly' })
      this.audioSender = transceiver.sender // Parte D: para poder mutear de verdad (replaceTrack) sin renegociar
      entries.push({ transceiver, trackName: `${this.userId}-audio`, kind: 'audio' })
    }
    if (videoTrack) {
      // Simulcast (Parte C): dos capas, 'q' (baja) y 'f' (alta) -- dos, no
      // las tres de ejemplo de la doc de Cloudflare ('f;h;q'), porque el
      // enunciado pide exactamente dos calidades. `sendEncodings` es 100%
      // client-side (parte del spec de WebRTC): el navegador ya codifica y
      // manda ambas capas antes de que Cloudflare las toque, así que no
      // depende de ningún soporte explícito del SFU para el bitrate.
      // `scaleResolutionDownBy` no acepta un alto absoluto, solo un factor
      // relativo a la resolución YA CAPTURADA -- por eso el alto objetivo de
      // la capa baja (config.lowHeight) se convierte acá en un ratio contra
      // lo que la cámara realmente entregó.
      const config = this.simulcastConfig!
      const capturedHeight = videoTrack.getSettings().height ?? config.highHeight
      const scaleDownLow = Math.min(8, Math.max(1, capturedHeight / config.lowHeight))
      const transceiver = pc.addTransceiver(videoTrack, {
        direction: 'sendonly',
        sendEncodings: [
          { rid: 'q', scaleResolutionDownBy: scaleDownLow, maxBitrate: config.lowMaxBitrateBps },
          { rid: 'f', scaleResolutionDownBy: 1, maxBitrate: config.highMaxBitrateBps },
        ],
      })
      this.videoSender = transceiver.sender // Parte D: para poder apagar cámara de verdad sin renegociar
      entries.push({ transceiver, trackName: `${this.userId}-video`, kind: 'video' })
    }
    if (entries.length === 0) return

    await this.runExclusive(async () => {
      const offer = await pc.createOffer()
      await pc.setLocalDescription(offer)
      await waitForIceGatheringComplete(pc)
      const localDescription = pc.localDescription!

      const data = await postJson<{ sessionDescription: { type: 'answer'; sdp: string } }>(
        `/api/rooms/${this.roomId}/sfu/publish`,
        {
          ...this.auth(),
          offer: { type: localDescription.type, sdp: localDescription.sdp },
          tracks: entries.map((e) => ({ mid: e.transceiver.mid, trackName: e.trackName, kind: e.kind })),
        }
      )
      await pc.setRemoteDescription(new RTCSessionDescription(data.sessionDescription))
    })
  }

  // Arma y manda la request real de /sfu/subscribe. El backend valida
  // MAX_VISIBLE_TILES de nuevo del lado servidor (ver roomSession.ts) -- acá
  // solo se registra lo que el servidor confirma que quedó suscrito
  // (data.tracks[], no lo que se pidió), así que si el backend rechaza la
  // porción de video de una request mixta, esos trackName simplemente no
  // aparecen en la respuesta y no se cuentan como suscritos.
  //
  // Reintenta automáticamente los tracks que fallan INDIVIDUALMENTE dentro
  // de una respuesta 200 general (Cloudflare puede devolver
  // "not_found_track_error" por track cuando el publicador todavía no
  // terminó de estabilizar ese track en el instante exacto -- documentado
  // ya en Parte A para video, pero encontrado recién acá para AUDIO: sin
  // retry, un participante que se une justo cuando otro está publicando
  // podía quedarse SIN escuchar a esa persona para siempre, sin ningún
  // error visible (la request de arriba sigue devolviendo 200). Verificado
  // con Playwright: reproducía ~60% de las veces en un join rápido de 2
  // personas antes de este fix.
  private async requestSubscription(items: SubscriptionItem[], retriesLeft = 3): Promise<void> {
    // Semana 4: Cloudflare acepta hasta MAX_TRACKS_PER_CALL tracks por llamada.
    if (items.length > MAX_TRACKS_PER_CALL) {
      for (let i = 0; i < items.length; i += MAX_TRACKS_PER_CALL) {
        await this.requestSubscription(items.slice(i, i + MAX_TRACKS_PER_CALL), retriesLeft)
      }
      return
    }

    const pc = this.pc!
    for (const item of items) this.pendingTrackOwners.set(item.trackName, { connectionId: item.connectionId, kind: item.kind })

    const failed: SubscriptionItem[] = []

    await this.runExclusive(async () => {
      const data = await postJson<{
        sessionDescription: { type: 'offer'; sdp: string }
        requiresImmediateRenegotiation: boolean
        tracks?: { mid?: string | null; trackName?: string }[]
      }>(`/api/rooms/${this.roomId}/sfu/subscribe`, {
        ...this.auth(),
        tracks: items.map((i) => ({
          sessionId: i.sessionId,
          trackName: i.trackName,
          kind: i.kind,
          ...(i.preferredRid ? { preferredRid: i.preferredRid } : {}),
        })),
      })

      const confirmedNames = new Set<string>()
      for (const t of data.tracks ?? []) {
        if (!t.mid || !t.trackName) continue
        confirmedNames.add(t.trackName)
        const owner = this.pendingTrackOwners.get(t.trackName)
        if (!owner) continue
        this.midOwners.set(t.mid, owner)
        this.trackNameToMid.set(t.trackName, t.mid)
        if (owner.kind === 'video') this.subscribedVideoTrackNames.add(t.trackName)
      }
      for (const item of items) {
        if (!confirmedNames.has(item.trackName)) failed.push(item)
      }

      if (data.requiresImmediateRenegotiation) {
        await pc.setRemoteDescription(new RTCSessionDescription(data.sessionDescription))
        const answer = await pc.createAnswer()
        await pc.setLocalDescription(answer)
        await waitForIceGatheringComplete(pc)
        const localDescription = pc.localDescription!
        await postJson(
          `/api/rooms/${this.roomId}/sfu/renegotiate`,
          { ...this.auth(), answer: { type: localDescription.type, sdp: localDescription.sdp } },
          'PUT'
        )
      }
    })

    // Video: reintentos cortos, como antes (App.tsx vuelve a pedir lo que falte
    // en su próximo diff). Audio y pantalla no tienen otro camino para volver
    // a pedirse: se siguen reintentando en segundo plano. retryUncappedLater
    // llama con retriesLeft = 0, así no arranca un segundo ciclo en paralelo.
    const failedVideo = failed.filter((i) => i.kind === 'video')
    const failedUncapped = failed.filter((i) => i.kind !== 'video')
    if (failedUncapped.length > 0 && retriesLeft > 0) this.retryUncappedLater(failedUncapped, 0)
    if (failedVideo.length > 0 && retriesLeft > 0) {
      await new Promise((resolve) => setTimeout(resolve, 700))
      await this.requestSubscription(failedVideo, retriesLeft - 1)
    }
  }

  // Semana 4 (prueba con 16): Cloudflare rechaza el pull con
  // not_found_track_error hasta que el publicador manda paquetes, y los tres
  // reintentos de 700 ms no alcanzaban cuando un publicador tardaba más en
  // arrancar: quienes ya estaban en la sala no lo escuchaban nunca, sin ningún
  // error visible. Ahora se reintenta con las esperas de
  // UNCAPPED_RETRY_DELAYS_MS mientras ese track siga publicado por la misma
  // sesión, sin bloquear join().
  private retryUncappedLater(items: SubscriptionItem[], attempt: number): void {
    const delay = UNCAPPED_RETRY_DELAYS_MS[attempt]
    if (delay === undefined) {
      console.warn('[sfu] sin suscripción después de varios intentos:', items.map((i) => i.trackName))
      return
    }
    const pending = () =>
      items.filter((i) => this.knownTracks.get(i.trackName)?.sessionId === i.sessionId && !this.trackNameToMid.has(i.trackName))
    setTimeout(() => {
      if (this.isDisconnected() || pending().length === 0) return
      this.requestSubscription(pending(), 0)
        .catch(() => {})
        .finally(() => {
          if (!this.isDisconnected() && pending().length > 0) this.retryUncappedLater(pending(), attempt + 1)
        })
    }, delay)
  }

  // --- Parte D: cámara/mic reales (no track.enabled) + pantalla compartida ---

  // Apaga/prende la cámara de verdad: replaceTrack (cero renegociación, cero
  // llamada a Cloudflare -- el mid/trackName publicado no cambia) en el
  // caso común. `freshTrack` lo consigue App.tsx (mismo getUserMedia que ya
  // usa para el preview) -- sfu.ts no pide permisos de medios por su cuenta.
  async setCameraEnabled(on: boolean, freshTrack?: MediaStreamTrack): Promise<void> {
    await this.applyLocalTrack('video', on ? (freshTrack ?? null) : null)
    this.camOn = on
    await this.sendMediaState()
  }

  // Mismo mecanismo, simétrico, para el mic -- arregla el mute real (antes
  // solo hacía track.enabled=false, que igual manda RTP de silencio: sigue
  // costando ancho de banda/egress aunque no se escuche nada).
  async setMicEnabled(on: boolean, freshTrack?: MediaStreamTrack): Promise<void> {
    await this.applyLocalTrack('audio', on ? (freshTrack ?? null) : null)
    this.micOn = on
    await this.sendMediaState()
  }

  private async applyLocalTrack(kind: 'audio' | 'video', track: MediaStreamTrack | null): Promise<void> {
    const pc = this.pc
    if (!pc) return

    if (!track) {
      const sender = kind === 'audio' ? this.audioSender : this.videoSender
      await sender?.replaceTrack(null)
      this.mediaOffSince[kind] = Date.now()
      return
    }

    const offSince = this.mediaOffSince[kind]
    this.mediaOffSince[kind] = null
    const sender = kind === 'audio' ? this.audioSender : this.videoSender

    if (sender) {
      await sender.replaceTrack(track)
      // Salvaguarda de garbage collection (ver plan y MEDIA_STALE_THRESHOLD_MS):
      // si estuvo apagado más tiempo del seguro, Cloudflare pudo haber
      // purgado el trackName por inactividad -- un replaceTrack solo no
      // alcanza para "revivirlo" del lado del SFU, hace falta una
      // renegociación real que vuelva a publicar ese mismo mid.
      if (offSince !== null && Date.now() - offSince > MEDIA_STALE_THRESHOLD_MS) {
        await this.negotiateLocalTrack(kind, sender)
      }
    } else {
      // No había transceiver para este kind todavía -- típico tras una
      // reconexión que arrancó con la cámara/mic apagados (el join() de la
      // reconexión no publicó nada de este kind, ver App.tsx). Crear uno de
      // cero y negociarlo.
      const newSender = pc.addTransceiver(track, { direction: 'sendonly' }).sender
      if (kind === 'audio') this.audioSender = newSender
      else this.videoSender = newSender
      await this.negotiateLocalTrack(kind, newSender)
    }
  }

  // Publica/renegocia el track de audio o video del kind dado -- mismo
  // flujo de offer/answer que publishLocalTracks, reusado para: (a) crear
  // un transceiver que no existía, o (b) revivir un track posiblemente
  // garbage-colectado por Cloudflare tras estar mucho tiempo apagado.
  private async negotiateLocalTrack(kind: 'audio' | 'video', sender: RTCRtpSender): Promise<void> {
    const pc = this.pc
    if (!pc) return
    const transceiver = pc.getTransceivers().find((t) => t.sender === sender)
    const mid = transceiver?.mid
    if (!mid) return
    const trackName = `${this.userId}-${kind}`
    await this.runExclusive(async () => {
      const offer = await pc.createOffer()
      await pc.setLocalDescription(offer)
      await waitForIceGatheringComplete(pc)
      const localDescription = pc.localDescription!
      const data = await postJson<{ sessionDescription: { type: 'answer'; sdp: string } }>(
        `/api/rooms/${this.roomId}/sfu/publish`,
        {
          ...this.auth(),
          offer: { type: localDescription.type, sdp: localDescription.sdp },
          tracks: [{ mid, trackName, kind }],
        }
      )
      await pc.setRemoteDescription(new RTCSessionDescription(data.sessionDescription))
    })
  }

  private async sendMediaState(): Promise<void> {
    if (!this.connectionId) return
    // Best-effort: si esta llamada falla, el peor caso es que alguien vea un
    // frame congelado en vez de mi avatar por un instante -- no vale la pena
    // reintentar ni romper el toggle local por esto.
    await postJson(
      `/api/rooms/${this.roomId}/sfu/media-state`,
      { ...this.auth(), camOn: this.camOn, micOn: this.micOn },
      'PUT'
    ).catch(() => {})
  }

  // Pantalla compartida: track ADICIONAL (transceiver propio, no reemplaza
  // el de cámara), sin simulcast -- una sola capa, bitrate alto fijo desde
  // la config del `hello` (nunca hardcodeado acá). El backend valida
  // exclusividad server-side y puede rechazar con 409 ("Fulano ya está
  // compartiendo pantalla") -- se propaga tal cual (postJson ya arma
  // Error(mensaje)), el llamador (App.tsx) lo muestra.
  async startScreenShare(stream: MediaStream): Promise<void> {
    const pc = this.pc
    if (!pc) return
    const track = stream.getVideoTracks()[0]
    if (!track) return
    const bitrate = this.screenShareMaxBitrateBps ?? 2_500_000
    const transceiver = pc.addTransceiver(track, {
      direction: 'sendonly',
      sendEncodings: [{ maxBitrate: bitrate }],
    })
    this.screenTransceiver = transceiver
    const trackName = `${this.userId}-screen`

    try {
      await this.runExclusive(async () => {
        const offer = await pc.createOffer()
        await pc.setLocalDescription(offer)
        await waitForIceGatheringComplete(pc)
        const localDescription = pc.localDescription!
        const data = await postJson<{ sessionDescription: { type: 'answer'; sdp: string } }>(
          `/api/rooms/${this.roomId}/sfu/publish`,
          {
            ...this.auth(),
            offer: { type: localDescription.type, sdp: localDescription.sdp },
            tracks: [{ mid: transceiver.mid, trackName, kind: 'screen' }],
          }
        )
        await pc.setRemoteDescription(new RTCSessionDescription(data.sessionDescription))
      })
    } catch (err) {
      // El 409 de exclusividad (u otro error) llega ANTES de que Cloudflare
      // confirme nada -- este transceiver local queda inerte (nunca se
      // negoció del todo), no vale la pena desarmarlo con más ceremonia que
      // esta: el botón de "Compartir" en la UI ya se deshabilita mientras
      // se está compartiendo, así que este catch es sobre todo para el 409
      // legítimo de "otra persona ya está compartiendo".
      this.screenTransceiver = null
      throw err
    }
  }

  async stopScreenShare(): Promise<void> {
    const transceiver = this.screenTransceiver
    if (!transceiver?.mid) return
    await this.runExclusive(async () => {
      await postJson(
        `/api/rooms/${this.roomId}/sfu/screen-share/stop`,
        { ...this.auth(), mid: transceiver.mid },
        'PUT'
      )
    })
    transceiver.sender.track?.stop()
    this.screenTransceiver = null
  }
}
