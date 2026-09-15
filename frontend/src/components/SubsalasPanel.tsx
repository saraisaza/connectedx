import { useState, type CSSProperties } from 'react'
import type { GroupRoom } from '../api'
import { ControlButton } from './ControlButton'
import { alpha, colors, fonts, radii, spacing } from '../theme'

// Semana 4: panel de subsalas dentro de la llamada. Cualquier participante ve
// las salas abiertas de la reunión y entra a la que quiera (o vuelve a la
// principal). Si hay una llave de host válida, además crea y cierra subsalas
// y puede terminar la reunión para todos.
export interface SubsalasPanelProps {
  rooms: GroupRoom[]
  currentRoomId: string | null
  isHost: boolean
  max: number
  // Mientras hay un cambio de sala o una reconexión en curso no se puede
  // pedir otro movimiento.
  busy: boolean
  hostActionPending: boolean
  onEnter: (roomId: string) => void
  onCreate: (cantidad: number) => void
  onClose: (roomId: string) => void
  onEndMeeting: () => void
  onDismiss: () => void
}

const labelStyle: CSSProperties = {
  font: `500 11px ${fonts.mono}`,
  letterSpacing: '.16em',
  textTransform: 'uppercase',
  color: colors.textDim,
}

function personasLabel(n: number): string {
  return n === 1 ? '1 persona' : `${n} personas`
}

export function SubsalasPanel({
  rooms,
  currentRoomId,
  isHost,
  max,
  busy,
  hostActionPending,
  onEnter,
  onCreate,
  onClose,
  onEndMeeting,
  onDismiss,
}: SubsalasPanelProps) {
  const subsalas = rooms.filter((r) => r.tipo === 'subsala')
  const disponibles = Math.max(0, max - subsalas.length)
  const [cantidad, setCantidad] = useState(2)
  const [confirmEnd, setConfirmEnd] = useState(false)
  const cantidadValida = Math.min(Math.max(1, cantidad), Math.max(1, disponibles))

  return (
    <aside
      aria-label="Subsalas"
      style={{
        position: 'absolute',
        top: spacing.md,
        right: spacing.xxl,
        bottom: 160,
        width: 340,
        zIndex: 20,
        display: 'flex',
        flexDirection: 'column',
        gap: spacing.lg,
        padding: `${spacing.xl}px ${spacing.xl}px`,
        boxSizing: 'border-box',
        background: colors.surfacePanel,
        border: `1px solid ${colors.border}`,
        borderRadius: radii.lg,
        boxShadow: '0 24px 60px -30px rgba(0,0,0,.9)',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: spacing.md }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: spacing.xs }}>
          <span style={{ ...labelStyle, color: colors.yellow }}>Reunión</span>
          <span style={{ font: `400 30px ${fonts.display}`, lineHeight: 1, textTransform: 'uppercase', color: colors.textHeading }}>
            Subsalas
          </span>
        </div>
        <ControlButton variant="ghost" label="Cerrar panel" height={32} paddingX={12} onClick={onDismiss} />
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: spacing.sm, flex: 1, minHeight: 0, overflowY: 'auto' }}>
        {rooms.map((room) => {
          const isCurrent = room.id === currentRoomId
          const nombre = room.tipo === 'principal' ? 'Sala principal' : room.nombre
          return (
            <div
              key={room.id}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: spacing.smd,
                padding: `${spacing.smd}px ${spacing.md}px`,
                borderRadius: radii.sm,
                background: isCurrent ? alpha.badgeOpenBg : colors.surfaceTile,
                border: `1px solid ${isCurrent ? alpha.badgeOpenBorder : colors.borderSoft}`,
              }}
            >
              <div style={{ flex: 1, minWidth: 0 }}>
                <div
                  style={{
                    fontSize: 14,
                    fontWeight: 500,
                    color: colors.textPrimary,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {nombre}
                </div>
                <div style={{ font: `400 11px ${fonts.mono}`, color: colors.textMuted, marginTop: 2 }}>{personasLabel(room.personas)}</div>
              </div>
              {isCurrent ? (
                <span style={{ ...labelStyle, color: colors.yellow, whiteSpace: 'nowrap' }}>Estás acá</span>
              ) : (
                <ControlButton
                  variant="ghost"
                  label={room.tipo === 'principal' ? 'Volver' : 'Entrar'}
                  title={`Entrar a ${nombre}`}
                  height={34}
                  paddingX={14}
                  disabled={busy}
                  onClick={() => onEnter(room.id)}
                />
              )}
              {isHost && room.tipo === 'subsala' && (
                <ControlButton
                  variant="danger"
                  label="Cerrar"
                  title={`Cerrar ${nombre}`}
                  height={34}
                  paddingX={12}
                  disabled={hostActionPending}
                  onClick={() => onClose(room.id)}
                />
              )}
            </div>
          )
        })}
        {subsalas.length === 0 && (
          <div style={{ fontSize: 13, lineHeight: 1.5, color: colors.textMuted, padding: `${spacing.sm}px 0` }}>
            {isHost ? 'Todavía no creaste subsalas.' : 'Todavía no hay subsalas en esta reunión.'}
          </div>
        )}
      </div>

      {isHost && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: spacing.md, borderTop: `1px solid ${colors.border}`, paddingTop: spacing.lg }}>
          <label htmlFor="subsalas-cantidad" style={labelStyle}>
            Crear subsalas
          </label>
          <div style={{ display: 'flex', gap: spacing.sm }}>
            <input
              id="subsalas-cantidad"
              type="number"
              min={1}
              max={Math.max(1, disponibles)}
              value={cantidad}
              disabled={disponibles === 0 || hostActionPending}
              onChange={(e) => setCantidad(Math.floor(Number(e.target.value) || 1))}
              style={{
                width: 72,
                height: 38,
                boxSizing: 'border-box',
                padding: '0 12px',
                background: colors.surfaceInput,
                border: `1px solid ${colors.borderInput}`,
                borderRadius: radii.input,
                color: colors.textPrimary,
                font: `400 15px ${fonts.body}`,
                outline: 'none',
              }}
            />
            <ControlButton
              variant="primary"
              label="Crear"
              height={38}
              paddingX={18}
              disabled={disponibles === 0 || hostActionPending}
              onClick={() => onCreate(cantidadValida)}
            />
          </div>
          <span style={{ font: `400 11px ${fonts.mono}`, color: colors.textFaint }}>
            {subsalas.length} de {max} subsalas abiertas
          </span>
          <ControlButton
            variant="danger"
            label={confirmEnd ? 'Confirmar: terminar para todos' : 'Terminar reunión para todos'}
            height={40}
            paddingX={16}
            disabled={hostActionPending}
            onClick={() => (confirmEnd ? onEndMeeting() : setConfirmEnd(true))}
          />
        </div>
      )}
    </aside>
  )
}
