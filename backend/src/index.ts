import { Hono, type Context } from 'hono'
import { cors } from 'hono/cors'
import type { Env } from './types'
import * as db from './db'
import * as realtime from './realtime'
import * as session from './session'

export { RoomSession } from './roomSession'

type AppContext = Context<{ Bindings: Env }>

const app = new Hono<{ Bindings: Env }>()

// Prototipo local, sin cookies/credenciales -> CORS abierto está bien acá.
// Los headers propios (x-host-key, x-credencial) pasan el preflight porque el
// middleware refleja Access-Control-Request-Headers.
app.use('*', cors())

app.get('/', (c) => c.json({ ok: true, service: 'meets-backend' }))

// El token de sesión solo tiene que sobrevivir hasta que se abra el WebSocket,
// no la llamada entera.
const SESSION_TOKEN_TTL_SECONDS = 120
// Semana 4: la credencial de grupo dura lo que un evento largo. Con ella la
// persona entra y sale de subsalas, y se reconecta, sin volver a registrarse.
const GROUP_CREDENTIAL_TTL_SECONDS = 12 * 60 * 60

function roomSessionStub(env: Env, roomId: string) {
  const id = env.ROOM_SESSION.idFromName(roomId)
  return env.ROOM_SESSION.get(id)
}

async function forwardToRoom(env: Env, roomId: string, path: string, init: RequestInit) {
  const stub = roomSessionStub(env, roomId)
  return stub.fetch(new Request(`https://room-session${path}`, init))
}

// Semana 4: aviso de mejor esfuerzo a un Durable Object por una ruta
// /internal/* (este Worker no las expone hacia afuera). Si falla, el Durable
// Object descubre lo mismo en su próxima reconciliación contra D1.
async function notifyRoom(env: Env, roomId: string, path: string, body: unknown): Promise<boolean> {
  try {
    const res = await forwardToRoom(env, roomId, path, {
      method: 'POST',
      body: JSON.stringify(body),
      headers: { 'content-type': 'application/json' },
    })
    return res.ok
  } catch {
    return false
  }
}

async function notifySubsalasChanged(env: Env, groupRoomId: string): Promise<void> {
  const rooms = await db.listGroupRooms(env.DB, groupRoomId)
  await Promise.all(rooms.map((r) => notifyRoom(env, r.id, '/internal/subsalas-changed', {})))
}

// Sin el hash de la llave de host: nunca sale del backend.
function publicRoom(room: db.Room) {
  return {
    id: room.id,
    nombre: room.nombre,
    estado: room.estado,
    tipo: room.tipo,
    parentRoomId: room.parent_room_id,
    creadaEn: room.creada_en,
    cerradaEn: room.cerrada_en,
  }
}

function maxSubsalasFrom(env: Env): number {
  const n = Number(env.MAX_SUBSALAS_PER_ROOM)
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 20
}

// 403 si la sala tiene llave de host y el pedido no trae la correcta en el
// header x-host-key. Las salas creadas antes de la llave se siguen pudiendo
// cerrar sin llave (pero no pueden tener subsalas, ver POST /subsalas).
async function hostKeyRejection(c: AppContext, group: db.Room): Promise<Response | null> {
  if (!group.host_key_hash) return null
  if (await session.hostKeyMatches(c.req.header('x-host-key'), group.host_key_hash)) return null
  return c.json({ error: 'Llave de host inválida.' }, 403)
}

// Semana 4: tiempo de cada persona en todo el evento como la UNIÓN de sus
// tramos en todas las salas del grupo (sumar duraciones contaría dos veces un
// solapamiento, por ejemplo con dos pestañas), y el tiempo en cada sala.
function summarizeGroupAttendance(rows: db.GroupAttendanceRow[], nowMs = Date.now()) {
  const byUser = new Map<string, db.GroupAttendanceRow[]>()
  for (const row of rows) {
    const list = byUser.get(row.user_id)
    if (list) list.push(row)
    else byUser.set(row.user_id, [row])
  }

  return [...byUser.entries()].map(([userId, list]) => {
    const intervals = list
      .map((r) => [Date.parse(r.joined_at), r.left_at ? Date.parse(r.left_at) : nowMs] as [number, number])
      .filter(([start, end]) => Number.isFinite(start) && Number.isFinite(end) && end > start)
      .sort((a, b) => a[0] - b[0])

    let totalMs = 0
    let current: [number, number] | null = null
    for (const [start, end] of intervals) {
      if (!current || start > current[1]) {
        if (current) totalMs += current[1] - current[0]
        current = [start, end]
      } else {
        current[1] = Math.max(current[1], end)
      }
    }
    if (current) totalMs += current[1] - current[0]

    const porSala: Record<string, { nombre: string; tipo: 'principal' | 'subsala'; ms: number }> = {}
    for (const r of list) {
      const entry = porSala[r.room_id] ?? (porSala[r.room_id] = { nombre: r.room_nombre, tipo: r.room_tipo, ms: 0 })
      const start = Date.parse(r.joined_at)
      const end = r.left_at ? Date.parse(r.left_at) : nowMs
      if (Number.isFinite(start) && Number.isFinite(end) && end > start) entry.ms += end - start
    }

    return { userId, nombre: list[0].user_nombre, tramos: list.length, totalMs, porSala }
  })
}

// ---------------------------------------------------------------------------
// Salas
// ---------------------------------------------------------------------------

app.post('/api/rooms', async (c) => {
  const body = await c.req.json<{ nombre?: string }>().catch(() => null)
  const nombre = body?.nombre?.trim()
  if (!nombre) return c.json({ error: 'nombre es requerido' }, 400)

  // Semana 4: si el body trae `tipo`, se ignora a propósito. Por esta ruta
  // solo se crean salas principales; si se aceptara, cualquiera podría crear
  // "subsalas" sueltas que no cuentan contra MAX_ACTIVE_ROOMS. Las subsalas se
  // crean con POST /api/rooms/:roomId/subsalas y la llave de host.
  const maxRooms = Number(c.env.MAX_ACTIVE_ROOMS)
  const hostKey = session.generateHostKey()
  const room = await db.createRoomIfUnderLimit(
    c.env.DB,
    { id: crypto.randomUUID(), nombre, hostKeyHash: await session.hashHostKey(hostKey) },
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
  // La llave de host se muestra UNA sola vez. `hostLink` la lleva en el
  // fragmento (#host=...), que el navegador nunca manda a ningún servidor; el
  // frontend la guarda y la saca de la barra de direcciones apenas la lee.
  return c.json({ room: publicRoom(room), link, hostKey, hostLink: `${link}#host=${hostKey}` }, 201)
})

app.get('/api/rooms', async (c) => {
  const rooms = await db.listActiveRooms(c.env.DB)
  return c.json({ rooms: rooms.map(publicRoom) })
})

// Pre-chequeo para la pantalla de registro: existe/no existe/cerrada. 200
// con estado "cerrada" (no 404) para una sala que existió y terminó — son
// mensajes de UX distintos a "el link está roto". Semana 4: también dice si es
// una subsala, para que la pantalla mande a la persona al link de la principal.
app.get('/api/rooms/:roomId', async (c) => {
  const roomId = c.req.param('roomId')
  const room = await db.getRoom(c.env.DB, roomId)
  if (!room) return c.json({ error: 'sala no encontrada' }, 404)
  // Misma forma que en el resto de la API (ver publicRoom).
  return c.json(publicRoom(room))
})

// Semana 4: cerrar exige la llave de host en las salas que la tienen. Cerrar
// la principal cierra el grupo entero; cerrar una subsala devuelve a su gente
// a la principal. En los dos casos primero D1 y después el aviso a los Durable
// Objects, que igual leen el cierre de D1 si el aviso se pierde.
app.post('/api/rooms/:roomId/close', async (c) => {
  const roomId = c.req.param('roomId')
  const room = await db.getRoom(c.env.DB, roomId)
  if (!room) return c.json({ error: 'sala no encontrada' }, 404)
  const group = room.tipo === 'principal' ? room : await db.getRoom(c.env.DB, db.groupIdOf(room))
  if (!group) return c.json({ error: 'sala no encontrada' }, 404)
  const rejection = await hostKeyRejection(c, group)
  if (rejection) return rejection

  if (room.tipo === 'principal') {
    const closedIds = await db.closeGroup(c.env.DB, room.id)
    const toNotify = closedIds.length > 0 ? closedIds : [room.id]
    await Promise.all(toNotify.map((id) => notifyRoom(c.env, id, '/internal/closed', { roomId: id })))
    return c.json({ ok: true, salasCerradas: closedIds.length })
  }

  const closed = await db.closeSubsala(c.env.DB, { subsalaId: room.id, groupRoomId: group.id })
  await notifyRoom(c.env, room.id, '/internal/closed', { roomId: room.id })
  if (closed) await notifySubsalasChanged(c.env, group.id)
  return c.json({ ok: true, salasCerradas: closed ? 1 : 0 })
})

app.get('/api/rooms/:roomId/attendance', async (c) => {
  const roomId = c.req.param('roomId')

  // Semana 4: ?grupo=1 devuelve todas las filas de la reunión (principal y
  // subsalas) y el resumen por persona.
  if (c.req.query('grupo') === '1') {
    const room = await db.getRoom(c.env.DB, roomId)
    if (!room) return c.json({ error: 'sala no encontrada' }, 404)
    const groupRoomId = db.groupIdOf(room)
    const rows = await db.listGroupAttendance(c.env.DB, groupRoomId)
    return c.json({ groupRoomId, attendance: rows, resumen: summarizeGroupAttendance(rows) })
  }

  const rows = await db.listAttendance(c.env.DB, roomId)

  if (c.req.query('format') === 'csv') {
    const header = 'nombre,joined_at,left_at,left_reason\n'
    const csv = rows.map((r) => `${r.user_nombre},${r.joined_at},${r.left_at ?? ''},${r.left_reason ?? ''}`).join('\n')
    return c.text(header + csv, 200, { 'Content-Type': 'text/csv' })
  }

  return c.json({ attendance: rows })
})

// ---------------------------------------------------------------------------
// Subsalas (Semana 4)
// ---------------------------------------------------------------------------

// Solo el host (llave) crea subsalas. `cantidad` crea "Subsala N" numeradas a
// continuación de las que ya existieron; `nombres` las crea con nombre propio.
// El tope MAX_SUBSALAS_PER_ROOM cuenta solo las abiertas y lo hace cumplir la
// propia transacción (ver db.createSubsalas).
app.post('/api/rooms/:roomId/subsalas', async (c) => {
  const group = await db.getRoom(c.env.DB, c.req.param('roomId'))
  if (!group || group.tipo !== 'principal') return c.json({ error: 'sala principal no encontrada' }, 404)
  if (group.estado === 'cerrada') return c.json({ error: 'sala cerrada' }, 410)
  if (!group.host_key_hash) {
    return c.json({ error: 'Esta sala se creó sin llave de host y no puede tener subsalas.' }, 403)
  }
  const rejection = await hostKeyRejection(c, group)
  if (rejection) return rejection

  const body = await c.req.json<{ cantidad?: number; nombres?: string[] }>().catch(() => null)
  const max = maxSubsalasFrom(c.env)
  const { total, activas } = await db.countSubsalas(c.env.DB, group.id)
  if (activas >= max) return c.json({ error: `Ya hay ${activas} subsalas abiertas (máximo ${max}).` }, 409)

  let nombres: string[]
  if (Array.isArray(body?.nombres) && body.nombres.length > 0) {
    nombres = body.nombres.map((n) => String(n).trim().slice(0, 60)).filter(Boolean)
  } else {
    const cantidad = Math.floor(Number(body?.cantidad ?? 1))
    if (!Number.isFinite(cantidad) || cantidad < 1) return c.json({ error: 'cantidad inválida' }, 400)
    nombres = Array.from({ length: Math.min(cantidad, max) }, (_, i) => `Subsala ${total + i + 1}`)
  }
  if (nombres.length === 0) return c.json({ error: 'nombres inválidos' }, 400)

  const creadas = await db.createSubsalas(c.env.DB, { groupRoomId: group.id, nombres, max })
  if (creadas.length > 0) await notifySubsalasChanged(c.env, group.id)
  return c.json(
    { subsalas: creadas.map(publicRoom), max, omitidas: nombres.length - creadas.length },
    creadas.length > 0 ? 201 : 409
  )
})

// Salas abiertas del grupo con cuántas personas hay en cada una. Lo puede ver
// cualquiera con la credencial de esta reunión (x-credencial) o el host
// (x-host-key); `host: true` le confirma al frontend que la llave es válida.
app.get('/api/rooms/:roomId/subsalas', async (c) => {
  const group = await db.getRoom(c.env.DB, c.req.param('roomId'))
  if (!group || group.tipo !== 'principal') return c.json({ error: 'sala principal no encontrada' }, 404)
  const credential = await session.verifyGroupCredential(c.env, c.req.header('x-credencial'))
  const isHost = await session.hostKeyMatches(c.req.header('x-host-key'), group.host_key_hash)
  if (!isHost && credential?.groupRoomId !== group.id) return c.json({ error: 'credencial inválida o vencida' }, 401)
  if (group.estado === 'cerrada') return c.json({ error: 'sala cerrada' }, 410)

  const rooms = await db.listGroupRooms(c.env.DB, group.id)
  return c.json({ rooms, max: maxSubsalasFrom(c.env), host: isHost })
})

// ---------------------------------------------------------------------------
// Registro, credenciales y entrada
// ---------------------------------------------------------------------------

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const ROLES = ['participante', 'admin'] as const

// Registro previo obligatorio: nombre + correo + rol. Sin esto no hay forma
// de conseguir un token válido, y sin token GET /ws rechaza el upgrade -> es
// lo único que autoriza a entrar al SFU de una sala. Ya no bootstrapea
// ninguna sala: la sala tiene que existir de antes (POST /api/rooms).
//
// Semana 4: el registro es siempre en la sala principal y además devuelve la
// credencial de grupo, con la que se entra a las subsalas sin registrarse de
// nuevo.
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
  if (room.tipo !== 'principal') {
    return c.json({ error: 'Esta es una subsala: entrá por el link de la sala principal.' }, 409)
  }

  const user = await db.upsertUserByEmail(c.env.DB, {
    id: crypto.randomUUID(),
    nombre,
    correo,
    rol: rol as 'participante' | 'admin',
  })

  // Registrarse ubica a la persona en la principal con un epoch nuevo. Si ya
  // estaba conectada en una subsala (otra pestaña o dispositivo), esa conexión
  // quedó con un epoch viejo y se le avisa ya a esa sala. Si estaba en la
  // principal, la conexión nueva la reemplaza al entrar.
  const { previous, current } = await db.placeOnRegister(c.env.DB, { groupRoomId: room.id, userId: user.id })
  if (previous && previous.room_id !== room.id) {
    await notifyRoom(c.env, previous.room_id, '/internal/superseded', { userId: user.id, epoch: current.epoch })
  }

  const token = await session.signSessionToken(
    c.env,
    { roomId, userId: user.id, nombre: user.nombre },
    SESSION_TOKEN_TTL_SECONDS
  )
  const credencial = await session.signGroupCredential(
    c.env,
    { groupRoomId: room.id, userId: user.id, nombre: user.nombre },
    GROUP_CREDENTIAL_TTL_SECONDS
  )

  return c.json({ roomId, userId: user.id, nombre: user.nombre, token, credencial })
})

// Parte D (reconexión): el token de sesión dura 120s y solo protege el upgrade
// de GET /ws -- no alcanza para una desconexión de red de más de 2 minutos.
// Este endpoint emite un token nuevo sin pasar por el formulario de nuevo, y
// el `nombre` sale de la tabla `users` (canónico), nunca del body.
//
// Semana 4: antes alcanzaba con mandar un userId (funcionaba como una
// contraseña); ahora exige la credencial de grupo firmada. Y la reconexión va
// a donde D1 ubica a la persona, no a la sala de la URL: si estaba en una
// subsala, vuelve a esa subsala.
app.post('/api/rooms/:roomId/reauth', async (c) => {
  const groupRoomId = c.req.param('roomId')
  const body = await c.req.json<{ credencial?: string }>().catch(() => null)
  const credential = await session.verifyGroupCredential(c.env, body?.credencial)
  if (!credential || credential.groupRoomId !== groupRoomId) {
    return c.json({ error: 'credencial inválida o vencida' }, 401)
  }

  const group = await db.getRoom(c.env.DB, groupRoomId)
  if (!group) return c.json({ error: 'sala no encontrada' }, 404)
  if (group.estado === 'cerrada') return c.json({ error: 'sala cerrada' }, 410)

  const user = await db.getUserById(c.env.DB, credential.userId)
  if (!user) return c.json({ error: 'usuario no encontrado' }, 404)

  const ubicacion = await db.getUbicacion(c.env.DB, group.id, user.id)
  let destino = ubicacion && ubicacion.room_id !== group.id ? await db.getRoom(c.env.DB, ubicacion.room_id) : group
  if (!destino || destino.estado === 'cerrada') {
    await db.repairUbicacion(c.env.DB, { groupRoomId: group.id, userId: user.id })
    destino = group
  }

  const token = await session.signSessionToken(
    c.env,
    { roomId: destino.id, userId: user.id, nombre: user.nombre },
    SESSION_TOKEN_TTL_SECONDS
  )
  // La sala va en `room`, no en un `nombre` suelto: en /register, `nombre` es
  // el de la persona, y mezclarlos ya confundió a un consumidor de esta API.
  return c.json({ roomId: destino.id, room: { id: destino.id, nombre: destino.nombre, tipo: destino.tipo }, userId: user.id, token })
})

// Semana 4, paso 2 del protocolo de transferencia: cambiar la credencial de
// grupo por un token de sesión de la sala destino. Se chequea en D1 que la
// sala exista, sea de esta reunión y siga abierta. El token lleva el move_id:
// con eso el Durable Object destino ejecuta el movimiento de forma idempotente.
app.post('/api/rooms/:roomId/entrada', async (c) => {
  const destId = c.req.param('roomId')
  const body = await c.req.json<{ credencial?: string; moveId?: string }>().catch(() => null)
  const credential = await session.verifyGroupCredential(c.env, body?.credencial)
  if (!credential) return c.json({ error: 'credencial inválida o vencida' }, 401)
  const moveId = body?.moveId
  if (!moveId || !/^[A-Za-z0-9-]{8,64}$/.test(moveId)) return c.json({ error: 'moveId inválido' }, 400)

  const dest = await db.getRoom(c.env.DB, destId)
  if (!dest) return c.json({ error: 'sala no encontrada' }, 404)
  if (db.groupIdOf(dest) !== credential.groupRoomId) return c.json({ error: 'Esa sala no es de tu reunión.' }, 403)
  const group = dest.tipo === 'principal' ? dest : await db.getRoom(c.env.DB, credential.groupRoomId)
  if (!group || group.estado === 'cerrada') return c.json({ error: 'La reunión ya terminó.' }, 410)
  if (dest.estado === 'cerrada') return c.json({ error: 'Esa subsala ya se cerró.' }, 410)

  const token = await session.signSessionToken(
    c.env,
    { roomId: dest.id, userId: credential.userId, nombre: credential.nombre, moveId },
    SESSION_TOKEN_TTL_SECONDS
  )
  // Misma forma que /reauth: la sala va en `room`.
  return c.json({ roomId: dest.id, room: { id: dest.id, nombre: dest.nombre, tipo: dest.tipo }, token })
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

// El upgrade a WebSocket es el gate real de acceso al SFU: sin un token válido
// no hay forma de llegar a tener un connectionId, y sin connectionId (y su
// secreto) ninguno de los endpoints /sfu/* funciona (ver roomSession.ts). El
// rechazo pasa acá, antes de tocar el Durable Object, y devuelve un 401 JSON
// plano en vez de fallar el upgrade (los navegadores no exponen el status code
// de un handshake WS fallido, así que esto también es lo que hace el rechazo
// verificable con curl).
//
// Los valores verificados del token pisan lo que haya mandado el cliente en
// la query -> roomSession.ts sigue leyendo userId/nombre de la URL igual que
// antes, pero ahora esos valores están garantizados, no son lo que el
// cliente eligió mandar. Semana 4: el move_id también sale solo del token.
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
  url.searchParams.delete('moveId')
  if (verified.moveId) url.searchParams.set('moveId', verified.moveId)
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

// Semana 4: al llegar desde otra sala del grupo, la sala destino adopta la
// sesión SFU y los tracks que la persona ya tenía publicados.
app.post('/api/rooms/:roomId/sfu/adopt', async (c) => {
  const roomId = c.req.param('roomId')
  const body = await c.req.text()
  const res = await forwardToRoom(c.env, roomId, '/sfu/adopt', {
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
