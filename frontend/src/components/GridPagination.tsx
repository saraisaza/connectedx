import { ControlButton } from './ControlButton'
import { colors, fonts, spacing } from '../theme'

export interface GridPaginationProps {
  currentPage: number
  totalPages: number
  totalParticipants: number
  onPrev: () => void
  onNext: () => void
}

export function GridPagination({ currentPage, totalPages, totalParticipants, onPrev, onNext }: GridPaginationProps) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: spacing.lg }}>
      <div style={{ font: `500 12px ${fonts.mono}`, letterSpacing: '.1em', color: colors.textMuted, whiteSpace: 'nowrap' }}>
        {totalParticipants} participantes
      </div>
      {totalPages > 1 && (
        <div style={{ display: 'flex', alignItems: 'center', gap: spacing.sm }}>
          <ControlButton variant="ghost" label="◄" height={32} paddingX={12} onClick={onPrev} disabled={currentPage <= 1} />
          <div style={{ font: `500 11px ${fonts.mono}`, letterSpacing: '.1em', color: colors.textDim, whiteSpace: 'nowrap' }}>
            Página {currentPage} de {totalPages}
          </div>
          <ControlButton variant="ghost" label="►" height={32} paddingX={12} onClick={onNext} disabled={currentPage >= totalPages} />
        </div>
      )}
    </div>
  )
}
