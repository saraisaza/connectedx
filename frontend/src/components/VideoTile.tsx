import { useEffect, useRef, type CSSProperties, type ReactNode } from 'react'
import { colors, fonts, radii, shadows, textures } from '../theme'

export type VideoTileVariant = 'preview' | 'sidebar' | 'spotlight'
export type CameraState = 'video' | 'off' | 'pending' | 'denied' | 'no-device'

export interface VideoTileProps {
  variant: VideoTileVariant
  cameraState: CameraState
  stream: MediaStream | null
  muted?: boolean
  initials: string
  topLeftBadge?: ReactNode
  topRightBadge?: ReactNode
  bottomLeft?: ReactNode
  captionOverride?: string
  noteOverride?: string
  // Parte B: quien está hablando ahora lleva el mismo borde amarillo
  // destacado sin importar la variante -- el indicador visual de active
  // speaker no depende de dónde vive el tile (grid o tile fijo propio).
  speaking?: boolean
  // Parte D: pantalla compartida necesita 'contain' (mostrar el frame
  // completo, sin recortar) para que el texto de una presentación siga
  // siendo legible -- 'cover' (el default de siempre, cámaras) recorta los
  // bordes para llenar el tile, perfecto para caras, pésimo para texto.
  fit?: 'cover' | 'contain'
}

export function getInitials(nombre: string): string {
  const parts = nombre.trim().split(/\s+/).filter(Boolean)
  if (parts.length === 0) return '?'
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase()
  return (parts[0][0] + parts[1][0]).toUpperCase()
}

const variantFrame: Record<VideoTileVariant, CSSProperties> = {
  preview: {
    width: '100%',
    maxWidth: 720,
    aspectRatio: '16 / 9',
    border: `4px solid ${colors.yellow}`,
    borderRadius: radii.xl,
    boxShadow: shadows.previewGlow,
    background: colors.surfaceTile,
  },
  sidebar: {
    width: '100%',
    aspectRatio: '16 / 9',
    border: `1px solid ${colors.borderSoft}`,
    borderRadius: radii.sm,
    background: colors.surfaceTileAlt,
  },
  // Parte D: pantalla compartida -- llena el área disponible (la decide el
  // contenedor padre en CallScreen), sin forzar 16:9 como las otras dos
  // variantes: una presentación puede venir en cualquier proporción, y
  // forzar el aspect-ratio del tile recortaría contenido real.
  spotlight: {
    width: '100%',
    height: '100%',
    border: `1px solid ${colors.borderSoft}`,
    borderRadius: radii.sm,
    background: colors.surfaceTileAlt,
  },
}

const avatarSize: Record<VideoTileVariant, number> = { preview: 108, sidebar: 58, spotlight: 108 }
const avatarBorder: Record<VideoTileVariant, number> = { preview: 3, sidebar: 2, spotlight: 3 }
const avatarFont: Record<VideoTileVariant, number> = { preview: 40, sidebar: 20, spotlight: 40 }
const captionSize: Record<VideoTileVariant, number> = { preview: 11, sidebar: 11, spotlight: 11 }

const defaultCaption: Record<CameraState, string> = {
  video: '',
  off: 'CÁMARA APAGADA',
  pending: 'PIDIENDO PERMISO DE CÁMARA…',
  denied: 'PERMISO DE CÁMARA DENEGADO',
  'no-device': 'NO SE ENCONTRÓ UNA CÁMARA',
}

export function VideoTile({
  variant,
  cameraState,
  stream,
  muted,
  initials,
  topLeftBadge,
  topRightBadge,
  bottomLeft,
  captionOverride,
  noteOverride,
  speaking,
  fit = 'cover',
}: VideoTileProps) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const showVideo = cameraState === 'video' && !!stream

  useEffect(() => {
    if (videoRef.current) videoRef.current.srcObject = showVideo ? stream : null
  }, [stream, showVideo])

  const caption = captionOverride ?? defaultCaption[cameraState]
  const speakingOverride: CSSProperties = speaking
    ? { border: `3px solid ${colors.yellow}`, boxShadow: shadows.previewGlow }
    : {}

  return (
    <div style={{ position: 'relative', overflow: 'hidden', ...variantFrame[variant], ...speakingOverride }}>
      {showVideo ? (
        <video
          ref={videoRef}
          autoPlay
          playsInline
          muted={muted}
          style={{ width: '100%', height: '100%', objectFit: fit, display: 'block' }}
        />
      ) : (
        <div
          style={{
            position: 'absolute',
            inset: 0,
            backgroundImage: variant !== 'sidebar' ? textures.videoPlaceholder : undefined,
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            gap: variant === 'sidebar' ? 0 : 18,
          }}
        >
          {cameraState !== 'pending' && (
            <div
              style={{
                width: avatarSize[variant],
                height: avatarSize[variant],
                borderRadius: radii.pill,
                border: `${avatarBorder[variant]}px solid ${colors.yellow}`,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                font: `400 ${avatarFont[variant]}px ${fonts.display}`,
                color: colors.yellow,
                flex: 'none',
              }}
            >
              {initials}
            </div>
          )}
          {variant !== 'sidebar' && caption && (
            <span
              style={{
                font: `500 ${captionSize[variant]}px ${fonts.mono}`,
                letterSpacing: '.2em',
                textTransform: 'uppercase',
                color: colors.textFaint,
                textAlign: 'center',
                padding: '0 24px',
              }}
            >
              {caption}
            </span>
          )}
          {noteOverride && (
            <span
              style={{
                font: `400 13px ${fonts.body}`,
                color: colors.textMuted,
                textAlign: 'center',
                maxWidth: 320,
                padding: '0 24px',
              }}
            >
              {noteOverride}
            </span>
          )}
        </div>
      )}

      {topLeftBadge && <div style={{ position: 'absolute', left: variant === 'sidebar' ? 12 : 22, top: variant === 'sidebar' ? 10 : 22 }}>{topLeftBadge}</div>}
      {topRightBadge && <div style={{ position: 'absolute', right: variant === 'sidebar' ? 10 : 22, top: variant === 'sidebar' ? 9 : 22 }}>{topRightBadge}</div>}
      {bottomLeft && (
        <div style={{ position: 'absolute', left: variant === 'sidebar' ? 12 : 18, bottom: variant === 'sidebar' ? 10 : 18 }}>{bottomLeft}</div>
      )}
    </div>
  )
}
