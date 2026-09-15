// Acceso a D1. Consultas planas (sin ORM) a propósito: el modelo de datos de
// esta semana es chico (3 tablas) y no vale la pena la dependencia extra.

export interface Room {
  id: string
  nombre: string
  estado: 'activa' | 'cerrada'
  tipo: 'principal' | 'subsala'
  parent_room_id: string | null
  creada_en: string
  cerrada_en: string | null
}

export interface User {
  id: string
  nombre: string
  correo: string | null
  rol: 'participante' | 'admin'
  creado_en: string
}

export interface AttendanceRow {
  id: string
  room_id: string
  user_id: string
  joined_at: string
  left_at: string | null
  user_nombre: string
}

export async function countActiveRooms(db: D1Database): Promise<number> {
  const row = await db
    .prepare(`SELECT COUNT(*) as n FROM rooms WHERE estado = 'activa'`)
    .first<{ n: number }>()
  return row?.n ?? 0
}

// Chequeo + insert en una sola sentencia: D1 serializa los writes de una
// misma base, así que este INSERT...SELECT...WHERE es atómico y evita la
// condición de carrera de hacer countActiveRooms() + createRoom() como dos
// llamadas separadas (dos requests concurrentes podrían pasar ambas el
// count antes de que cualquiera inserte). Devuelve null si el límite ya
// estaba alcanzado (no se insertó nada) en vez de tirar.
export async function createRoomIfUnderLimit(
  db: D1Database,
  params: { id: string; nombre: string; tipo?: 'principal' | 'subsala'; parentRoomId?: string | null },
  maxActive: number
): Promise<Room | null> {
  const room: Room = {
    id: params.id,
    nombre: params.nombre,
    estado: 'activa',
    tipo: params.tipo ?? 'principal',
    parent_room_id: params.parentRoomId ?? null,
    creada_en: new Date().toISOString(),
    cerrada_en: null,
  }
  const result = await db
    .prepare(
      `INSERT INTO rooms (id, nombre, estado, tipo, parent_room_id, creada_en)
       SELECT ?, ?, 'activa', ?, ?, ?
       WHERE (SELECT COUNT(*) FROM rooms WHERE estado = 'activa') < ?`
    )
    .bind(room.id, room.nombre, room.tipo, room.parent_room_id, room.creada_en, maxActive)
    .run()
  return result.meta.changes > 0 ? room : null
}

export async function getRoom(db: D1Database, id: string): Promise<Room | null> {
  return db.prepare(`SELECT * FROM rooms WHERE id = ?`).bind(id).first<Room>()
}

export async function listActiveRooms(db: D1Database): Promise<Room[]> {
  const { results } = await db
    .prepare(`SELECT * FROM rooms WHERE estado = 'activa' ORDER BY creada_en DESC`)
    .all<Room>()
  return results
}

export async function closeRoom(db: D1Database, id: string): Promise<void> {
  await db
    .prepare(`UPDATE rooms SET estado = 'cerrada', cerrada_en = ? WHERE id = ?`)
    .bind(new Date().toISOString(), id)
    .run()
}

// Si ya existe un usuario con ese correo, reutiliza esa fila (actualiza
// nombre) en vez de duplicar. INSERT...ON CONFLICT...RETURNING es una sola
// sentencia atómica, así que dos registros concurrentes con el mismo correo
// no pueden crear dos filas. rol queda afuera del SET a propósito: si
// alguien fue promovido a 'admin' a mano, un re-registro con el form (que
// manda 'participante' por defecto) no debe degradarlo en silencio.
export async function upsertUserByEmail(
  db: D1Database,
  params: { id: string; nombre: string; correo: string; rol: 'participante' | 'admin' }
): Promise<User> {
  const creado_en = new Date().toISOString()
  const row = await db
    .prepare(
      `INSERT INTO users (id, nombre, correo, rol, creado_en) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(correo) DO UPDATE SET nombre = excluded.nombre
       RETURNING *`
    )
    .bind(params.id, params.nombre, params.correo, params.rol, creado_en)
    .first<User>()
  if (!row) throw new Error('upsertUserByEmail: no row returned')
  return row
}

export async function getUserById(db: D1Database, id: string): Promise<User | null> {
  return db.prepare(`SELECT * FROM users WHERE id = ?`).bind(id).first<User>()
}

export async function recordJoin(
  db: D1Database,
  params: { id: string; roomId: string; userId: string }
): Promise<void> {
  await db
    .prepare(`INSERT INTO attendance (id, room_id, user_id, joined_at) VALUES (?, ?, ?, ?)`)
    .bind(params.id, params.roomId, params.userId, new Date().toISOString())
    .run()
}

export async function recordLeave(db: D1Database, attendanceId: string): Promise<void> {
  await db
    .prepare(`UPDATE attendance SET left_at = ? WHERE id = ? AND left_at IS NULL`)
    .bind(new Date().toISOString(), attendanceId)
    .run()
}

// Parte D (reconexión): la fila de attendance más reciente de este usuario en esta
// sala que se cerró (left_at no nulo) dentro de la ventana de gracia -- si existe, una
// reconexión rápida la reusa (resumeAttendance) en vez de insertar una fila nueva, para
// que un corte de wifi de unos segundos no aparezca como dos asistencias separadas en
// el reporte de Semana 6.
export async function findRecentAttendance(
  db: D1Database,
  params: { roomId: string; userId: string; sinceIso: string }
): Promise<AttendanceRow | null> {
  return db
    .prepare(
      `SELECT * FROM attendance
       WHERE room_id = ? AND user_id = ? AND left_at IS NOT NULL AND left_at > ?
       ORDER BY left_at DESC LIMIT 1`
    )
    .bind(params.roomId, params.userId, params.sinceIso)
    .first<AttendanceRow>()
}

export async function resumeAttendance(db: D1Database, attendanceId: string): Promise<void> {
  await db.prepare(`UPDATE attendance SET left_at = NULL WHERE id = ?`).bind(attendanceId).run()
}

export async function listAttendance(db: D1Database, roomId: string): Promise<AttendanceRow[]> {
  const { results } = await db
    .prepare(
      `SELECT a.*, u.nombre as user_nombre
       FROM attendance a JOIN users u ON u.id = a.user_id
       WHERE a.room_id = ?
       ORDER BY a.joined_at ASC`
    )
    .bind(roomId)
    .all<AttendanceRow>()
  return results
}
