import { useState, type CSSProperties, type ReactNode } from 'react'
import { colors, alpha, fonts, radii } from '../theme'

type Variant = 'toggle' | 'ghost' | 'danger' | 'primary'
type Indicator = 'circle' | 'square' | 'none'

export interface ControlButtonProps {
  variant: Variant
  label: ReactNode
  active?: boolean // solo aplica a 'toggle': amarillo cuando true, #232329 cuando false
  disabled?: boolean
  indicator?: Indicator
  height?: number
  paddingX?: number
  onClick?: () => void
  title?: string
}

const disabledStyle: CSSProperties = { opacity: 0.5, cursor: 'not-allowed', pointerEvents: 'none' }

export function ControlButton({
  variant,
  label,
  active = false,
  disabled = false,
  indicator = 'none',
  height = 48,
  paddingX = 20,
  onClick,
  title,
}: ControlButtonProps) {
  const [hover, setHover] = useState(false)

  let background: string = colors.surfaceControl
  let color: string = colors.textMuted
  let border = `1px solid ${colors.borderControl}`

  if (variant === 'toggle') {
    background = active ? colors.yellow : colors.controlOff
    color = active ? colors.ink : '#C9C9D1'
    border = 'none'
  } else if (variant === 'ghost') {
    background = colors.surfaceControl
    color = hover ? colors.yellow : colors.textMuted
    border = `1px solid ${hover ? colors.yellow : colors.borderControl}`
  } else if (variant === 'danger') {
    background = hover ? colors.danger : alpha.dangerBg
    color = hover ? colors.ink : colors.danger
    border = `1px solid ${alpha.dangerBorder}`
  } else if (variant === 'primary') {
    background = hover ? colors.yellowHover : colors.yellow
    color = colors.ink
    border = 'none'
  }

  return (
    <button
      type="button"
      title={title}
      disabled={disabled}
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 10,
        height,
        padding: `0 ${paddingX}px`,
        border,
        borderRadius: radii.pill,
        cursor: 'pointer',
        background,
        color,
        font: `500 12px ${fonts.mono}`,
        letterSpacing: '.12em',
        textTransform: 'uppercase',
        whiteSpace: 'nowrap',
        ...(disabled ? disabledStyle : {}),
      }}
    >
      {indicator !== 'none' && (
        <span
          style={{
            width: indicator === 'circle' ? 7 : 8,
            height: indicator === 'circle' ? 7 : 8,
            borderRadius: indicator === 'circle' ? radii.pill : radii.dot,
            background: 'currentColor',
            flex: 'none',
          }}
        />
      )}
      {label}
    </button>
  )
}
