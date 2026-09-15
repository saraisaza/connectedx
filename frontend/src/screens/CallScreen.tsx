import { useMemo, useState, type CSSProperties } from 'react'
import type { GroupRoom, RoomInfo } from '../api'
import type { RoomDescriptor } from '../sfu'
import { ControlButton } from '../components/ControlButton'
import { GridPagination } from '../components/GridPagination'
import { LiveBadge } from '../components/LiveBadge'
import { Logo } from '../components/Logo'
import { SubsalasPanel } from '../components/SubsalasPanel'
import { getInitials, VideoTile } from '../components/VideoTile'
import { alpha, colors, fonts, radii, spacing } from '../theme'

export interface RemoteParticipant {
  nombre: string
  stream: MediaStream
}

export interface CallScreenProps {
  roomInfo: RoomInfo | null
  nombre: string
  localStream: MediaStream | null
  participants: Map<string, RemoteParticipant>
  // Parte B: ya viene paginado/ordenado por usePagedGallery -- CallScreen
  // solo dibuja, no decide quién se ve.
  visibleConnectionIds: string[]
  speakingIds: Set<string>
  currentPage: number
  totalPages: number
  totalParticipants: number
  onPrevPage: () => void
  onNextPage: () => void
  elapsedSeconds: number
  micOn: boolean
  camOn: boolean
  handRaised: boolean
  onToggleMic: () => void
  onToggleCam: () => void
  onToggleHand: () => void
  onLeave: () => void
  // Parte D: estado de cámara de cada REMOTO, señal explícita del servidor
  // (no inferida de si el MediaStream tiene un track -- ver comentario en
  // hasLiveVideo más abajo). Ausente en el mapa = todavía no se sabe, se
  // asume prendida (más común, evita un flash de "apagada" al conectar).
  remoteCamOn: Map<string, boolean>
  screenShare: { connectionId: string; stream: MediaStream } | null
  isSharingScreen: boolean
  onStartScreenShare: () => void
  onStopScreenShare: () => void
  connectionStatus: 'connected' | 'reconnecting'
  // Semana 4 (subsalas)
  groupRoomId: string
  currentRoom: RoomDescriptor | null
  groupRooms: GroupRoom[]
  subsalasMax: number
  isHost: boolean
  subsalasOpen: boolean
  onToggleSubsalas: () => void
  onEnterRoom: (roomId: string) => void
  onCreateSubsalas: (cantidad: number) => void
  onCloseRoom: (roomId: string) => void
  onEndMeeting: () => void
  moving: { nombre: string } | null
  notice: string | null
  hostActionPending: boolean
}

function formatElapsed(totalSeconds: number): string {
  const m = Math.floor(totalSeconds / 60)
  const s = totalSeconds % 60
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
}

// Solo para el video PROPIO (localStream): ahí sí es correcto mirar
// directamente si el stream tiene un track de video, porque somos
// nosotros mismos quienes lo agregamos/quitamos (ver App.tsx toggleCam).
// Para tiles REMOTOS no alcanza -- un track remoto nunca desaparece del
// MediaStream solo aunque el emisor deje de mandar frames (replaceTrack del
// otro lado), por eso esos usan remoteCamOn (señal explícita del server)
// en vez de esta función.
function hasLiveVideo(stream: MediaStream | null): boolean {
  return !!stream && stream.getVideoTracks().length > 0
}

// Heurística simple para un grid cuasi-cuadrado sin huecos raros ni tiles
// deformados: 1→1, 2→2, 3-4→2, 5-6→3, 7-9→3, 10→4 columnas.
function gridColumns(count: number): number {
  return Math.max(1, Math.ceil(Math.sqrt(count)))
}

function HandBadge() {
  return (
    <span style={{ font: `500 10px ${fonts.mono}`, letterSpacing: '.14em', textTransform: 'uppercase', color: colors.yellow }}>
      Mano &uarr;
    </span>
  )
}

// Píldora flotante sobre el grid (reconexión, avisos).
const bannerStyle: CSSProperties = {
  position: 'absolute',
  top: spacing.md,
  left: '50%',
  transform: 'translateX(-50%)',
  zIndex: 10,
  display: 'flex',
  alignItems: 'center',
  gap: spacing.sm,
  maxWidth: 'calc(100% - 48px)',
  padding: '10px 20px',
  borderRadius: radii.pill,
  background: colors.surfaceRaised,
  font: `500 12px ${fonts.mono}`,
  letterSpacing: '.08em',
  textTransform: 'uppercase',
  textAlign: 'center',
}

export function CallScreen(props: CallScreenProps) {
  const {
    roomInfo,
    nombre,
    localStream,
    participants,
    visibleConnectionIds,
    speakingIds,
    currentPage,
    totalPages,
    totalParticipants,
    onPrevPage,
    onNextPage,
    elapsedSeconds,
    micOn,
    camOn,
    handRaised,
    onToggleMic,
    onToggleCam,
    onToggleHand,
    onLeave,
    remoteCamOn,
    screenShare,
    isSharingScreen,
    onStartScreenShare,
    onStopScreenShare,
    connectionStatus,
    groupRoomId,
    currentRoom,
    groupRooms,
    subsalasMax,
    isHost,
    subsalasOpen,
    onToggleSubsalas,
    onEnterRoom,
    onCreateSubsalas,
    onCloseRoom,
    onEndMeeting,
    moving,
    notice,
    hostActionPending,
  } = props
  const [copied, setCopied] = useState(false)
  const sharerNombre = screenShare
    ? isSharingScreen
      ? 'Vos'
      : (participants.get(screenShare.connectionId)?.nombre ?? '(alguien)')
    : ''

  const columns = useMemo(() => gridColumns(visibleConnectionIds.length || 1), [visibleConnectionIds.length])
  const subsalasCount = groupRooms.filter((r) => r.tipo === 'subsala').length
  const enSubsala = currentRoom?.tipo === 'subsala'
  const busy = moving !== null || connectionStatus === 'reconnecting'

  async function handleInvite() {
    try {
      await navigator.clipboard.writeText(window.location.href)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      // Portapapeles no disponible (permiso/navegador) -- no es crítico, el
      // link sigue visible en la barra del navegador.
    }
  }

  return (
    <div style={{ width: '100%', height: '100vh', display: 'flex', flexDirection: 'column', background: colors.surface, fontFamily: fonts.body, color: colors.textPrimary }}>
      <div
        style={{
          height: 78,
          flex: 'none',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: spacing.xxl,
          padding: `0 ${spacing.xhuge}px`,
          background: colors.surfaceRaised,
          borderBottom: `1px solid ${colors.border}`,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: spacing.xxl, minWidth: 0 }}>
          <Logo height={44} />
          <div style={{ width: 1, height: 26, background: '#2C2C33' }} />
          <div style={{ fontSize: 15, fontWeight: 500, color: colors.textPrimary, whiteSpace: 'nowrap' }}>{roomInfo?.nombre ?? ''}</div>
          {enSubsala && currentRoom && (
            <span
              style={{
                font: `500 11px ${fonts.mono}`,
                letterSpacing: '.14em',
                textTransform: 'uppercase',
                color: colors.ink,
                background: colors.yellow,
                borderRadius: radii.pill,
                padding: '6px 12px',
                whiteSpace: 'nowrap',
              }}
            >
              {currentRoom.nombre}
            </span>
          )}
          <LiveBadge variant="live" label={`En vivo ${formatElapsed(elapsedSeconds)}`} />
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: spacing.lg }}>
          {enSubsala && (
            <ControlButton
              variant="primary"
              label="Volver a la principal"
              height={40}
              paddingX={16}
              disabled={busy}
              onClick={() => onEnterRoom(groupRoomId)}
            />
          )}
          {(isHost || subsalasCount > 0) && (
            <ControlButton
              variant="ghost"
              label={subsalasCount > 0 ? `Subsalas (${subsalasCount})` : 'Subsalas'}
              height={40}
              paddingX={16}
              onClick={onToggleSubsalas}
            />
          )}
          <GridPagination
            currentPage={currentPage}
            totalPages={totalPages}
            totalParticipants={totalParticipants + 1}
            onPrev={onPrevPage}
            onNext={onNextPage}
          />
          <ControlButton variant="ghost" label={copied ? 'Copiado' : 'Invitar'} height={40} paddingX={16} onClick={handleInvite} />
        </div>
      </div>

      <div
        style={{
          position: 'relative',
          flex: 1,
          minHeight: 0,
          padding: `${spacing.huge}px ${spacing.xhuge}px`,
          backgroundColor: colors.surface,
          backgroundImage: 'repeating-linear-gradient(115deg, rgba(255,194,32,.04) 0 2px, transparent 2px 18px)',
        }}
      >
        {connectionStatus === 'reconnecting' ? (
          <div role="status" style={{ ...bannerStyle, border: `1px solid ${colors.yellow}`, color: colors.yellow }}>
            Reconectando…
          </div>
        ) : (
          notice && (
            <div role="status" style={{ ...bannerStyle, border: `1px solid ${colors.borderSoft}`, color: colors.textBody }}>
              {notice}
            </div>
          )
        )}

        {screenShare ? (
          // Parte D: alguien está compartiendo pantalla -- esa pantalla pasa
          // a vista destacada para todos, y los cuadritos de cámara se
          // reducen a una tira chica en vez del grid normal. Mismo array
          // `visibleConnectionIds` de siempre (usePagedGallery no cambia en
          // absoluto para esto), solo el layout que lo envuelve.
          <div style={{ display: 'flex', flexDirection: 'column', height: '100%', gap: spacing.mdl }}>
            <div style={{ flex: 1, minHeight: 0 }}>
              <VideoTile
                variant="spotlight"
                fit="contain"
                cameraState="video"
                stream={screenShare.stream}
                initials={getInitials(sharerNombre)}
                bottomLeft={
                  <span style={{ fontSize: 13, fontWeight: 500, color: colors.textBody }}>
                    {sharerNombre} está compartiendo pantalla
                  </span>
                }
              />
            </div>
            {visibleConnectionIds.length > 0 && (
              <div style={{ display: 'flex', gap: spacing.mdl, flex: 'none', height: 130, overflowX: 'auto' }}>
                {visibleConnectionIds.map((connectionId) => {
                  const p = participants.get(connectionId)
                  if (!p) return null
                  return (
                    <div key={connectionId} style={{ width: 180, flex: 'none' }}>
                      <VideoTile
                        variant="sidebar"
                        cameraState={(remoteCamOn.get(connectionId) ?? true) ? 'video' : 'off'}
                        stream={p.stream}
                        initials={getInitials(p.nombre)}
                        speaking={speakingIds.has(connectionId)}
                        bottomLeft={<span style={{ fontSize: 12, fontWeight: 500, color: colors.textBody }}>{p.nombre}</span>}
                      />
                    </div>
                  )
                })}
              </div>
            )}
          </div>
        ) : visibleConnectionIds.length > 0 ? (
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: `repeat(${columns}, 1fr)`,
              gap: spacing.mdl,
              alignContent: 'start',
            }}
          >
            {visibleConnectionIds.map((connectionId) => {
              const p = participants.get(connectionId)
              if (!p) return null
              return (
                <VideoTile
                  key={connectionId}
                  variant="sidebar"
                  cameraState={(remoteCamOn.get(connectionId) ?? true) ? 'video' : 'off'}
                  stream={p.stream}
                  initials={getInitials(p.nombre)}
                  speaking={speakingIds.has(connectionId)}
                  bottomLeft={<span style={{ fontSize: 13, fontWeight: 500, color: colors.textBody }}>{p.nombre}</span>}
                />
              )
            })}
          </div>
        ) : (
          <div
            style={{
              height: '100%',
              minHeight: 200,
              borderRadius: radii.sm,
              border: `1px dashed ${colors.borderInput}`,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              font: `500 11px ${fonts.mono}`,
              letterSpacing: '.16em',
              textTransform: 'uppercase',
              color: colors.textFaint,
            }}
          >
            {enSubsala ? 'Todavía no hay nadie más en esta subsala' : 'Esperando a que se unan más personas'}
          </div>
        )}

        {/* Video propio: fijo, fuera de la paginación -- nunca pasa por el
            SFU como suscripción, así que no compite por ninguno de los
            cupos del grid. */}
        <div style={{ position: 'absolute', right: spacing.xxl, bottom: spacing.xxl, width: 200, zIndex: 5 }}>
          <VideoTile
            variant="sidebar"
            cameraState={camOn && hasLiveVideo(localStream) ? 'video' : 'off'}
            stream={localStream}
            muted
            initials={getInitials(nombre)}
            topRightBadge={handRaised ? <HandBadge /> : undefined}
            bottomLeft={<span style={{ fontSize: 13, fontWeight: 500, color: colors.textBody }}>Tú</span>}
          />
        </div>

        {subsalasOpen && (
          <SubsalasPanel
            rooms={groupRooms}
            currentRoomId={currentRoom?.id ?? null}
            isHost={isHost}
            max={subsalasMax}
            busy={busy}
            hostActionPending={hostActionPending}
            onEnter={onEnterRoom}
            onCreate={onCreateSubsalas}
            onClose={onCloseRoom}
            onEndMeeting={onEndMeeting}
            onDismiss={onToggleSubsalas}
          />
        )}

        {/* Semana 4: mientras dura el cambio de sala, el grid de la sala
            anterior queda atenuado debajo de este aviso. */}
        {moving && (
          <div
            role="status"
            aria-live="polite"
            style={{
              position: 'absolute',
              inset: 0,
              zIndex: 30,
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'center',
              gap: spacing.md,
              background: alpha.overlayBg,
            }}
          >
            <span style={{ font: `500 11px ${fonts.mono}`, letterSpacing: '.18em', textTransform: 'uppercase', color: colors.yellow }}>
              Cambiando de sala
            </span>
            <span style={{ font: `400 40px ${fonts.display}`, textTransform: 'uppercase', color: colors.textHeading, textAlign: 'center' }}>
              Entrando a {moving.nombre}…
            </span>
          </div>
        )}
      </div>

      <div
        style={{
          height: 96,
          flex: 'none',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          gap: spacing.md,
          background: colors.surfaceRaised,
          borderTop: `1px solid ${colors.border}`,
        }}
      >
        <ControlButton variant="toggle" active={micOn} indicator="circle" height={50} paddingX={22} label={micOn ? 'Mic activo' : 'Silenciado'} onClick={onToggleMic} />
        <ControlButton variant="toggle" active={camOn} indicator="square" height={50} paddingX={22} label={camOn ? 'Cámara' : 'Cámara off'} onClick={onToggleCam} />
        <ControlButton
          variant="toggle"
          active={isSharingScreen}
          height={50}
          paddingX={22}
          label={isSharingScreen ? 'Compartiendo' : 'Compartir'}
          onClick={isSharingScreen ? onStopScreenShare : onStartScreenShare}
          disabled={(!isSharingScreen && screenShare !== null) || moving !== null}
          title={!isSharingScreen && screenShare !== null ? `${sharerNombre} ya está compartiendo pantalla` : undefined}
        />
        <ControlButton variant="toggle" active={handRaised} height={50} paddingX={22} label="Mano" onClick={onToggleHand} />
        <ControlButton variant="ghost" height={50} paddingX={22} label="Chat" disabled title="Próximamente" />
        <div style={{ width: 1, height: 34, background: colors.borderControl, margin: '0 8px' }} />
        <ControlButton variant="danger" height={50} paddingX={24} label="Salir" onClick={onLeave} />
      </div>
    </div>
  )
}
