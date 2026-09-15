// Acceso a D1. Consultas planas (sin ORM) a propósito: el modelo de datos es
// chico y no vale la pena la dependencia extra.
//
// Semana 4 (subsalas): D1 es la fuente autoritativa de qué salas existen y
// siguen abiertas (`rooms`), dónde debe estar cada persona dentro de su grupo
// (`ubicacion_grupo`) y cuánto estuvo en cada sala (`attendance`). Lo que toca
// varias tablas va en un solo `batch()`, que D1 ejecuta como una transacción
// SQL: en orden, sin intercalarse con otras escrituras, y todo o nada.

export interface Room {
  id: string
  nombre: string
  estado: 'activa' | 'cerrada'
  tipo: 'principal' | 'subsala'
  parent_room_id: string | null
  creada_en: string
  cerrada_en: string | null
  host_key_hash: string | null
}

export interface User {
  id: string
  nombre: string
  correo: string | null
  rol: 'participante' | 'admin'
  creado_en: string
}

export type LeftReason = 'disconnect' | 'moved' | 'room_closed' | 'orphan'

export interface AttendanceRow {
  id: string
  room_id: string
  user_id: string
  joined_at: string
  left_at: string | null
  left_reason: LeftReason | null
  user_nombre: string
}

export interface GroupAttendanceRow extends AttendanceRow {
  room_nombre: string
  room_tipo: 'principal' | 'subsala'
}

export interface Ubicacion {
  group_room_id: string
  user_id: string
  room_id: string
  epoch: number
  move_id: string | null
  sfu_session_id: string | null
  updated_at: string
}

export interface GroupRoom {
  id: string
  nombre: string
  tipo: 'principal' | 'subsala'
  personas: number
}

// Resultado de aceptar a alguien en una sala (con o sin movimiento).
export interface Arrival {
  // Dónde dice D1 que pertenece la persona después de la transacción. Si no es
  // la sala que la está aceptando, la conexión se rechaza.
  roomId: string | null
  epoch: number
  sfuSessionId: string | null
  // Fila de asistencia abierta en la sala destino (null si no se pudo abrir).
  attendanceId: string | null
  // Solo para movimientos: dónde estaba antes, y si fue ESTA llamada la que
  // aplicó el movimiento (false en un reintento con el mismo move_id).
  previousRoomId: string | null
  moveApplied: boolean
}

// Id del grupo al que pertenece una sala: la propia sala si es principal, su
// sala principal si es subsala.
export function groupIdOf(room: Room): string {
  return room.tipo === 'subsala' && room.parent_room_id ? room.parent_room_id : room.id
}

// Solo salas principales: las subsalas no cuentan contra MAX_ACTIVE_ROOMS.
export async function countActiveRooms(db: D1Database): Promise<number> {
  const row = await db
    .prepare(`SELECT COUNT(*) as n FROM rooms WHERE estado = 'activa' AND tipo = 'principal'`)
    .first<{ n: number }>()
  return row?.n ?? 0
}

// Chequeo + insert en una sola sentencia: D1 serializa los writes de una
// misma base, así que este INSERT...SELECT...WHERE es atómico y evita la
// condición de carrera de hacer countActiveRooms() + createRoom() como dos
// llamadas separadas (dos requests concurrentes podrían pasar ambas el
// count antes de que cualquiera inserte). Devuelve null si el límite ya
// estaba alcanzado (no se insertó nada) en vez de tirar. Por acá solo se
// crean salas principales (ver index.ts).
export async function createRoomIfUnderLimit(
  db: D1Database,
  params: { id: string; nombre: string; hostKeyHash: string },
  maxActive: number
): Promise<Room | null> {
  const room: Room = {
    id: params.id,
    nombre: params.nombre,
    estado: 'activa',
    tipo: 'principal',
    parent_room_id: null,
    creada_en: new Date().toISOString(),
    cerrada_en: null,
    host_key_hash: params.hostKeyHash,
  }
  const result = await db
    .prepare(
      `INSERT INTO rooms (id, nombre, estado, tipo, parent_room_id, creada_en, host_key_hash)
       SELECT ?1, ?2, 'activa', 'principal', NULL, ?3, ?4
       WHERE (SELECT COUNT(*) FROM rooms WHERE estado = 'activa' AND tipo = 'principal') < ?5`
    )
    .bind(room.id, room.nombre, room.creada_en, room.host_key_hash, maxActive)
    .run()
  return result.meta.changes > 0 ? room : null
}

export async function getRoom(db: D1Database, id: string): Promise<Room | null> {
  return db.prepare(`SELECT * FROM rooms WHERE id = ?`).bind(id).first<Room>()
}

export async function listActiveRooms(db: D1Database): Promise<Room[]> {
  const { results } = await db
    .prepare(`SELECT * FROM rooms WHERE estado = 'activa' AND tipo = 'principal' ORDER BY creada_en DESC`)
    .all<Room>()
  return results
}

// Salas abiertas de un grupo (la principal primero) y cuántas personas tienen
// una fila de asistencia abierta en cada una.
export async function listGroupRooms(db: D1Database, groupRoomId: string): Promise<GroupRoom[]> {
  const { results } = await db
    .prepare(
      `SELECT r.id, r.nombre, r.tipo,
              (SELECT COUNT(DISTINCT a.user_id) FROM attendance a WHERE a.room_id = r.id AND a.left_at IS NULL) AS personas
       FROM rooms r
       WHERE (r.id = ?1 OR r.parent_room_id = ?1) AND r.estado = 'activa'
       ORDER BY CASE r.tipo WHEN 'principal' THEN 0 ELSE 1 END, r.creada_en, r.nombre`
    )
    .bind(groupRoomId)
    .all<GroupRoom>()
  return results
}

export async function countSubsalas(db: D1Database, groupRoomId: string): Promise<{ total: number; activas: number }> {
  const row = await db
    .prepare(
      `SELECT COUNT(*) AS total, COALESCE(SUM(CASE WHEN estado = 'activa' THEN 1 ELSE 0 END), 0) AS activas
       FROM rooms WHERE parent_room_id = ?1 AND tipo = 'subsala'`
    )
    .bind(groupRoomId)
    .first<{ total: number; activas: number }>()
  return { total: row?.total ?? 0, activas: row?.activas ?? 0 }
}

// Una sentencia por subsala dentro de un mismo batch: cada INSERT vuelve a
// contar las activas, así que el tope se respeta aunque lleguen dos pedidos del
// host a la vez. Devuelve solo las que se crearon.
export async function createSubsalas(
  db: D1Database,
  params: { groupRoomId: string; nombres: string[]; max: number }
): Promise<Room[]> {
  const now = new Date().toISOString()
  const pending = params.nombres.map((nombre) => ({ id: crypto.randomUUID(), nombre }))
  if (pending.length === 0) return []
  const results = await db.batch(
    pending.map((p) =>
      db
        .prepare(
          `INSERT INTO rooms (id, nombre, estado, tipo, parent_room_id, creada_en)
           SELECT ?1, ?2, 'activa', 'subsala', ?3, ?4
           WHERE EXISTS (SELECT 1 FROM rooms WHERE id = ?3 AND tipo = 'principal' AND estado = 'activa')
             AND (SELECT COUNT(*) FROM rooms WHERE parent_room_id = ?3 AND estado = 'activa') < ?5`
        )
        .bind(p.id, p.nombre, params.groupRoomId, now, params.max)
    )
  )
  return pending
    .filter((_, i) => (results[i]?.meta.changes ?? 0) > 0)
    .map((p) => ({
      id: p.id,
      nombre: p.nombre,
      estado: 'activa' as const,
      tipo: 'subsala' as const,
      parent_room_id: params.groupRoomId,
      creada_en: now,
      cerrada_en: null,
      host_key_hash: null,
    }))
}

// Cerrar la sala principal cierra el grupo entero en una transacción: la
// principal, todas sus subsalas y cada fila de asistencia abierta del grupo.
// Devuelve las salas que seguían abiertas, para avisarle a cada Durable Object.
export async function closeGroup(db: D1Database, groupRoomId: string): Promise<string[]> {
  const now = new Date().toISOString()
  const [abiertas] = await db.batch([
    db.prepare(`SELECT id FROM rooms WHERE (id = ?1 OR parent_room_id = ?1) AND estado = 'activa'`).bind(groupRoomId),
    db
      .prepare(
        `UPDATE attendance SET left_at = ?1, left_reason = 'room_closed'
         WHERE left_at IS NULL
           AND room_id IN (SELECT id FROM rooms WHERE (id = ?2 OR parent_room_id = ?2) AND estado = 'activa')`
      )
      .bind(now, groupRoomId),
    db
      .prepare(`UPDATE rooms SET estado = 'cerrada', cerrada_en = ?1 WHERE (id = ?2 OR parent_room_id = ?2) AND estado = 'activa'`)
      .bind(now, groupRoomId),
  ])
  return ((abiertas?.results ?? []) as { id: string }[]).map((r) => r.id)
}

// El host cierra una subsala con gente adentro: en la misma transacción la
// subsala queda cerrada, quienes pertenecían a ella pasan a pertenecer a la
// principal con un epoch nuevo, y sus filas de asistencia se cierran con motivo
// 'room_closed'. Recién después se le avisa al Durable Object (ver index.ts),
// así ninguna entrada nueva se cuela entre el chequeo y el cierre.
export async function closeSubsala(db: D1Database, params: { subsalaId: string; groupRoomId: string }): Promise<boolean> {
  const now = new Date().toISOString()
  const results = await db.batch([
    db
      .prepare(
        `UPDATE attendance SET left_at = ?1, left_reason = 'room_closed'
         WHERE room_id = ?2 AND left_at IS NULL
           AND EXISTS (SELECT 1 FROM rooms WHERE id = ?2 AND parent_room_id = ?3 AND estado = 'activa')`
      )
      .bind(now, params.subsalaId, params.groupRoomId),
    db
      .prepare(
        `UPDATE ubicacion_grupo SET room_id = ?1, epoch = epoch + 1, move_id = NULL, updated_at = ?2
         WHERE group_room_id = ?1 AND room_id = ?3
           AND EXISTS (SELECT 1 FROM rooms WHERE id = ?3 AND parent_room_id = ?1 AND estado = 'activa')`
      )
      .bind(params.groupRoomId, now, params.subsalaId),
    db
      .prepare(
        `UPDATE rooms SET estado = 'cerrada', cerrada_en = ?1
         WHERE id = ?2 AND parent_room_id = ?3 AND tipo = 'subsala' AND estado = 'activa'`
      )
      .bind(now, params.subsalaId, params.groupRoomId),
  ])
  return (results[2]?.meta.changes ?? 0) > 0
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

// --- Ubicación dentro del grupo ---

// Registrarse (o volver a registrarse) en la sala principal ubica a la persona
// en la principal con un epoch nuevo. Si tenía una conexión abierta en otra
// sala del grupo (otra pestaña o dispositivo), esa conexión queda con un epoch
// viejo y la cierra quien corresponda (ver index.ts y roomSession.ts).
export async function placeOnRegister(
  db: D1Database,
  params: { groupRoomId: string; userId: string }
): Promise<{ previous: Ubicacion | null; current: Ubicacion }> {
  const now = new Date().toISOString()
  const [prev, , curr] = await db.batch([
    db.prepare(`SELECT * FROM ubicacion_grupo WHERE group_room_id = ?1 AND user_id = ?2`).bind(params.groupRoomId, params.userId),
    db
      .prepare(
        `INSERT INTO ubicacion_grupo (group_room_id, user_id, room_id, epoch, move_id, sfu_session_id, updated_at)
         VALUES (?1, ?2, ?1, 1, NULL, NULL, ?3)
         ON CONFLICT(group_room_id, user_id) DO UPDATE SET
           room_id = excluded.room_id, epoch = ubicacion_grupo.epoch + 1, move_id = NULL,
           sfu_session_id = NULL, updated_at = excluded.updated_at`
      )
      .bind(params.groupRoomId, params.userId, now),
    db.prepare(`SELECT * FROM ubicacion_grupo WHERE group_room_id = ?1 AND user_id = ?2`).bind(params.groupRoomId, params.userId),
  ])
  const previous = ((prev?.results ?? []) as Ubicacion[])[0] ?? null
  const current = ((curr?.results ?? []) as Ubicacion[])[0]
  if (!current) throw new Error('placeOnRegister: sin fila de ubicación')
  return { previous, current }
}

export async function getUbicacion(db: D1Database, groupRoomId: string, userId: string): Promise<Ubicacion | null> {
  return db
    .prepare(`SELECT * FROM ubicacion_grupo WHERE group_room_id = ?1 AND user_id = ?2`)
    .bind(groupRoomId, userId)
    .first<Ubicacion>()
}

export async function listUbicacionesDelGrupo(db: D1Database, groupRoomId: string): Promise<Ubicacion[]> {
  const { results } = await db
    .prepare(`SELECT * FROM ubicacion_grupo WHERE group_room_id = ?1`)
    .bind(groupRoomId)
    .all<Ubicacion>()
  return results
}

// Cerrar una subsala mueve a su gente en la misma transacción, así que una
// ubicación que apunte a una sala cerrada no debería existir. Si aparece, se
// repara devolviendo a la persona a la principal con un epoch nuevo.
export async function repairUbicacion(db: D1Database, params: { groupRoomId: string; userId: string }): Promise<Ubicacion | null> {
  const now = new Date().toISOString()
  const [, curr] = await db.batch([
    db
      .prepare(
        `UPDATE ubicacion_grupo SET room_id = ?1, epoch = epoch + 1, move_id = NULL, updated_at = ?2
         WHERE group_room_id = ?1 AND user_id = ?3 AND room_id <> ?1
           AND NOT EXISTS (SELECT 1 FROM rooms WHERE id = ubicacion_grupo.room_id AND estado = 'activa')`
      )
      .bind(params.groupRoomId, now, params.userId),
    db.prepare(`SELECT * FROM ubicacion_grupo WHERE group_room_id = ?1 AND user_id = ?2`).bind(params.groupRoomId, params.userId),
  ])
  return ((curr?.results ?? []) as Ubicacion[])[0] ?? null
}

// La sesión SFU queda anotada en la ubicación para que otra sala del grupo la
// reutilice cuando la persona se mueva. Solo si el epoch sigue siendo el de la
// conexión que la creó: una conexión fantasma no pisa la sesión de la vigente.
export async function setSfuSession(
  db: D1Database,
  params: { groupRoomId: string; userId: string; epoch: number; sfuSessionId: string }
): Promise<void> {
  await db
    .prepare(
      `UPDATE ubicacion_grupo SET sfu_session_id = ?1, updated_at = ?2
       WHERE group_room_id = ?3 AND user_id = ?4 AND epoch = ?5`
    )
    .bind(params.sfuSessionId, new Date().toISOString(), params.groupRoomId, params.userId, params.epoch)
    .run()
}

function arrivalFrom(rows: unknown[] | undefined): Pick<Arrival, 'roomId' | 'epoch' | 'sfuSessionId' | 'attendanceId'> {
  const row = (rows?.[0] ?? null) as { room_id: string; epoch: number; sfu_session_id: string | null; attendance_id: string | null } | null
  return {
    roomId: row?.room_id ?? null,
    epoch: row?.epoch ?? 0,
    sfuSessionId: row?.sfu_session_id ?? null,
    attendanceId: row?.attendance_id ?? null,
  }
}

function readArrivalStatement(db: D1Database, params: { groupRoomId: string; roomId: string; userId: string }) {
  return db
    .prepare(
      `SELECT u.room_id, u.epoch, u.sfu_session_id,
              (SELECT a.id FROM attendance a
                WHERE a.room_id = ?1 AND a.user_id = ?2 AND a.left_at IS NULL
                ORDER BY a.joined_at DESC LIMIT 1) AS attendance_id
       FROM ubicacion_grupo u WHERE u.group_room_id = ?3 AND u.user_id = ?2`
    )
    .bind(params.roomId, params.userId, params.groupRoomId)
}

function openAttendanceStatement(
  db: D1Database,
  params: { groupRoomId: string; roomId: string; userId: string; attendanceId: string; now: string }
) {
  return db
    .prepare(
      `INSERT INTO attendance (id, room_id, user_id, joined_at)
       SELECT ?1, ?2, ?3, ?4
       WHERE EXISTS (SELECT 1 FROM ubicacion_grupo WHERE group_room_id = ?5 AND user_id = ?3 AND room_id = ?2)
         AND EXISTS (SELECT 1 FROM rooms WHERE id = ?2 AND estado = 'activa')
         AND NOT EXISTS (SELECT 1 FROM attendance WHERE room_id = ?2 AND user_id = ?3 AND left_at IS NULL)`
    )
    .bind(params.attendanceId, params.roomId, params.userId, params.now, params.groupRoomId)
}

// Paso 5 del protocolo de transferencia, el "punto de verdad" de un
// movimiento. Una sola transacción:
//   a) mueve a la persona a la sala destino, solo si esa sala sigue abierta y
//      es del grupo (y la principal también), subiendo el epoch y guardando el
//      move_id; si ese move_id ya estaba aplicado no cambia nada (reintento);
//   b) cierra su fila de asistencia abierta en otra sala del grupo con motivo
//      'moved', solo si el movimiento quedó aplicado;
//   c) abre su fila en la sala destino si pertenece a ella y no tiene una;
//   d) lee el resultado.
// Cada sentencia se condiciona a las anteriores dentro de la transacción, así
// que un cierre de sala concurrente no puede colarse entre el chequeo y la
// escritura.
export async function applyMove(
  db: D1Database,
  params: { groupRoomId: string; roomId: string; userId: string; moveId: string; attendanceId: string }
): Promise<Arrival> {
  const now = new Date().toISOString()
  const { groupRoomId, roomId, userId, moveId } = params
  const results = await db.batch([
    db.prepare(`SELECT room_id FROM ubicacion_grupo WHERE group_room_id = ?1 AND user_id = ?2`).bind(groupRoomId, userId),
    db
      .prepare(
        `UPDATE ubicacion_grupo SET room_id = ?1, epoch = epoch + 1, move_id = ?2, updated_at = ?3
         WHERE group_room_id = ?4 AND user_id = ?5 AND (move_id IS NULL OR move_id <> ?2)
           AND EXISTS (SELECT 1 FROM rooms WHERE id = ?1 AND estado = 'activa' AND (id = ?4 OR parent_room_id = ?4))
           AND EXISTS (SELECT 1 FROM rooms WHERE id = ?4 AND estado = 'activa')`
      )
      .bind(roomId, moveId, now, groupRoomId, userId),
    db
      .prepare(
        `UPDATE attendance SET left_at = ?1, left_reason = 'moved'
         WHERE user_id = ?2 AND left_at IS NULL AND room_id <> ?3
           AND room_id IN (SELECT id FROM rooms WHERE id = ?4 OR parent_room_id = ?4)
           AND EXISTS (SELECT 1 FROM ubicacion_grupo
                        WHERE group_room_id = ?4 AND user_id = ?2 AND room_id = ?3 AND move_id = ?5)`
      )
      .bind(now, userId, roomId, groupRoomId, moveId),
    openAttendanceStatement(db, { groupRoomId, roomId, userId, attendanceId: params.attendanceId, now }),
    readArrivalStatement(db, { groupRoomId, roomId, userId }),
  ])
  const previous = ((results[0]?.results ?? []) as { room_id: string }[])[0]
  return {
    ...arrivalFrom(results[4]?.results),
    previousRoomId: previous?.room_id ?? null,
    moveApplied: (results[1]?.meta.changes ?? 0) > 0,
  }
}

// Llegada sin movimiento: el primer ingreso después de registrarse, o una
// reconexión (que va a la sala donde D1 ubica a la persona, ver /reauth). Solo
// se acepta si D1 ya ubica a la persona en esta sala. Quien entra a la principal
// sin fila de ubicación (registrado antes de las subsalas) recibe una.
//
// Parte D (reconexión rápida): si la persona tiene una fila de esta sala que se
// cerró por desconexión dentro de la ventana de gracia, se reabre en vez de
// insertar otra, así un corte de wifi de unos segundos no aparece como dos
// asistencias en el reporte de Semana 6. Semana 4: solo filas cerradas por
// 'disconnect'. Si se reabriera una cerrada por 'moved', ir a una subsala y
// volver en menos de 90 s taparía el tramo pasado en la subsala.
export async function arriveWithoutMove(
  db: D1Database,
  params: { groupRoomId: string; roomId: string; userId: string; attendanceId: string; graceSinceIso: string }
): Promise<Arrival> {
  const now = new Date().toISOString()
  const { groupRoomId, roomId, userId } = params
  const results = await db.batch([
    db
      .prepare(
        `INSERT INTO ubicacion_grupo (group_room_id, user_id, room_id, epoch, move_id, sfu_session_id, updated_at)
         SELECT ?1, ?2, ?1, 1, NULL, NULL, ?3
         WHERE ?4 = ?1 AND NOT EXISTS (SELECT 1 FROM ubicacion_grupo WHERE group_room_id = ?1 AND user_id = ?2)`
      )
      .bind(groupRoomId, userId, now, roomId),
    db
      .prepare(
        `UPDATE attendance SET left_at = NULL, left_reason = NULL
         WHERE id = (SELECT id FROM attendance
                      WHERE room_id = ?1 AND user_id = ?2 AND left_at IS NOT NULL AND left_at > ?3
                        AND (left_reason IS NULL OR left_reason = 'disconnect')
                      ORDER BY left_at DESC LIMIT 1)
           AND EXISTS (SELECT 1 FROM ubicacion_grupo WHERE group_room_id = ?4 AND user_id = ?2 AND room_id = ?1)
           AND EXISTS (SELECT 1 FROM rooms WHERE id = ?1 AND estado = 'activa')
           AND NOT EXISTS (SELECT 1 FROM attendance WHERE room_id = ?1 AND user_id = ?2 AND left_at IS NULL)`
      )
      .bind(roomId, userId, params.graceSinceIso, groupRoomId),
    openAttendanceStatement(db, { groupRoomId, roomId, userId, attendanceId: params.attendanceId, now }),
    readArrivalStatement(db, { groupRoomId, roomId, userId }),
  ])
  return { ...arrivalFrom(results[3]?.results), previousRoomId: null, moveApplied: false }
}

// --- Asistencia ---

// Cierra una fila solo si seguía abierta: si ya la cerró un movimiento o el
// cierre de la sala, conserva ese motivo.
export async function recordLeave(db: D1Database, attendanceId: string, reason: LeftReason): Promise<void> {
  await db
    .prepare(`UPDATE attendance SET left_at = ?1, left_reason = ?2 WHERE id = ?3 AND left_at IS NULL`)
    .bind(new Date().toISOString(), reason, attendanceId)
    .run()
}

export async function listOpenAttendance(
  db: D1Database,
  roomId: string
): Promise<{ id: string; user_id: string; joined_at: string }[]> {
  const { results } = await db
    .prepare(`SELECT id, user_id, joined_at FROM attendance WHERE room_id = ?1 AND left_at IS NULL`)
    .bind(roomId)
    .all<{ id: string; user_id: string; joined_at: string }>()
  return results
}

export async function closeAttendanceRows(db: D1Database, ids: string[], reason: LeftReason): Promise<void> {
  if (ids.length === 0) return
  const now = new Date().toISOString()
  const statement = db.prepare(`UPDATE attendance SET left_at = ?1, left_reason = ?2 WHERE id = ?3 AND left_at IS NULL`)
  for (let i = 0; i < ids.length; i += 50) {
    await db.batch(ids.slice(i, i + 50).map((id) => statement.bind(now, reason, id)))
  }
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

// Todas las filas de un grupo (la principal y sus subsalas), para el reporte
// que suma el tiempo de cada persona en todo el evento.
export async function listGroupAttendance(db: D1Database, groupRoomId: string): Promise<GroupAttendanceRow[]> {
  const { results } = await db
    .prepare(
      `SELECT a.*, u.nombre AS user_nombre, r.nombre AS room_nombre, r.tipo AS room_tipo
       FROM attendance a
       JOIN users u ON u.id = a.user_id
       JOIN rooms r ON r.id = a.room_id
       WHERE r.id = ?1 OR r.parent_room_id = ?1
       ORDER BY a.user_id, a.joined_at`
    )
    .bind(groupRoomId)
    .all<GroupAttendanceRow>()
  return results
}
