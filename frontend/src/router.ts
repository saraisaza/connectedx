// Sin librería de routing a propósito: hay exactamente una ruta dinámica
// esta semana (/r/:roomId). Sumar react-router-dom para esto sería
// abstracción prematura — si Semana 4+ suma rutas reales, ahí se evalúa.
export function parseRoomIdFromPath(pathname: string): string | null {
  const match = pathname.match(/^\/r\/([^/]+)\/?$/)
  return match ? decodeURIComponent(match[1]) : null
}
