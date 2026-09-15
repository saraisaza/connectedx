// Tokens de marca Enactus Colombia — extraídos de frontend/src/README.md
// (handoff de diseño). Todo estilo del app debería construirse a partir de
// estos valores en lugar de hardcodear hex/tamaños sueltos.

export const colors = {
  yellow: '#FFC220',
  yellowHover: '#FFD24D',
  yellowSoft: '#FFD866',
  ink: '#15150F',
  bg: '#08080A',
  surface: '#0D0D10',
  surfaceRaised: '#101014',
  surfacePanel: '#131317',
  surfaceInput: '#0F0F13',
  surfaceTile: '#16161B',
  surfaceTileAlt: '#14141A',
  surfaceControl: '#17171C',
  controlOff: '#232329',
  border: '#24242A',
  borderSoft: '#2A2A31',
  borderInput: '#2E2E36',
  borderControl: '#26262C',
  textPrimary: '#F5F5F0',
  textHeading: '#F7F7F2',
  textBody: '#E8E8E2',
  textMuted: '#9B9BA3',
  textDim: '#85858E',
  textFaint: '#6E6E78',
  textInput: '#5F5F69',
  danger: '#F0563C',
  dangerHover: '#FF7A64',
} as const

export const alpha = {
  badgeOpenBg: 'rgba(255,194,32,.12)',
  badgeOpenBorder: 'rgba(255,194,32,.35)',
  badgeLiveBg: 'rgba(240,86,60,.14)',
  badgeLiveBorder: 'rgba(240,86,60,.4)',
  checkboxBg: 'rgba(255,194,32,.15)',
  overlayBg: 'rgba(10,10,12,.82)',
  dangerBg: 'rgba(240,86,60,.14)',
  dangerBorder: 'rgba(240,86,60,.45)',
} as const

export const fonts = {
  display: "'Anton', sans-serif",
  body: "'DM Sans', sans-serif",
  mono: "'IBM Plex Mono', monospace",
} as const

export const spacing = {
  xxs: 4,
  xs: 6,
  sm: 8,
  smd: 10,
  md: 12,
  mdl: 14,
  lg: 16,
  lgl: 18,
  xl: 20,
  xxl: 22,
  xxxl: 26,
  huge: 30,
  xhuge: 34,
  panelX: 44,
  panelY: 46,
  giant: 56,
} as const

export const radii = {
  pill: 999,
  xl: 18,
  lg: 16,
  md: 14,
  sm: 12,
  input: 10,
  xs: 8,
  checkbox: 5,
  dot: 2,
} as const

export const shadows = {
  screen: '0 40px 80px -40px rgba(0,0,0,.9)',
  previewGlow: '0 30px 70px -35px rgba(255,194,32,.45)',
  speakerGlow: '0 30px 70px -35px rgba(255,194,32,.5)',
} as const

export const textures = {
  screenBg: 'repeating-linear-gradient(115deg, rgba(255,194,32,.04) 0 2px, transparent 2px 18px)',
  preJoinBg: 'repeating-linear-gradient(115deg, rgba(255,194,32,.05) 0 2px, transparent 2px 16px)',
  videoPlaceholder: 'repeating-linear-gradient(115deg, rgba(255,255,255,.045) 0 2px, transparent 2px 13px)',
} as const

export const theme = { colors, alpha, fonts, spacing, radii, shadows, textures } as const
