import { alpha, colors, fonts, radii } from '../theme'

export interface LiveBadgeProps {
  variant: 'open' | 'live'
  label: string
}

// El keyframe `livePulse` vive en theme.css (es lo único que un `style`
// inline no puede expresar). El resto de esta píldora es inline.
export function LiveBadge({ variant, label }: LiveBadgeProps) {
  const accent = variant === 'open' ? colors.yellow : colors.danger
  const background = variant === 'open' ? alpha.badgeOpenBg : alpha.badgeLiveBg
  const border = variant === 'open' ? alpha.badgeOpenBorder : alpha.badgeLiveBorder
  const pulseDuration = variant === 'open' ? '2s' : '1.6s'

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 9,
        background,
        border: `1px solid ${border}`,
        borderRadius: radii.pill,
        padding: '7px 14px',
      }}
    >
      <span
        style={{
          width: 7,
          height: 7,
          borderRadius: radii.pill,
          background: accent,
          animation: `livePulse ${pulseDuration} ease-in-out infinite`,
          flex: 'none',
        }}
      />
      <span
        style={{
          font: `500 11px ${fonts.mono}`,
          letterSpacing: '.16em',
          textTransform: 'uppercase',
          color: accent,
          whiteSpace: 'nowrap',
        }}
      >
        {label}
      </span>
    </div>
  )
}
