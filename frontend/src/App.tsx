import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { fetchRoom, reauthForRoom, registerForRoom, type RoomInfo } from './api'
import { SFUClient, type SFUCallbacks } from './sfu'
import { parseRoomIdFromPath } from './router'
import { StatusScreen } from './screens/StatusScreen'
import { PreJoinScreen } from './screens/PreJoinScreen'
import { CallScreen, type RemoteParticipant } from './screens/CallScreen'
import { usePagedGallery } from './usePagedGallery'

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

type Screen = 'loading' | 'not-found' | 'closed' | 'form' | 'call'
type Permission = 'pending' | 'granted' | 'denied' | 'no-device'
type ConnectionStatus = 'connected' | 'reconnecting'

// Backoff de reconexión (Parte D): exponencial con techo -- nunca
// reintentos pegados tipo "cada 100ms". Jitter ±20% para no sincronizar
// reintentos si cae la red de varios participantes de la misma sala a la
// vez (todos reintentando al mismo instante exacto sería su propia mini
// estampida contra el mismo Durable Object).
const RECONNECT_BACKOFF_STEPS_MS = [1000, 2000, 4000, 8000, 15000]
function reconnectBackoffMs(attempt: number): number {
  const base = RECONNECT_BACKOFF_STEPS_MS[Math.min(attempt - 1, RECONNECT_BACKOFF_STEPS_MS.length - 1)]
  const jitter = base * 0.2 * (Math.random() * 2 - 1)
  return Math.max(500, Math.round(base + jitter))
}

export default function App() {
  const [roomId] = useState(() => parseRoomIdFromPath(window.location.pathname))
  const [screen, setScreen] = useState<Screen>('loading')
  const [roomInfo, setRoomInfo] = useState<RoomInfo | null>(null)

  const [nombre, setNombre] = useState('')
  const [correo, setCorreo] = useState('')
  const [rol, setRol] = useState<'participante' | 'admin'>('participante')
  const [joining, setJoining] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [fieldErrors, setFieldErrors] = useState<{ nombre?: string; correo?: string }>({})

  const [, setStatus] = useState('idle')
  const [localStream, setLocalStream] = useState<MediaStream | null>(null)
  const [permission, setPermission] = useState<Permission>('pending')
  const [participants, setParticipants] = useState<Map<string, RemoteParticipant>>(new Map())

  const [micOn, setMicOn] = useState(true)
  const [camOn, setCamOn] = useState(true)
  const [handRaised, setHandRaised] = useState(false)
  const [elapsedSeconds, setElapsedSeconds] = useState(0)
  // Viene de client.getMaxVisibleTiles() apenas resuelve join() -- nunca
  // hardcodeado acá (ver Parte A/hello del servidor).
  const [maxVisibleTiles, setMaxVisibleTiles] = useState(10)
  // Se incrementa cada vez que ALGUIEN publica video -- dispara un reintento
  // de suscripción para quien ya debería verse pero todavía no tenía cámara
  // publicada cuando se calculó la página visible (ver efecto más abajo).
  const [videoPublishTick, setVideoPublishTick] = useState(0)
  // Escalón de degradación de ancho de banda (Parte C), ver
  // SFUCallbacks.onBandwidthDegraded en sfu.ts: 0 = ok, 1 = bajar todo a
  // capa baja, 2 = además pedir menos cuadritos de video.
  const [bandwidthLevel, setBandwidthLevel] = useState<0 | 1 | 2>(0)
  // Parte D: pantalla compartida activa en la sala (mía o de otro) --
  // null si nadie comparte. connectionId identifica al dueño para poder
  // distinguir "es la mía" (ver isSharingScreen) sin guardar un booleano
  // aparte que se pueda desincronizar.
  const [screenShare, setScreenShare] = useState<{ connectionId: string; stream: MediaStream } | null>(null)
  // Parte D: estado de cámara de cada participante REMOTO (default true
  // hasta que llegue su primer dato) -- señal explícita del servidor
  // (media-state), no inferida de si el MediaStream tiene un track (ver
  // comentario largo en CallScreen.tsx sobre por qué eso no alcanza).
  const [remoteCamOn, setRemoteCamOn] = useState<Map<string, boolean>>(new Map())
  const [connectionStatus, setConnectionStatus] = useState<ConnectionStatus>('connected')
  // Se incrementa en cada reconexión exitosa -- fuerza al efecto de diff de
  // video a re-suscribirse desde cero contra el cliente nuevo (ver abajo).
  const [reconnectTick, setReconnectTick] = useState(0)

  const sfuRef = useRef<SFUClient | null>(null)
  // connectionId de video ya suscrito o pedido (Parte B): fuente de verdad
  // para el efecto de diff de abajo, no para renderizar nada.
  const subscribedVideoRef = useRef<Set<string>>(new Set())
  // Se incrementa en cada ronda real (post-debounce) del efecto de diff de
  // video -- deja que un callback async de una ronda vieja detecte que ya
  // no es la más reciente y se abstenga de tocar subscribedVideoRef.
  const videoDiffGenerationRef = useRef(0)
  // Última calidad ('high'/'low') pedida para cada connectionId ya suscrito
  // (Parte C) -- evita mandar setTrackQuality de nuevo si no cambió.
  const videoQualityRef = useRef<Map<string, 'high' | 'low'>>(new Map())
  // Espejo en ref de bandwidthLevel: el efecto de diff de abajo lo lee dentro
  // de un setTimeout (closure), y solo se re-crea cuando cambian
  // visibleConnectionIds/videoPublishTick -- sin esto, una transición de
  // bandwidthLevel que ocurre ENTRE esos disparos usaría un valor viejo para
  // decidir la capa inicial de una suscripción nueva (igual se autocorrige
  // después en el efecto de calidad de más abajo, pero así arranca bien
  // desde el primer pedido, no un pedido de más para corregir enseguida).
  const bandwidthLevelRef = useRef<0 | 1 | 2>(0)
  useEffect(() => {
    bandwidthLevelRef.current = bandwidthLevel
  }, [bandwidthLevel])

  // Parte D (reconexión): refs-espejo del mismo tipo que bandwidthLevelRef
  // arriba -- attemptReconnect corre disparado por un evento de red en
  // cualquier momento, no como parte de un render, así que no puede confiar
  // en closures de un render específico para leer valores que cambian con
  // el tiempo (los setters de useState sí son siempre estables, esto es
  // solo para VALORES).
  const userIdRef = useRef<string | null>(null)
  const myConnectionIdRef = useRef<string | null>(null)
  const localStreamRef = useRef<MediaStream | null>(null)
  const camOnRef = useRef(true)
  const micOnRef = useRef(true)
  const reportSpeakingRef = useRef<(connectionId: string, speaking: boolean) => void>(() => {})
  // Un 'disconnected' inesperado solo dispara el loop de reconexión si ya
  // estábamos en una llamada establecida -- si la conexión se cae DURANTE
  // el join() inicial (handleSubmit todavía en vuelo), eso ya lo maneja el
  // try/catch de handleSubmit por su cuenta (muestra el error, el usuario
  // reintenta a mano desde el form); sin este guard, ambos flujos podrían
  // dispararse en paralelo y pisarse sfuRef.current entre sí.
  const screenRef = useRef<Screen>('loading')
  useEffect(() => {
    screenRef.current = screen
  }, [screen])
  useEffect(() => {
    localStreamRef.current = localStream
  }, [localStream])
  useEffect(() => {
    camOnRef.current = camOn
  }, [camOn])
  useEffect(() => {
    micOnRef.current = micOn
  }, [micOn])

  // Loop de reconexión (Parte D): backoff con techo, reauth antes de CADA
  // intento (no solo el primero -- el token de 120s puede haber vencido
  // hace rato, ver plan), reconstruye un SFUClient nuevo en vez de reparar
  // el viejo (sus Map/Set internos se van solos con el GC). `leavingRef`
  // aborta el loop si el usuario clickeó "Salir" mientras un intento seguía
  // en vuelo -- sin esto, un reintento que resuelve DESPUÉS de leave()
  // podría resucitar sfuRef.current con una sesión que el usuario ya cerró.
  const reconnectAttemptRef = useRef(0)
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const leavingRef = useRef(false)
  const attemptReconnectRef = useRef<() => void>(() => {})

  const buildCallbacks = useCallback((): SFUCallbacks => ({
    onParticipantJoined: (p) => {
      setParticipants((prev) => {
        if (prev.has(p.connectionId)) return prev
        const next = new Map(prev)
        next.set(p.connectionId, { nombre: p.nombre, stream: new MediaStream() })
        return next
      })
      setRemoteCamOn((prev) => new Map(prev).set(p.connectionId, p.camOn))
    },
    onParticipantLeft: (connectionId) => {
      setParticipants((prev) => {
        const next = new Map(prev)
        next.delete(connectionId)
        return next
      })
      setRemoteCamOn((prev) => {
        const next = new Map(prev)
        next.delete(connectionId)
        return next
      })
    },
    onRemoteTrack: (connectionId, kind, track) => {
      if (kind === 'screen') {
        // Pantalla compartida: track ADICIONAL, va a su propio estado, no
        // al mapa de `participants` (nunca reemplaza la cámara de esa
        // persona, ver plan).
        setScreenShare((prev) => {
          const stream = prev?.connectionId === connectionId ? prev.stream : new MediaStream()
          stream.addTrack(track)
          return { connectionId, stream }
        })
        return
      }
      // Solo llegan tracks de VIDEO acá desde Parte B -- el audio arma su
      // propio grafo de reproducción/medición dentro de sfu.ts (no depende
      // de qué tile está montado).
      setParticipants((prev) => {
        const next = new Map(prev)
        const existing = next.get(connectionId) ?? { nombre: '(participante)', stream: new MediaStream() }
        existing.stream.addTrack(track)
        next.set(connectionId, { ...existing })
        return next
      })
    },
    onTrackPublished: (connectionId, kind) => {
      if (kind === 'video') setVideoPublishTick((t) => t + 1)
      // Adelanta el cambio de layout apenas se sabe que alguien empezó a
      // compartir, sin esperar a que el track real llegue por onRemoteTrack
      // (que puede tardar un instante más) -- misma lógica que videoPublishTick.
      if (kind === 'screen') setScreenShare((prev) => prev ?? { connectionId, stream: new MediaStream() })
    },
    onAudioLevel: (connectionId, _level, speaking) => {
      reportSpeakingRef.current(connectionId, speaking)
    },
    onBandwidthDegraded: setBandwidthLevel,
    onMediaState: (connectionId, camOnValue) => {
      setRemoteCamOn((prev) => new Map(prev).set(connectionId, camOnValue))
    },
    onScreenShareStopped: (connectionId) => {
      setScreenShare((prev) => (prev?.connectionId === connectionId ? null : prev))
    },
    onStatus: (status) => {
      if (status === 'room-closed') {
        setScreen('closed')
      } else if (status === 'disconnected' && screenRef.current === 'call') {
        // Semana 4 (prueba con 16 participantes): el cliente muerto no puede
        // quedarse en sfuRef mientras se reconecta. Los efectos de video y
        // calidad lo seguían usando, y cada ronda mandaba un subscribe con el
        // connectionId que el Durable Object ya había borrado: los 40 errores
        // 409 no_sfu_session de esa prueba vinieron de los 5 participantes que
        // se reconectaron, a razón de uno por segundo. Con sfuRef en null los
        // efectos no hacen nada hasta que attemptReconnect instala el cliente
        // nuevo.
        sfuRef.current = null
        subscribedVideoRef.current.clear()
        videoQualityRef.current.clear()
        setConnectionStatus('reconnecting')
        attemptReconnectRef.current()
      }
    },
    onError: (err) => setError(err.message),
  }), [])

  // Un solo intento de reconexión en vuelo: el cliente NUEVO puede reportar
  // su propio 'disconnected' mientras todavía se está uniendo (red
  // inestable), y sin este guard eso lanzaba un segundo loop en paralelo.
  const reconnectInFlightRef = useRef(false)

  const attemptReconnect = useCallback(() => {
    if (leavingRef.current || reconnectInFlightRef.current) return
    const userId = userIdRef.current
    const stream = localStreamRef.current
    if (!roomId || !userId || !stream) return

    reconnectInFlightRef.current = true
    reconnectAttemptRef.current += 1
    const attempt = reconnectAttemptRef.current
    let pending: SFUClient | null = null

    reauthForRoom(roomId, userId)
      .then((registered) => {
        const client = new SFUClient({
          roomId: registered.roomId,
          userId: registered.userId,
          token: registered.token,
          callbacks: buildCallbacks(),
        })
        pending = client
        return client.join(stream).then(() => client)
      })
      .then((client) => {
        reconnectInFlightRef.current = false
        if (leavingRef.current) {
          client.leave()
          return
        }
        if (client.isDisconnected()) {
          // Se cayó mientras terminaba el join: no se instala un cliente
          // muerto (quedaría "conectado" sin serlo). Se reintenta.
          client.leave()
          reconnectTimerRef.current = setTimeout(() => attemptReconnectRef.current(), reconnectBackoffMs(attempt))
          return
        }
        subscribedVideoRef.current.clear()
        videoQualityRef.current.clear()
        sfuRef.current = client
        myConnectionIdRef.current = client.getConnectionId()
        reconnectAttemptRef.current = 0
        setMaxVisibleTiles(client.getMaxVisibleTiles())
        // join() siempre publica cámara/mic tal como estén en el stream --
        // si estaban apagados antes de perder la conexión, hay que
        // reaplicar eso acá (join() no sabe nada de ese estado).
        if (!camOnRef.current) client.setCameraEnabled(false).catch(() => {})
        if (!micOnRef.current) client.setMicEnabled(false).catch(() => {})
        // La pantalla compartida no sobrevive una reconexión
        // (getDisplayMedia pide gesto de usuario, no se puede re-adquirir
        // sola) -- si era la mía, la doy por terminada y aviso.
        setScreenShare((prev) => {
          if (prev && prev.connectionId === myConnectionIdRef.current) {
            setError('Se detuvo tu pantalla compartida por la reconexión -- volvé a compartirla si hace falta.')
            return null
          }
          return prev
        })
        setConnectionStatus('connected')
        setReconnectTick((t) => t + 1)
      })
      .catch((err: unknown) => {
        reconnectInFlightRef.current = false
        // Si el cliente nuevo alcanzó a crear WebSocket/PeerConnection antes
        // de fallar, se suelta acá para no dejar sesiones colgadas.
        pending?.leave()
        if (leavingRef.current) return
        const status = (err as { status?: number } | null)?.status
        if (status === 410) {
          // La sala se cerró mientras estábamos desconectados -- no tiene
          // sentido seguir reintentando para siempre.
          setScreen('closed')
          return
        }
        const delay = reconnectBackoffMs(attempt)
        reconnectTimerRef.current = setTimeout(() => attemptReconnectRef.current(), delay)
      })
  }, [roomId, buildCallbacks])

  useEffect(() => {
    attemptReconnectRef.current = attemptReconnect
  }, [attemptReconnect])

  const galleryParticipants = useMemo(
    () => [...participants.entries()].map(([connectionId, p]) => ({ connectionId, nombre: p.nombre })),
    [participants]
  )
  // Escalón 2 de degradación (Parte C): reduce cuántos cuadritos de video se
  // piden reusando el mismo mecanismo de paginación/cap de Parte B -- no
  // hace falta inventar una ruta de desuscripción aparte, usePagedGallery ya
  // recorta visibleConnectionIds y el efecto de diff de abajo desuscribe lo
  // que sobra solo. Al recuperarse, vuelve a maxVisibleTiles y se
  // re-suscribe lo que faltaba, también con el mecanismo ya existente.
  const effectiveMaxVisibleTiles = bandwidthLevel >= 2 ? Math.max(2, Math.ceil(maxVisibleTiles / 2)) : maxVisibleTiles
  const gallery = usePagedGallery(galleryParticipants, effectiveMaxVisibleTiles)
  useEffect(() => {
    reportSpeakingRef.current = gallery.reportSpeaking
  }, [gallery.reportSpeaking])

  const leave = useCallback(() => {
    leavingRef.current = true
    if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current)
    sfuRef.current?.leave()
    sfuRef.current = null
    localStream?.getTracks().forEach((t) => t.stop())
    screenShare?.stream.getTracks().forEach((t) => t.stop())
    setLocalStream(null)
    setParticipants(new Map())
    setScreenShare(null)
    setRemoteCamOn(new Map())
    setConnectionStatus('connected')
    subscribedVideoRef.current.clear()
    videoQualityRef.current.clear()
    reconnectAttemptRef.current = 0
    myConnectionIdRef.current = null
    setBandwidthLevel(0)
    setScreen('form')
    setStatus('idle')
    setMicOn(true)
    setCamOn(true)
    setHandRaised(false)
    setPermission('pending')
    leavingRef.current = false
  }, [localStream, screenShare])

  // Parte B: la suscripción de VIDEO sigue a la página/orden que calcula
  // usePagedGallery -- nunca más de maxVisibleTiles tracks de video
  // suscritos, sin importar cuántos participantes reales haya en la sala.
  // subscribedVideoRef se marca ANTES del await para no disparar dos
  // pedidos concurrentes por el mismo connectionId si el efecto vuelve a
  // correr mientras el primero sigue en vuelo; si resulta que la persona
  // todavía no había publicado video, se desmarca para poder reintentar
  // (dispara de nuevo con videoPublishTick).
  //
  // Batcheado a propósito: UN solo subscribe/unsubscribe por cambio de
  // página, no uno por participante -- la primera versión de esto llamaba
  // subscribeToParticipantVideo() en un for-loop, y a escala real (~15+
  // participantes reales, verificado con Playwright) esa ráfaga de
  // round-trips individuales contra el mismo Durable Object producía 500s
  // reales del lado del SFU.
  //
  // Debounce (250ms) + generación, los dos a propósito -- encontrados y
  // corregidos tras verificar con tráfico real (Playwright, 12 y 25
  // participantes) que "pasar de página rápido varias veces seguidas"
  // rompía el cap: cada click disparaba su propia ronda de
  // subscribe/unsubscribe, y un callback ASYNC de una ronda VIEJA podía
  // resolver después de que una ronda MÁS NUEVA ya había reservado ese
  // mismo connectionId de nuevo -- el cleanup de la ronda vieja lo borraba
  // igual, dejando el conteo real desincronizado del backend (medido con
  // getStats().bytesReceived, no solo con conteo de transceivers: los
  // transceivers de un `force:true` unsubscribe se quedan "recvonly"/"live"
  // para siempre aunque el SFU ya cortó el flujo real, así que solo bytes
  // creciendo de verdad prueba una suscripción activa). El debounce hace
  // que un usuario clickeando rápido no dispare ninguna llamada de red
  // hasta que se queda quieto 250ms -- irrelevante frente al "sube en pocos
  // segundos" que pide el active speaker. La generación es una segunda capa
  // de seguridad para el caso en que una llamada lenta siga en vuelo cuando
  // ya arrancó una ronda más nueva: el cleanup de una ronda vieja nunca
  // pisa el estado que ya estableció una más nueva.
  useEffect(() => {
    const client = sfuRef.current
    if (!client) return

    const timeoutId = setTimeout(() => {
      const myGeneration = ++videoDiffGenerationRef.current
      const wanted = new Set(gallery.visibleConnectionIds)
      const subscribed = subscribedVideoRef.current

      const toUnsubscribe = [...subscribed].filter((id) => !wanted.has(id))
      for (const id of toUnsubscribe) {
        subscribed.delete(id)
        videoQualityRef.current.delete(id) // Parte C: si vuelve a suscribirse, que decida calidad de cero
      }
      if (toUnsubscribe.length > 0) {
        client.unsubscribeFromParticipantVideos(toUnsubscribe).catch(() => {})
      }

      const toSubscribe = [...wanted].filter((id) => !subscribed.has(id))
      for (const id of toSubscribe) subscribed.add(id)
      if (toSubscribe.length > 0) {
        // Parte C: durante degradación (nivel >=1) nadie arranca en capa
        // alta, ni siquiera quien está hablando -- se autocorrige a 'high' en
        // cuanto la conexión se recupera (ver efecto de calidad más abajo).
        const featured = bandwidthLevelRef.current >= 1 ? new Set<string>() : gallery.featuredIds
        for (const id of toSubscribe) videoQualityRef.current.set(id, featured.has(id) ? 'high' : 'low')
        client
          .subscribeToParticipantVideos(toSubscribe, featured)
          .then((didSubscribe) => {
            if (videoDiffGenerationRef.current !== myGeneration) return // una ronda más nueva ya reescribió el estado
            for (const id of toSubscribe) {
              if (!didSubscribe.has(id)) {
                subscribed.delete(id)
                videoQualityRef.current.delete(id)
              }
            }
          })
          .catch(() => {
            if (videoDiffGenerationRef.current !== myGeneration) return
            for (const id of toSubscribe) {
              subscribed.delete(id)
              videoQualityRef.current.delete(id)
            }
          })
      }
    }, 250)

    return () => clearTimeout(timeoutId)
    // reconnectTick (Parte D): tras una reconexión exitosa, subscribedVideoRef
    // ya se limpió (ver attemptReconnect) contra un pc/cliente nuevo -- hace
    // falta que este efecto vuelva a correr para re-suscribirse desde cero,
    // aunque gallery.visibleConnectionIds no haya cambiado.
  }, [gallery.visibleConnectionIds, videoPublishTick, reconnectTick])

  // Parte C: quién pide capa alta puede cambiar SIN que cambie la página
  // visible (alguien empieza/deja de hablar mientras se queda en pantalla) --
  // efecto aparte del de arriba, sin debounce (edge-triggered por
  // reportSpeaking + el tick de 1s de usePagedGallery, no por clicks rápidos
  // de navegación, así que no hace falta protegerlo de una ráfaga de la
  // misma forma). Solo toca a quien YA está suscrito -- alguien recién
  // agregado a `toSubscribe` arriba ya pidió la capa correcta desde el
  // primer subscribe.
  useEffect(() => {
    const client = sfuRef.current
    if (!client) return
    const featured = bandwidthLevel >= 1 ? new Set<string>() : gallery.featuredIds
    for (const id of subscribedVideoRef.current) {
      const desired: 'high' | 'low' = featured.has(id) ? 'high' : 'low'
      if (videoQualityRef.current.get(id) === desired) continue
      videoQualityRef.current.set(id, desired)
      client.setTrackQuality(id, desired).catch(() => {})
    }
  }, [gallery.featuredIds, bandwidthLevel])

  // Best-effort: si cierran/recargan la pestaña, avisamos al server. El
  // cierre del WebSocket (aunque no llegue este mensaje) ya dispara la
  // limpieza del lado del Durable Object (webSocketClose), con delay.
  useEffect(() => {
    const onUnload = () => sfuRef.current?.leave()
    window.addEventListener('beforeunload', onUnload)
    return () => window.removeEventListener('beforeunload', onUnload)
  }, [])

  // Pre-chequeo de la sala: es un GET idempotente sin efectos de lado, así
  // que no importa si StrictMode lo dispara dos veces en dev (a diferencia
  // de abrir el WebSocket de señalización — eso sí crea estado real en el
  // servidor, por eso vive en handleSubmit, disparado por una acción real
  // del usuario, nunca acá).
  useEffect(() => {
    if (!roomId) return
    let cancelled = false
    fetchRoom(roomId)
      .then((info) => {
        if (cancelled) return
        if (!info) {
          setScreen('not-found')
        } else if (info.estado === 'cerrada') {
          setRoomInfo(info)
          setScreen('closed')
        } else {
          setRoomInfo(info)
          setScreen('form')
        }
      })
      .catch(() => {
        if (!cancelled) setError('No se pudo consultar la sala')
      })
    return () => {
      cancelled = true
    }
  }, [roomId])

  // Preview de cámara antes de entrar (tarea 4): pedimos el stream apenas se
  // muestra la pantalla de registro, no en el submit. Si ya hay un
  // localStream (p.ej. volvimos acá después de un leave() que lo limpió, o
  // el segundo pase de StrictMode en dev) no lo volvemos a pedir. Si el
  // efecto se reinicia/desmonta antes de que resuelva la promesa, soltamos
  // el stream que haya llegado tarde para no dejar la cámara prendida.
  useEffect(() => {
    if (screen !== 'form' || localStream) return
    let cancelled = false
    setPermission('pending')
    navigator.mediaDevices
      // Sin un ideal de resolución, Chrome negocia un default conservador
      // (típicamente 640x480) sin importar de lo que la cámara sea capaz --
      // y el tile del speaker en este diseño es mucho más grande que los
      // recuadros fijos de antes, así que esa resolución baja se nota mucho
      // más (video estirado y pixelado). Pedimos 1280x720 como ideal; si la
      // cámara no da para tanto, el navegador cae a lo que sí pueda dar.
      .getUserMedia({ audio: true, video: { width: { ideal: 1280 }, height: { ideal: 720 } } })
      .then((stream) => {
        if (cancelled) {
          stream.getTracks().forEach((t) => t.stop())
          return
        }
        setLocalStream(stream)
        setPermission('granted')
      })
      .catch((err: unknown) => {
        if (cancelled) return
        const name = err instanceof DOMException ? err.name : ''
        setPermission(name === 'NotFoundError' || name === 'DevicesNotFoundError' ? 'no-device' : 'denied')
      })
    return () => {
      cancelled = true
    }
  }, [screen, localStream])

  // Cronómetro de "en vivo" (tarea 6): arranca al entrar a la sala.
  useEffect(() => {
    if (screen !== 'call') {
      setElapsedSeconds(0)
      return
    }
    const start = Date.now()
    const id = setInterval(() => setElapsedSeconds(Math.floor((Date.now() - start) / 1000)), 1000)
    return () => clearInterval(id)
  }, [screen])

  // Parte D: apagar/prender de verdad (replaceTrack + stop del hardware),
  // no track.enabled=false -- eso seguía mandando RTP de silencio/frames
  // negros, costando ancho de banda/egress igual aunque no se escuchara ni
  // se viera nada (ver plan). Al apagar, soltamos el track real (libera la
  // luz de la cámara/indicador del SO); al prender, pedimos uno fresco --
  // el permiso ya está concedido, así que no hay prompt nuevo.
  async function toggleMic() {
    const client = sfuRef.current
    if (micOn) {
      const track = localStream?.getAudioTracks()[0]
      if (track) {
        localStream?.removeTrack(track)
        track.stop()
      }
      setMicOn(false)
      await client?.setMicEnabled(false)
      return
    }
    try {
      const fresh = await navigator.mediaDevices.getUserMedia({ audio: true })
      const track = fresh.getAudioTracks()[0]
      localStream?.addTrack(track)
      setMicOn(true)
      await client?.setMicEnabled(true, track)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  async function toggleCam() {
    const client = sfuRef.current
    if (camOn) {
      const track = localStream?.getVideoTracks()[0]
      if (track) {
        localStream?.removeTrack(track)
        track.stop()
      }
      setCamOn(false)
      await client?.setCameraEnabled(false)
      return
    }
    try {
      const fresh = await navigator.mediaDevices.getUserMedia({ video: { width: { ideal: 1280 }, height: { ideal: 720 } } })
      const track = fresh.getVideoTracks()[0]
      localStream?.addTrack(track)
      setCamOn(true)
      await client?.setCameraEnabled(true, track)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  function toggleHand() {
    // Solo visual, sin señalización -- así está descrito en el diseño (no es
    // una feature de backend pendiente, es el alcance real de "levantar la
    // mano" en esta versión).
    setHandRaised((v) => !v)
  }

  // Parte D: pantalla compartida -- track ADICIONAL (no reemplaza la
  // cámara, sigue publicándose sola). isSharingScreen se deriva de
  // screenShare en vez de guardar un booleano aparte que se pueda
  // desincronizar.
  const isSharingScreen = screenShare !== null && screenShare.connectionId === myConnectionIdRef.current

  async function startScreenShare() {
    const client = sfuRef.current
    const myId = myConnectionIdRef.current
    if (!client || !myId || screenShare) return
    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({ video: true })
      const track = stream.getVideoTracks()[0]
      await client.startScreenShare(stream)
      setScreenShare({ connectionId: myId, stream })
      // El usuario puede parar de compartir desde el control nativo del
      // navegador (la barra "dejar de compartir" de Chrome), no solo desde
      // nuestro botón -- hay que escuchar eso también.
      track.addEventListener('ended', () => {
        stopScreenShare()
      })
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  async function stopScreenShare() {
    const client = sfuRef.current
    const current = screenShare
    if (!client || !current || current.connectionId !== myConnectionIdRef.current) return
    setScreenShare(null)
    current.stream.getTracks().forEach((t) => t.stop())
    await client.stopScreenShare().catch(() => {})
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!roomId) return

    const nextFieldErrors: { nombre?: string; correo?: string } = {}
    if (!nombre.trim()) nextFieldErrors.nombre = 'Escribí un nombre'
    if (!EMAIL_RE.test(correo.trim())) nextFieldErrors.correo = 'Escribí un correo válido'
    setFieldErrors(nextFieldErrors)
    if (nextFieldErrors.nombre || nextFieldErrors.correo) return

    setError(null)
    setJoining(true)
    let client: SFUClient | null = null
    try {
      if (!localStream) throw new Error('No pudimos acceder a tu cámara o micrófono')

      const registered = await registerForRoom(roomId, { nombre: nombre.trim(), correo: correo.trim(), rol })
      userIdRef.current = registered.userId

      client = new SFUClient({
        roomId: registered.roomId,
        userId: registered.userId,
        token: registered.token,
        callbacks: buildCallbacks(),
      })
      sfuRef.current = client

      await client.join(localStream)
      myConnectionIdRef.current = client.getConnectionId()
      setMaxVisibleTiles(client.getMaxVisibleTiles())
      setNombre(registered.nombre)
      setScreen('call')
    } catch (err) {
      // Semana 4 (prueba con 16): si join() falla a mitad de camino (en la
      // prueba, un 502 al crear la sesión SFU por una caída de red hacia
      // Cloudflare), el WebSocket ya estaba abierto y el resto de la sala veía
      // a esta persona como un participante fantasma sin medios. Se suelta el
      // cliente y lo que alcanzó a cargar; la vista previa de cámara queda
      // intacta para reintentar.
      if (client) {
        client.leave()
        if (sfuRef.current === client) sfuRef.current = null
        setParticipants(new Map())
        setRemoteCamOn(new Map())
        setScreenShare(null)
        subscribedVideoRef.current.clear()
        videoQualityRef.current.clear()
      }
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setJoining(false)
    }
  }

  if (!roomId) {
    return <StatusScreen title="meets" body="Abrí el link que te compartieron para entrar a una sala." />
  }

  if (screen === 'loading') {
    return <StatusScreen title="Cargando…" body="" />
  }

  if (screen === 'not-found') {
    return (
      <StatusScreen
        title="Sala no encontrada"
        body="Este link no corresponde a ninguna sala. Pedile al organizador que te comparta uno nuevo."
      />
    )
  }

  if (screen === 'closed') {
    return (
      <StatusScreen
        title="Sala cerrada"
        body={`"${roomInfo?.nombre}" ya terminó. Pedile al organizador que te comparta el link de una sala activa.`}
      />
    )
  }

  if (screen === 'form') {
    return (
      <PreJoinScreen
        roomInfo={roomInfo}
        nombre={nombre}
        correo={correo}
        rol={rol}
        onNombreChange={setNombre}
        onCorreoChange={setCorreo}
        onRolChange={setRol}
        fieldErrors={fieldErrors}
        error={error}
        joining={joining}
        onSubmit={handleSubmit}
        localStream={localStream}
        permission={permission}
        micOn={micOn}
        camOn={camOn}
        onToggleMic={toggleMic}
        onToggleCam={toggleCam}
      />
    )
  }

  return (
    <CallScreen
      roomInfo={roomInfo}
      nombre={nombre}
      localStream={localStream}
      participants={participants}
      visibleConnectionIds={gallery.visibleConnectionIds}
      speakingIds={gallery.speakingIds}
      currentPage={gallery.currentPage}
      totalPages={gallery.totalPages}
      totalParticipants={gallery.totalParticipants}
      onPrevPage={gallery.prevPage}
      onNextPage={gallery.nextPage}
      elapsedSeconds={elapsedSeconds}
      micOn={micOn}
      camOn={camOn}
      handRaised={handRaised}
      onToggleMic={toggleMic}
      onToggleCam={toggleCam}
      onToggleHand={toggleHand}
      onLeave={leave}
      remoteCamOn={remoteCamOn}
      screenShare={screenShare}
      isSharingScreen={isSharingScreen}
      onStartScreenShare={startScreenShare}
      onStopScreenShare={stopScreenShare}
      connectionStatus={connectionStatus}
    />
  )
}
