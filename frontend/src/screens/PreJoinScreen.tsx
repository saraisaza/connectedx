import { useEffect, useState, type FormEvent } from 'react'
import type { RoomInfo } from '../api'
import { ControlButton } from '../components/ControlButton'
import { LiveBadge } from '../components/LiveBadge'
import { Logo } from '../components/Logo'
import { getInitials, VideoTile, type CameraState } from '../components/VideoTile'
import { alpha, colors, fonts, radii, spacing } from '../theme'

export interface PreJoinScreenProps {
  roomInfo: RoomInfo | null
  nombre: string
  correo: string
  rol: 'participante' | 'admin'
  onNombreChange: (v: string) => void
  onCorreoChange: (v: string) => void
  onRolChange: (v: 'participante' | 'admin') => void
  fieldErrors: { nombre?: string; correo?: string }
  error: string | null
  joining: boolean
  onSubmit: (e: FormEvent) => void
  localStream: MediaStream | null
  permission: 'pending' | 'granted' | 'denied' | 'no-device'
  micOn: boolean
  camOn: boolean
  onToggleMic: () => void
  onToggleCam: () => void
}

function useClock(): string {
  const [now, setNow] = useState(() => new Date())
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 30_000)
    return () => clearInterval(id)
  }, [])
  return now.toLocaleTimeString('es-CO', { hour: '2-digit', minute: '2-digit' })
}

const inputLabelStyle = {
  font: `500 11px ${fonts.mono}`,
  letterSpacing: '.16em',
  textTransform: 'uppercase' as const,
  color: colors.textDim,
}

function FormField({
  label,
  value,
  onChange,
  placeholder,
  type,
  error,
  disabled,
}: {
  label: string
  value: string
  onChange: (v: string) => void
  placeholder: string
  type: 'text' | 'email'
  error?: string
  disabled: boolean
}) {
  const [focused, setFocused] = useState(false)
  const borderColor = error ? colors.danger : focused ? colors.yellow : colors.borderInput

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: spacing.sm }}>
      <label style={inputLabelStyle}>{label}</label>
      <input
        type={type}
        value={value}
        disabled={disabled}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        style={{
          width: '100%',
          height: 54,
          boxSizing: 'border-box',
          padding: '0 16px',
          background: colors.surfaceInput,
          border: `1px solid ${borderColor}`,
          borderRadius: radii.input,
          color: colors.textPrimary,
          font: `400 15px ${fonts.body}`,
          outline: 'none',
        }}
      />
      {error && <span style={{ font: `400 12px ${fonts.mono}`, color: colors.danger }}>{error}</span>}
    </div>
  )
}

function RoleSwitch({ rol, onRolChange, disabled }: { rol: 'participante' | 'admin'; onRolChange: (v: 'participante' | 'admin') => void; disabled: boolean }) {
  function segmentStyle(active: boolean) {
    return {
      flex: 1,
      height: 42,
      border: 'none',
      borderRadius: radii.xs,
      cursor: disabled ? 'not-allowed' : 'pointer',
      font: `500 12px ${fonts.mono}`,
      letterSpacing: '.1em',
      textTransform: 'uppercase' as const,
      background: active ? colors.yellow : 'transparent',
      color: active ? colors.ink : colors.textMuted,
    }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: spacing.sm }}>
      <label style={inputLabelStyle}>Entras como</label>
      <div style={{ display: 'flex', gap: spacing.sm, padding: 5, background: colors.surfaceInput, border: `1px solid ${colors.borderControl}`, borderRadius: radii.sm }}>
        <button type="button" disabled={disabled} onClick={() => onRolChange('participante')} style={segmentStyle(rol === 'participante')}>
          Participante
        </button>
        <button type="button" disabled={disabled} onClick={() => onRolChange('admin')} style={segmentStyle(rol === 'admin')}>
          Anfitrión
        </button>
      </div>
    </div>
  )
}

export function PreJoinScreen(props: PreJoinScreenProps) {
  const { roomInfo, nombre, correo, rol, onNombreChange, onCorreoChange, onRolChange, fieldErrors, error, joining, onSubmit, localStream, permission, micOn, camOn, onToggleMic, onToggleCam } = props
  const clock = useClock()
  const [conductAccepted, setConductAccepted] = useState(false)
  const [submitHover, setSubmitHover] = useState(false)

  let cameraState: CameraState
  if (permission === 'pending') cameraState = 'pending'
  else if (permission === 'denied') cameraState = 'denied'
  else if (permission === 'no-device') cameraState = 'no-device'
  else cameraState = camOn ? 'video' : 'off'

  const noteOverride =
    permission === 'denied'
      ? 'Habilitá el permiso de cámara/micrófono en tu navegador y recargá la página.'
      : permission === 'no-device'
        ? 'No encontramos cámara ni micrófono conectados.'
        : undefined

  return (
    <div
      style={{
        width: '100%',
        minHeight: '100vh',
        display: 'flex',
        flexDirection: 'column',
        background: colors.surface,
        fontFamily: fonts.body,
        color: colors.textPrimary,
      }}
    >
      <div
        style={{
          height: 78,
          flex: 'none',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: `0 ${spacing.xhuge}px`,
          background: colors.surfaceRaised,
          borderBottom: `1px solid ${colors.border}`,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: spacing.xxl }}>
          <Logo height={44} />
          <div style={{ width: 1, height: 26, background: '#2C2C33' }} />
          <div style={{ font: `500 11px ${fonts.mono}`, letterSpacing: '.18em', textTransform: 'uppercase', color: '#8A8A93' }}>
            Sala {roomInfo?.id ?? ''}
          </div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: spacing.xxxl }}>
          <div style={{ font: `500 12px ${fonts.mono}`, letterSpacing: '.08em', color: colors.textMuted }}>{clock}</div>
          <LiveBadge variant="open" label="Sala abierta" />
          <div style={{ fontSize: 14, color: colors.textDim }}>Ayuda</div>
        </div>
      </div>

      <div style={{ flex: 1, display: 'grid', gridTemplateColumns: '1fr 480px', minHeight: 0 }}>
        <div
          style={{
            position: 'relative',
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            gap: spacing.xxxl,
            padding: `${spacing.xhuge}px 56px`,
            backgroundColor: colors.surface,
            backgroundImage:
              'repeating-linear-gradient(115deg, rgba(255,194,32,.05) 0 2px, transparent 2px 16px)',
          }}
        >
          <VideoTile
            variant="preview"
            cameraState={cameraState}
            stream={localStream}
            muted
            initials={getInitials(nombre || '?')}
            noteOverride={noteOverride}
            bottomLeft={
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 10,
                  background: alpha.overlayBg,
                  backdropFilter: 'blur(6px)',
                  borderRadius: radii.pill,
                  padding: '8px 15px',
                }}
              >
                <span style={{ width: 7, height: 7, borderRadius: radii.pill, background: micOn ? colors.yellow : colors.danger }} />
                <span style={{ fontSize: 13, fontWeight: 500, color: colors.textPrimary }}>Tú &middot; {nombre || 'Vos'}</span>
              </div>
            }
          />

          <div style={{ display: 'flex', alignItems: 'center', gap: spacing.md }}>
            <ControlButton
              variant="toggle"
              active={micOn}
              indicator="circle"
              disabled={permission !== 'granted'}
              label={micOn ? 'Mic activo' : 'Silenciado'}
              onClick={onToggleMic}
            />
            <ControlButton
              variant="toggle"
              active={camOn}
              indicator="square"
              disabled={permission !== 'granted'}
              label={camOn ? 'Cámara' : 'Cámara off'}
              onClick={onToggleCam}
            />
            <ControlButton variant="ghost" label="Dispositivos" disabled title="Próximamente" />
          </div>
        </div>

        <div
          style={{
            background: colors.surfacePanel,
            borderLeft: `1px solid ${colors.border}`,
            padding: `${spacing.panelY}px ${spacing.panelX}px`,
            display: 'flex',
            flexDirection: 'column',
            gap: spacing.xxxl,
            overflow: 'hidden',
          }}
        >
          <div style={{ display: 'flex', flexDirection: 'column', gap: spacing.mdl }}>
            <div style={{ font: `500 11px ${fonts.mono}`, letterSpacing: '.2em', textTransform: 'uppercase', color: colors.yellow }}>
              Registro de asistencia
            </div>
            <div style={{ font: `400 52px ${fonts.display}`, lineHeight: 0.9, textTransform: 'uppercase', color: colors.textHeading }}>
              {roomInfo?.nombre ?? ''}
            </div>
          </div>

          <div style={{ height: 1, background: colors.border }} />

          <RoleSwitch rol={rol} onRolChange={onRolChange} disabled={joining} />

          <form onSubmit={onSubmit} style={{ display: 'flex', flexDirection: 'column', gap: spacing.lg, flex: 1, minHeight: 0 }}>
            <FormField
              label="Nombre completo"
              value={nombre}
              onChange={onNombreChange}
              placeholder="María Restrepo"
              type="text"
              error={fieldErrors.nombre}
              disabled={joining}
            />
            <FormField
              label="Correo"
              value={correo}
              onChange={onCorreoChange}
              placeholder="maria@enactuscolombia.org"
              type="email"
              error={fieldErrors.correo}
              disabled={joining}
            />

            <div style={{ display: 'flex', alignItems: 'flex-start', gap: spacing.md }}>
              <button
                type="button"
                aria-pressed={conductAccepted}
                onClick={() => setConductAccepted((v) => !v)}
                style={{
                  width: 20,
                  height: 20,
                  flex: 'none',
                  marginTop: 2,
                  padding: 0,
                  borderRadius: radii.checkbox,
                  border: `1px solid ${colors.yellow}`,
                  background: conductAccepted ? alpha.checkboxBg : 'transparent',
                  cursor: 'pointer',
                }}
              />
              <div style={{ fontSize: 13, lineHeight: 1.5, color: colors.textMuted }}>
                Acepto el código de conducta Enactus y que la sesión se grabe.
              </div>
            </div>

            {error && <div style={{ font: `400 12px ${fonts.mono}`, color: colors.danger }}>{error}</div>}

            <button
              type="submit"
              disabled={joining}
              onMouseEnter={() => setSubmitHover(true)}
              onMouseLeave={() => setSubmitHover(false)}
              style={{
                marginTop: 'auto',
                height: 60,
                border: 'none',
                borderRadius: radii.sm,
                cursor: joining ? 'not-allowed' : 'pointer',
                background: joining ? colors.yellow : submitHover ? colors.yellowHover : colors.yellow,
                color: colors.ink,
                font: `400 24px ${fonts.display}`,
                letterSpacing: '.04em',
                textTransform: 'uppercase',
                opacity: joining ? 0.6 : 1,
              }}
            >
              {joining ? 'Entrando…' : 'Entrar a la sala'}
            </button>
          </form>
        </div>
      </div>
    </div>
  )
}
