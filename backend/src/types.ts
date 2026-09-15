export interface Env {
  // Durable Objects: un RoomSession por sala activa.
  ROOM_SESSION: DurableObjectNamespace

  // D1: rooms / users / attendance.
  DB: D1Database

  // --- Cloudflare Realtime SFU ---
  // App ID: identificador público (va en el path de la URL), no es secreto.
  CALLS_APP_ID: string
  // Base URL de la API HTTPS de Realtime SFU (https://rtc.live.cloudflare.com/v1).
  CALLS_API_BASE_URL: string
  // App Token/Secret: SIEMPRE como secret (wrangler secret put), nunca en wrangler.toml.
  CALLS_APP_SECRET: string

  // --- Cloudflare Realtime TURN (opcional esta semana) ---
  // Si no están seteados, el backend hace fallback a STUN público de Cloudflare.
  TURN_TOKEN_ID?: string
  TURN_TOKEN_SECRET?: string

  // Límite de salas activas simultáneas (Semana 1: 7).
  MAX_ACTIVE_ROOMS: string

  // Máximo de tracks de VIDEO simultáneos que un cliente puede tener
  // suscritos (Parte A: 10, modelo Meet). No aplica a audio.
  MAX_VISIBLE_TILES: string

  // --- Simulcast (Parte C) ---
  // Resolución objetivo (alto en px) y bitrate máximo (bps) de cada una de
  // las dos capas que publica cada cliente. Configurables para poder
  // bajarlos si el costo de egress de Cloudflare sube más de lo esperado --
  // nunca hardcodeados en el frontend (viajan en el `hello` del WebSocket,
  // ver roomSession.ts).
  SIMULCAST_LOW_HEIGHT: string
  SIMULCAST_LOW_MAX_BITRATE_BPS: string
  SIMULCAST_HIGH_HEIGHT: string
  SIMULCAST_HIGH_MAX_BITRATE_BPS: string

  // --- Parte D ---
  // Bitrate máximo (bps) del track de pantalla compartida -- siempre una sola capa,
  // sin simulcast (el texto de una presentación tiene que ser legible).
  SCREEN_SHARE_MAX_BITRATE_BPS: string
  // Ventana de gracia (ms) para fusionar una reconexión rápida con la fila de
  // attendance que dejó abierta la desconexión anterior, en vez de crear una nueva.
  ATTENDANCE_GRACE_WINDOW_MS: string

  // --- Subsalas (Semana 4) ---
  // Máximo de subsalas activas por sala principal. Las subsalas no cuentan
  // contra MAX_ACTIVE_ROOMS.
  MAX_SUBSALAS_PER_ROOM: string
  // Cada cuánto reconcilia un Durable Object con gente adentro su presencia
  // contra D1: conexiones fantasma, asistencia huérfana y cierre de la sala.
  RECONCILE_INTERVAL_MS: string

  // --- Registro previo (Semana 2) ---
  // Secreto usado para firmar la credencial de sesión de /register (HMAC,
  // ver session.ts). SIEMPRE como secret (wrangler secret put), nunca en
  // wrangler.toml.
  SESSION_SIGNING_SECRET: string
  // Origen del frontend, para armar el link de sala en la respuesta de
  // POST /api/rooms (ej. "https://meets.example.com" o "http://localhost:5173").
  FRONTEND_BASE_URL: string
}
