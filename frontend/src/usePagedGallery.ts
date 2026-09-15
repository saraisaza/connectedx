import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

// Parte B: quién se ve en el grid y en qué página, con active speaker
// reordenando la página 1 sin "bailar". Sin dependencias de WebRTC -- solo
// recibe la lista de participantes (orden de unión) y eventos de "está
// hablando" (la detección real, con histéresis, vive en sfu.ts).
//
// Algoritmo (ver plan): tier1 = hablando ahora, tier2 = "pegajoso" (recién
// destacado, protegido por MIN_STAY_MS aunque se calle), tier3 = el resto en
// orden estable de unión. Página 1 = primeros maxVisibleTiles de
// tier1+tier2+tier3. Páginas 2+ = el resto, también en orden estable -- se
// resuerdan solo cuando alguien entra o sale del destacado, nunca por dentro.

const MIN_STAY_MS = 8000
const MANUAL_NAV_GRACE_MS = 8000
const RECOMPUTE_TICK_MS = 1000

export interface GalleryParticipant {
  connectionId: string
  nombre: string
}

export interface UsePagedGalleryResult {
  visibleConnectionIds: string[]
  // tier1 (hablando) UNION tier2 (pegajoso, recién destacado) -- Parte C usa
  // esto para decidir quién pide la capa alta de simulcast. Deliberadamente
  // NO es todo el destacado de página 1: tier3 (el resto, orden estable) son
  // cuadritos igual de chicos que cualquier otro, así que piden capa baja
  // igual que si estuvieran en otra página.
  featuredIds: Set<string>
  speakingIds: Set<string>
  currentPage: number
  totalPages: number
  totalParticipants: number
  goToPage: (page: number) => void
  nextPage: () => void
  prevPage: () => void
  reportSpeaking: (connectionId: string, speaking: boolean) => void
}

export function usePagedGallery(participants: GalleryParticipant[], maxVisibleTiles: number): UsePagedGalleryResult {
  const [currentPage, setCurrentPage] = useState(1)
  const [tick, setTick] = useState(0)

  const speakingRef = useRef<Set<string>>(new Set())
  const lastActiveAtRef = useRef<Map<string, number>>(new Map())
  const stickyUntilRef = useRef<Map<string, number>>(new Map())
  const lastManualNavAtRef = useRef(0)
  const previousPrimarySpeakerRef = useRef<string | null>(null)

  // Edge-triggered: solo dispara un recálculo inmediato cuando "hablando"
  // realmente cambia de estado para alguien -- la histéresis que decide ESE
  // booleano vive en sfu.ts, acá solo se confía en el resultado.
  //
  // stickyUntil se otorga ACÁ, justo en la transición hablando->silencio --
  // no en un scan periódico de "quién está en destacado ahora mismo" (así
  // vivía antes, y era un bug real: ese scan otorgaba/renovaba stickyUntil a
  // CUALQUIERA en destacado que no estuviera hablando, sin chequear si
  // alguna vez había hablado -- un participante de tier3 (relleno, nunca
  // habló) que ocupara un cupo del destacado quedaba "pegajoso" para siempre
  // (cada vencimiento de sticky se renovaba solo en el próximo tick), o sea
  // quedaba con calidad alta de Parte C sin razón. Encontrado recién al
  // diseñar la medición de ancho de banda de Parte C -- invisible para el
  // test de anti-baile de Parte B porque ese test solo chequeaba ausencia de
  // baile, no a quién se le asignaba destacado/feature sin haber hablado.
  const reportSpeaking = useCallback((connectionId: string, speaking: boolean) => {
    const already = speakingRef.current.has(connectionId)
    if (speaking) lastActiveAtRef.current.set(connectionId, Date.now())
    if (speaking === already) return
    if (speaking) {
      speakingRef.current.add(connectionId)
    } else {
      speakingRef.current.delete(connectionId)
      stickyUntilRef.current.set(connectionId, Date.now() + MIN_STAY_MS)
    }
    setTick((t) => t + 1)
  }, [])

  // Tick de fondo: además de los eventos de arriba, hace falta recalcular
  // periódicamente para notar cuándo expira un stickyUntil (nadie "avisa"
  // ese momento por sí solo).
  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), RECOMPUTE_TICK_MS)
    return () => clearInterval(id)
  }, [])

  const participantIds = useMemo(() => participants.map((p) => p.connectionId), [participants])

  // OJO: este useMemo es deliberadamente de SOLO LECTURA sobre los refs --
  // no escribe stickyUntilRef/limpia mapas acá. Mutar refs adentro de un
  // useMemo es una trampa real bajo StrictMode: React invoca la función de
  // render (y lo que corre dentro, incluidos los useMemo) DOS VECES en dev
  // para detectar justo este tipo de impureza -- la segunda invocación vería
  // el resultado YA MUTADO de la primera y podía producir un `destacado` con
  // ids repetidos (lo reproduje en pruebas reales, intermitente, ~1 de cada
  // 5 corridas con 5 participantes). Las escrituras viven en el useEffect de
  // abajo, que corre una sola vez por commit real.
  const computed = useMemo(() => {
    const now = Date.now()
    const speaking = speakingRef.current
    const byRecency = (a: string, b: string) => (lastActiveAtRef.current.get(b) ?? 0) - (lastActiveAtRef.current.get(a) ?? 0)

    const tier1 = participantIds.filter((id) => speaking.has(id)).sort(byRecency)
    const tier2 = participantIds
      .filter((id) => !speaking.has(id) && (stickyUntilRef.current.get(id) ?? 0) > now)
      .sort(byRecency)
    const tier1And2 = new Set([...tier1, ...tier2])
    const tier3 = participantIds.filter((id) => !tier1And2.has(id))

    const destacado = [...tier1, ...tier2, ...tier3].slice(0, Math.max(1, maxVisibleTiles))
    const destacadoSet = new Set(destacado)
    const resto = participantIds.filter((id) => !destacadoSet.has(id))
    const totalPages = 1 + Math.ceil(resto.length / Math.max(1, maxVisibleTiles))

    return {
      destacado,
      destacadoSet,
      featuredIds: tier1And2,
      resto,
      totalPages,
      primarySpeakerId: tier1[0] ?? null,
      speakingIds: new Set(speaking),
    }
    // Recalcula ante: cambios de participantes, del cap, de página (para
    // saber qué slice de "resto" armar), o el tick (transición de hablando /
    // expiración de sticky). `tick` SÍ tiene que estar en las deps -- sin él,
    // este useMemo nunca vuelve a correr solo porque cambió speakingRef o
    // venció un stickyUntil (son refs, no disparan re-render ni invalidan la
    // memoización por sí solos). Bug real encontrado en Parte C: el estado
    // `tick` se descartaba con `[, setTick]`, así que aunque el comentario de
    // arriba ya decía "o el tick", nunca estuvo en este array -- el
    // recálculo periódico (vencimiento de sticky) y el edge-trigger de
    // reportSpeaking no volvían a evaluarse hasta que cambiaba algo más
    // (participantes/cap/página). No lo agarró el test de anti-baile porque
    // ese test nunca esperó más de MIN_STAY_MS sin un cambio de participantes
    // de por medio.
  }, [participantIds, maxVisibleTiles, currentPage, tick])

  // Limpieza después del commit -- idempotente, así que un segundo disparo
  // de StrictMode acá es inofensivo. El otorgamiento de stickyUntil vive en
  // reportSpeaking (arriba, edge-triggered); acá solo se poda lo vencido o
  // lo de gente que ya no está.
  useEffect(() => {
    const now = Date.now()
    for (const [id, until] of [...stickyUntilRef.current]) {
      if (until <= now) stickyUntilRef.current.delete(id)
    }
    const known = new Set(participantIds)
    for (const id of [...speakingRef.current]) if (!known.has(id)) speakingRef.current.delete(id)
    for (const id of [...lastActiveAtRef.current.keys()]) if (!known.has(id)) lastActiveAtRef.current.delete(id)
    for (const id of [...stickyUntilRef.current.keys()]) if (!known.has(id)) stickyUntilRef.current.delete(id)
  }, [computed, participantIds])

  // Corrige la página si dejó de existir (p.ej. la gente que quedaba en la
  // última página se fue).
  useEffect(() => {
    if (currentPage > computed.totalPages) setCurrentPage(computed.totalPages)
  }, [computed.totalPages, currentPage])

  // Salto automático al cambiar el speaker principal -- ver la tensión con
  // navegación manual resuelta en el plan: solo salta si pasaron
  // MANUAL_NAV_GRACE_MS desde el último click de navegación del usuario.
  useEffect(() => {
    const prev = previousPrimarySpeakerRef.current
    previousPrimarySpeakerRef.current = computed.primarySpeakerId
    if (!computed.primarySpeakerId || computed.primarySpeakerId === prev) return
    if (currentPage === 1) return
    if (Date.now() - lastManualNavAtRef.current < MANUAL_NAV_GRACE_MS) return
    setCurrentPage(1)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [computed.primarySpeakerId])

  const goToPage = useCallback((page: number) => {
    lastManualNavAtRef.current = Date.now()
    setCurrentPage(Math.max(1, page))
  }, [])
  const nextPage = useCallback(() => goToPage(currentPage + 1), [currentPage, goToPage])
  const prevPage = useCallback(() => goToPage(currentPage - 1), [currentPage, goToPage])

  // Referencia estable mientras el contenido no cambie. `computed` se
  // recalcula en cada tick de 1s (hace falta para vencer la pegajosidad),
  // así que antes esto devolvía un array nuevo por segundo aunque fueran los
  // mismos ids, y el efecto de suscripción de App.tsx (que depende de este
  // array) corría una vez por segundo. En la prueba de 16 participantes eso
  // convirtió cada reconexión en una ráfaga de 409 no_sfu_session.
  const pageSize = Math.max(1, maxVisibleTiles)
  const rawVisible =
    currentPage === 1
      ? computed.destacado
      : computed.resto.slice((currentPage - 2) * pageSize, (currentPage - 1) * pageSize)
  const visibleKey = rawVisible.join('|')
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const visibleConnectionIds = useMemo(() => rawVisible, [visibleKey])

  return {
    visibleConnectionIds,
    featuredIds: computed.featuredIds,
    speakingIds: computed.speakingIds,
    currentPage,
    totalPages: computed.totalPages,
    totalParticipants: participantIds.length,
    goToPage,
    nextPage,
    prevPage,
    reportSpeaking,
  }
}
