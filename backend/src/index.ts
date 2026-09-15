import { Hono } from 'hono'
import { cors } from 'hono/cors'
import type { Env } from './types'
import * as db from './db'
import * as realtime from './realtime'
import * as session from './session'

export { RoomSession } from './roomSession'

const app = new Hono<{ Bindings: Env }>()

// Prototipo local, sin cookies/credenciales -> CORS abierto está bien acá.
app.use('*', cors())

app.get('/', (c) => c.json({ ok: true, service: 'meets-backend' }))

function roomSessionStub(env: Env, roomId: string) {
  const id = env.ROOM_SESSION.idFromName(roomId)
  return env.ROOM_SESSION.get(id)
}

async function forwardToRoom(env: Env, roomId: string, path: string, init: RequestInit) {
  const stub = roomSessionStub(env, roomId)
  return stub.fetch(new Request(`https://room-session${path}`, init))
}

// ---------------------------------------------------------------------------
// Salas
// ---------------------------------------------------------------------------

app.post('/api/rooms', async (c) => {
  const body = await c.req.json<{ nombre: string; tipo?: 'principal' | 'subsala' }>().catch(() => null)
  if (!body?.nombre) return c.json({ error: 'nombre es requerido' }, 400)

  const maxRooms = Number(c.env.MAX_ACTIVE_ROOMS)
  const room = await db.createRoomIfUnderLimit(
    c.env.DB,
    { id: crypto.randomUUID(), nombre: body.nombre, tipo: body.tipo },
    maxRooms
  )
  if (!room) {
    const activeCount = await db.countActiveRooms(c.env.DB)
    return c.json(
      { error: `Ya hay ${activeCount} salas activas (máximo ${maxRooms}). Cerrá una sala antes de crear otra.` },
      409
    )
  }

  const link = `${c.env.FRONTEND_BASE_URL}/r/${room.id}`
  return c.json({ room, link }, 201)
})

app.get('/api/rooms', async (c) => {
  const rooms = await db.listActiveRooms(c.env.DB)
  return c.json({ rooms })
})

// Pre-chequeo para la pantalla de registro: existe/no existe/cerrada. 200
// con estado "cerrada" (no 404) para una sala que existió y terminó — son
// mensajes de UX distintos a "el link está roto".
app.get('/api/rooms/:roomId', async (c) => {
  const roomId = c.req.param('roomId')
  const room = await db.getRoom(c.env.DB, roomId)
  if (!room) return c.json({ error: 'sala no encontrada' }, 404)
  return c.json({ id: room.id, nombre: room.nombre, estado: room.estado })
})

app.post('/api/rooms/:roomId/close', async (c) => {
  const roomId = c.req.param('roomId')
  const room = await db.getRoom(c.env.DB, roomId)
  if (!room) return c.json({ error: 'sala no encontrada' }, 404)

  await db.closeRoom(c.env.DB, roomId)
  await forwardToRoom(c.env, roomId, '/force-close', { method: 'POST' })

  return c.json({ ok: true })
})

app.get('/api/rooms/:roomId/attendance', async (c) => {
  const roomId = c.req.param('roomId')
  const rows = await db.listAttendance(c.env.DB, roomId)

  if (c.req.query('format') === 'csv') {
    const header = 'nombre,joined_at,left_at\n'
    const csv = rows.map((r) => `${r.user_nombre},${r.joined_at},${r.left_at ?? ''}`).join('\n')
    return c.text(header + csv, 200, { 'Content-Type': 'text/csv' })
  }

  return c.json({ attendance: rows })
})

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const ROLES = ['participante', 'admin'] as const

// Registro previo obligatorio: nombre + correo + rol. Sin esto no hay forma
// de conseguir un token válido, y sin token GET /ws rechaza el upgrade -> es
// lo único que autoriza a entrar al SFU de una sala. Ya no bootstrapea
// ninguna sala: la sala tiene que existir de antes (POST /api/rooms).
app.post('/api/rooms/:roomId/register', async (c) => {
  const roomId = c.req.param('roomId')
  const body = await c.req
    .json<{ nombre?: string; correo?: string; rol?: string }>()
    .catch(() => null)

  const nombre = body?.nombre?.trim()
  const correo = body?.correo?.trim().toLowerCase()
  const rol = body?.rol ?? 'participante'

  if (!nombre) return c.json({ error: 'nombre es requerido' }, 400)
  if (!correo || !EMAIL_RE.test(correo)) return c.json({ error: 'correo inválido' }, 400)
  if (!ROLES.includes(rol as (typeof ROLES)[number])) return c.json({ error: 'rol inválido' }, 400)

  const room = await db.getRoom(c.env.DB, roomId)
  if (!room) return c.json({ error: 'sala no encontrada' }, 404)
  if (room.estado === 'cerrada') return c.json({ error: 'sala cerrada' }, 410)

  const user = await db.upsertUserByEmail(c.env.DB, {
    id: crypto.randomUUID(),
    nombre,
    correo,
    rol: rol as 'participante' | 'admin',
  })

  const token = await session.signSessionToken(
    c.env,
    { roomId, userId: user.id, nombre: user.nombre },
    120 // segundos: solo tiene que sobrevivir hasta que se abra el WS, no la llamada entera
  )

  return c.json({ roomId, userId: user.id, nombre: user.nombre, token })
})

// Parte D (reconexión básica): el token de sesión dura 120s y solo protege
// el upgrade de GET /ws -- no alcanza para una desconexión de red de más de
// 2 minutos. Este endpoint emite un token nuevo para un userId YA
// registrado, sin pasar por el formulario de nombre/correo/rol de nuevo (el
// cliente ya lo tiene en memoria desde el /register original, sobrevive
// mientras la pestaña siga abierta) -- así una reconexión no obliga a
// re-registrarse a media reunión. Mismo patrón 404/410 que /register; el
// `nombre` sale de la tabla `users` (canónico), nunca del body que mande el
// cliente -- mismo espíritu de "nunca confiar en el cliente" que ya aplica
// en GET /ws.
app.post('/api/rooms/:roomId/reauth', async (c) => {
  const roomId = c.req.param('roomId')
  const body = await c.req.json<{ userId?: string }>().catch(() => null)
  const userId = body?.userId

  if (!userId) return c.json({ error: 'userId es requerido' }, 400)

  const room = await db.getRoom(c.env.DB, roomId)
  if (!room) return c.json({ error: 'sala no encontrada' }, 404)
  if (room.estado === 'cerrada') return c.json({ error: 'sala cerrada' }, 410)

  const user = await db.getUserById(c.env.DB, userId)
  if (!user) return c.json({ error: 'usuario no encontrado' }, 404)

  const token = await session.signSessionToken(c.env, { roomId, userId: user.id, nombre: user.nombre }, 120)

  return c.json({ roomId, userId: user.id, nombre: user.nombre, token })
})

app.get('/api/rooms/:roomId/participants', async (c) => {
  const roomId = c.req.param('roomId')
  const res = await forwardToRoom(c.env, roomId, '/participants', { method: 'GET' })
  return new Response(res.body, res)
})

app.get('/api/rooms/:roomId/sfu/ice-servers', async (c) => {
  const iceServers = await realtime.getIceServers(c.env)
  return c.json({ iceServers })
})

// El upgrade a WebSocket es el gate real de acceso al SFU (roomSession.ts no
// vuelve a chequear nada): sin un token válido de /register, no hay forma de
// llegar a tener un connectionId, y sin connectionId ninguno de los
// endpoints /sfu/* funciona (ver roomSession.ts, todos hacen getParticipant
// primero). El rechazo pasa acá, antes de tocar el Durable Object, y
// devuelve un 401 JSON plano en vez de fallar el upgrade (los navegadores no
// exponen el status code de un handshake WS fallido, así que esto también
// es lo que hace el rechazo verificable con curl).
//
// Los valores verificados del token pisan lo que haya mandado el cliente en
// la query -> roomSession.ts sigue leyendo userId/nombre de la URL igual que
// antes, pero ahora esos valores están garantizados, no son lo que el
// cliente eligió mandar.
app.get('/api/rooms/:roomId/ws', async (c) => {
  const roomId = c.req.param('roomId')
  const token = c.req.query('token')
  if (!token) return c.json({ error: 'token requerido' }, 401)

  const verified = await session.verifySessionToken(c.env, token, roomId)
  if (!verified) return c.json({ error: 'token inválido o vencido' }, 401)

  const stub = roomSessionStub(c.env, roomId)
  const url = new URL(c.req.url)
  url.pathname = '/ws'
  url.searchParams.set('roomId', roomId)
  url.searchParams.set('userId', verified.userId)
  url.searchParams.set('nombre', verified.nombre)
  return stub.fetch(new Request(url, c.req.raw))
})

// ---------------------------------------------------------------------------
// Señalización SFU: el navegador nunca habla directo con Cloudflare Realtime
// (necesitaría el App Secret). Todo pasa por acá -> Hono reenvía al DO de la
// sala, que es quien de verdad llama a la API de Realtime (src/realtime.ts).
// ---------------------------------------------------------------------------

app.post('/api/rooms/:roomId/sfu/session', async (c) => {
  const roomId = c.req.param('roomId')
  const body = await c.req.text()
  const res = await forwardToRoom(c.env, roomId, '/sfu/session', {
    method: 'POST',
    body,
    headers: { 'content-type': 'application/json' },
  })
  return new Response(res.body, res)
})

app.post('/api/rooms/:roomId/sfu/publish', async (c) => {
  const roomId = c.req.param('roomId')
  const body = await c.req.text()
  const res = await forwardToRoom(c.env, roomId, '/sfu/publish', {
    method: 'POST',
    body,
    headers: { 'content-type': 'application/json' },
  })
  return new Response(res.body, res)
})

app.post('/api/rooms/:roomId/sfu/subscribe', async (c) => {
  const roomId = c.req.param('roomId')
  const body = await c.req.text()
  const res = await forwardToRoom(c.env, roomId, '/sfu/subscribe', {
    method: 'POST',
    body,
    headers: { 'content-type': 'application/json' },
  })
  return new Response(res.body, res)
})

app.put('/api/rooms/:roomId/sfu/unsubscribe', async (c) => {
  const roomId = c.req.param('roomId')
  const body = await c.req.text()
  const res = await forwardToRoom(c.env, roomId, '/sfu/unsubscribe', {
    method: 'PUT',
    body,
    headers: { 'content-type': 'application/json' },
  })
  return new Response(res.body, res)
})

app.put('/api/rooms/:roomId/sfu/renegotiate', async (c) => {
  const roomId = c.req.param('roomId')
  const body = await c.req.text()
  const res = await forwardToRoom(c.env, roomId, '/sfu/renegotiate', {
    method: 'PUT',
    body,
    headers: { 'content-type': 'application/json' },
  })
  return new Response(res.body, res)
})

app.put('/api/rooms/:roomId/sfu/track-quality', async (c) => {
  const roomId = c.req.param('roomId')
  const body = await c.req.text()
  const res = await forwardToRoom(c.env, roomId, '/sfu/track-quality', {
    method: 'PUT',
    body,
    headers: { 'content-type': 'application/json' },
  })
  return new Response(res.body, res)
})

app.put('/api/rooms/:roomId/sfu/screen-share/stop', async (c) => {
  const roomId = c.req.param('roomId')
  const body = await c.req.text()
  const res = await forwardToRoom(c.env, roomId, '/sfu/screen-share/stop', {
    method: 'PUT',
    body,
    headers: { 'content-type': 'application/json' },
  })
  return new Response(res.body, res)
})

app.put('/api/rooms/:roomId/sfu/media-state', async (c) => {
  const roomId = c.req.param('roomId')
  const body = await c.req.text()
  const res = await forwardToRoom(c.env, roomId, '/sfu/media-state', {
    method: 'PUT',
    body,
    headers: { 'content-type': 'application/json' },
  })
  return new Response(res.body, res)
})

export default app
