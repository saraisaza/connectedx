import type { ReactNode } from 'react'
import { Logo } from '../components/Logo'
import { colors, fonts, textures } from '../theme'

// Layout compartido por 'loading' | 'not-found' | 'closed' y el caso sin
// roomId -- ninguno está dibujado en el prototipo, así que sigue la spec
// textual de frontend/src/README.md (sección "Pantallas de estado").
export function StatusScreen({ title, body }: { title: string; body: ReactNode }) {
  return (
    <div
      style={{
        minHeight: '100vh',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 26,
        padding: 24,
        backgroundColor: colors.bg,
        backgroundImage: textures.screenBg,
        fontFamily: fonts.body,
      }}
    >
      <Logo height={44} />
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14, maxWidth: 480, textAlign: 'center' }}>
        <h1
          style={{
            margin: 0,
            font: `400 44px ${fonts.display}`,
            textTransform: 'uppercase',
            color: colors.textHeading,
          }}
        >
          {title}
        </h1>
        <div style={{ font: `400 15px ${fonts.body}`, lineHeight: 1.5, color: colors.textMuted }}>{body}</div>
      </div>
    </div>
  )
}
