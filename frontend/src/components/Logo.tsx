import mainLogoAvif from '../media/mainlogo.avif'
import mainLogoPng from '../media/mainlogo.png'

// El wordmark ocupa solo la banda central del archivo -- por debajo de 40px
// de alto el texto se vuelve ilegible (ver frontend/src/README.md, sección
// Assets), por eso el default es 44px, el mismo tamaño usado en las barras
// oscuras del diseño.
export function Logo({ height = 44 }: { height?: number }) {
  return (
    <picture>
      <source srcSet={mainLogoAvif} type="image/avif" />
      <img src={mainLogoPng} alt="Enactus Colombia" style={{ height, display: 'block' }} />
    </picture>
  )
}
