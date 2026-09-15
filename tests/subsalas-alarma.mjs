import { execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

// Reconciliación por alarma (roomSession.ts alarm()) cuando se pierde un aviso
// entre salas. Real: Worker, Durable Objects y D1 de wrangler dev (locales).
// Simulado: las personas son clientes WebSocket de Node, y "perder un aviso" es
// escribir en D1 directamente con wrangler d1 execute, sin pasar por el Worker,
// así ningún Durable Object se entera por la vía normal.
const API = 'http://localhost:8787'
const WS = 'ws://localhost:8787'
const BACKEND = fileURLToPath(new URL('../backend/', import.meta.url))
const INTERVAL_MS = 60_000 // RECONCILE_INTERVAL_MS en wrangler.toml
const run = promisify(execFile)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const secs = (ms) => `${(ms / 1000).toFixed(1)} s`
const results = []
const created = []
const conns = []

function check(name, ok, detail = '') {
  results.push({ name, ok: !!ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`)
}

async function api(method, path, { body, headers } = {}) {
  const res = await fetch(API + path, {
    method,
    headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...(headers ?? {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(15000),
  })
  return { status: res.status, json: await res.json().catch(() => null) }
}

async function d1(sql) {
  const { stdout } = await run('npx', ['wrangler', 'd1', 'execute', 'meets-db', '--local', '--json', '--command', sql], {
    cwd: BACKEND,
    env: { ...process.env, CI: 'true' },
    maxBuffer: 10 * 1024 * 1024,
  })
  try {
    return JSON.parse(stdout)
  } catch {
    throw new Error(`salida inesperada de wrangler: ${stdout.slice(0, 300)}`)
  }
}
const firstRows = (r) => r?.[0]?.results ?? []

function connect(label, roomId, token) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${WS}/api/rooms/${roomId}/ws?token=${encodeURIComponent(token)}`)
    const conn = { label, ws, messages: [] }
    conns.push(conn)
    const timer = setTimeout(() => reject(new Error(`${label}: no llegó el hello`)), 10000)
    ws.addEventListener('message', (e) => {
      const msg = JSON.parse(e.data)
      conn.messages.push({ ...msg, at: Date.now() })
      if (msg.type === 'hello') {
        clearTimeout(timer)
        resolve(conn)
      }
    })
    ws.addEventListener('error', () => {
      clearTimeout(timer)
      reject(new Error(`${label}: error de WebSocket`))
    })
  })
}
const firstMessage = (conn, type) => conn.messages.find((m) => m.type === type) ?? null

async function waitUntil(fn, deadline, step = 500) {
  while (Date.now() < deadline) {
    const v = await fn()
    if (v) return v
    await sleep(step)
  }
  return fn()
}

async function groupAttendance(groupId) {
  return (await api('GET', `/api/rooms/${groupId}/attendance?grupo=1`)).json?.attendance ?? []
}
const rowOf = (rows, userId, roomId) => rows.find((a) => a.user_id === userId && a.room_id === roomId) ?? null

async function main() {
  // --- Grupo 1: movimiento con aviso perdido y asistencia huérfana ---
  const g1 = (await api('POST', '/api/rooms', { body: { nombre: 'Alarma: fantasma y huérfana' } })).json
  created.push(g1)
  const G1 = g1.room.id
  const sub1 = (await api('POST', `/api/rooms/${G1}/subsalas`, { body: { cantidad: 1 }, headers: { 'x-host-key': g1.hostKey } })).json.subsalas[0]
  const ana = (await api('POST', `/api/rooms/${G1}/register`, { body: { nombre: 'Ana Alarma', correo: 'ana-alarma@s4.test' } })).json
  const dani = (await api('POST', `/api/rooms/${G1}/register`, { body: { nombre: 'Dani Control', correo: 'dani-alarma@s4.test' } })).json
  const beto = (await api('POST', `/api/rooms/${G1}/register`, { body: { nombre: 'Beto Huérfano', correo: 'beto-alarma@s4.test' } })).json
  const anaWs = await connect('Ana', G1, ana.token)
  const g1ArmedAt = Date.now() // la primera conexión programa la alarma de la principal
  const daniWs = await connect('Dani', G1, dani.token)

  // --- Grupo 2: cierre de subsala con aviso perdido ---
  const g2 = (await api('POST', '/api/rooms', { body: { nombre: 'Alarma: cierre sin aviso' } })).json
  created.push(g2)
  const G2 = g2.room.id
  const sub2 = (await api('POST', `/api/rooms/${G2}/subsalas`, { body: { cantidad: 1 }, headers: { 'x-host-key': g2.hostKey } })).json.subsalas[0]
  const caro = (await api('POST', `/api/rooms/${G2}/register`, { body: { nombre: 'Caro Alarma', correo: 'caro-alarma@s4.test' } })).json
  const entrada = (await api('POST', `/api/rooms/${sub2.id}/entrada`, { body: { credencial: caro.credencial, moveId: crypto.randomUUID() } })).json
  const caroWs = await connect('Caro', sub2.id, entrada.token)
  const g2ArmedAt = Date.now()
  check('preparación: dos personas en la principal del grupo 1 y una en la subsala del grupo 2', !!anaWs && !!daniWs && caroWs.messages[0]?.room?.tipo === 'subsala')

  // --- Los avisos perdidos, escritos directo en D1 ---
  const now = new Date().toISOString()
  const fiveMinutesAgo = new Date(Date.now() - 5 * 60_000).toISOString()
  // 1. D1 movió a Ana a la subsala, pero el aviso a la principal no llegó.
  await d1(
    `UPDATE ubicacion_grupo SET room_id = '${sub1.id}', epoch = epoch + 1, move_id = '${crypto.randomUUID()}', updated_at = '${now}' WHERE group_room_id = '${G1}' AND user_id = '${ana.userId}'`
  )
  // 2. Una fila abierta sin conexión, como si el Durable Object hubiera muerto
  //    justo después de la transacción de llegada.
  const orphanId = crypto.randomUUID()
  await d1(`INSERT INTO attendance (id, room_id, user_id, joined_at) VALUES ('${orphanId}', '${G1}', '${beto.userId}', '${fiveMinutesAgo}')`)
  // 3. La subsala quedó cerrada en D1, pero el aviso a su Durable Object no llegó.
  await d1(`UPDATE rooms SET estado = 'cerrada', cerrada_en = '${now}' WHERE id = '${sub2.id}'`)
  const wroteAt = Date.now()
  // wrangler d1 execute --local no informa filas afectadas: se relee.
  const [written] = firstRows(
    await d1(
      `SELECT (SELECT room_id FROM ubicacion_grupo WHERE group_room_id = '${G1}' AND user_id = '${ana.userId}') AS ana_room, (SELECT COUNT(*) FROM attendance WHERE id = '${orphanId}' AND left_at IS NULL) AS huerfanas, (SELECT estado FROM rooms WHERE id = '${sub2.id}') AS subsala_estado`
    )
  )
  check(
    'escrituras directas en D1 que simulan los tres avisos perdidos',
    written?.ana_room === sub1.id && written?.huerfanas === 1 && written?.subsala_estado === 'cerrada',
    `Ana ${written?.ana_room === sub1.id ? 'en la subsala' : written?.ana_room}, filas huérfanas ${written?.huerfanas}, subsala ${written?.subsala_estado}; ${secs(wroteAt - g1ArmedAt)} después de la primera conexión`
  )
  await sleep(1500)
  check('sin la alarma nadie se entera todavía: Ana y Caro siguen conectadas', !firstMessage(anaWs, 'superseded') && !firstMessage(caroWs, 'subsala-closed'))

  // --- Grupo 1: la alarma de la principal ---
  const deadline1 = g1ArmedAt + INTERVAL_MS + 20_000
  const anaOut = await waitUntil(() => firstMessage(anaWs, 'superseded'), deadline1)
  check(
    'conexión fantasma: la alarma de la principal saca a Ana con "superseded"',
    !!anaOut,
    anaOut ? `a los ${secs(anaOut.at - g1ArmedAt)} de programada la alarma (intervalo de ${secs(INTERVAL_MS)}), ${secs(anaOut.at - wroteAt)} después de escribir en D1` : 'no llegó'
  )
  const rows1 = await waitUntil(async () => {
    const rows = await groupAttendance(G1)
    return rowOf(rows, ana.userId, G1)?.left_reason === 'moved' && rowOf(rows, beto.userId, G1)?.left_reason === 'orphan' ? rows : null
  }, deadline1 + 5_000, 1000)
  const rowsNow1 = rows1 ?? (await groupAttendance(G1))
  check('la fila de Ana en la principal se cierra con "moved"', rowOf(rowsNow1, ana.userId, G1)?.left_reason === 'moved', `motivo ${rowOf(rowsNow1, ana.userId, G1)?.left_reason}`)
  check('asistencia huérfana: la fila abierta de Beto sin conexión se cierra con "orphan"', rowOf(rowsNow1, beto.userId, G1)?.left_reason === 'orphan', `motivo ${rowOf(rowsNow1, beto.userId, G1)?.left_reason}`)
  const daniRow = rowOf(rowsNow1, dani.userId, G1)
  check(
    'la alarma no toca a quien está donde dice D1: Dani sigue conectado y con su fila abierta',
    !firstMessage(daniWs, 'superseded') && daniWs.ws.readyState === 1 && daniRow && daniRow.left_at === null,
    `WebSocket ${daniWs.ws.readyState}, fila ${daniRow?.left_at === null ? 'abierta' : daniRow?.left_reason}`
  )

  // --- Grupo 2: la alarma de la subsala ---
  const deadline2 = g2ArmedAt + INTERVAL_MS + 20_000
  const caroOut = await waitUntil(() => firstMessage(caroWs, 'subsala-closed'), deadline2)
  check(
    'cierre sin aviso: la alarma de la subsala lee el cierre en D1 y avisa "subsala-closed"',
    caroOut?.groupRoomId === G2,
    caroOut ? `a los ${secs(caroOut.at - g2ArmedAt)} de programada la alarma` : 'no llegó'
  )
  const rows2 = await waitUntil(async () => {
    const rows = await groupAttendance(G2)
    return rowOf(rows, caro.userId, sub2.id)?.left_reason === 'room_closed' ? rows : null
  }, Date.now() + 5_000, 1000)
  check('la fila de Caro en la subsala se cierra con "room_closed"', !!rows2, `motivo ${rowOf(rows2 ?? (await groupAttendance(G2)), caro.userId, sub2.id)?.left_reason}`)
  const reauth = await api('POST', `/api/rooms/${G2}/reauth`, { body: { credencial: caro.credencial } })
  check(
    'su ubicación seguía en la subsala cerrada: /reauth la repara y la manda a la principal',
    reauth.status === 200 && reauth.json?.roomId === G2,
    `status ${reauth.status}, sala ${reauth.json?.roomId === G2 ? 'principal' : reauth.json?.roomId}`
  )
}

try {
  await main()
} catch (err) {
  check('la prueba corrió completa', false, err.stack?.split('\n').slice(0, 3).join(' | '))
} finally {
  for (const c of conns) {
    try {
      c.ws.close()
    } catch {}
  }
  for (const g of created) {
    await api('POST', `/api/rooms/${g.room.id}/close`, { headers: { 'x-host-key': g.hostKey } }).catch(() => {})
  }
  const failed = results.filter((r) => !r.ok)
  console.log(`\n${results.length - failed.length}/${results.length} PASS`)
  process.exit(failed.length ? 1 : 0)
}
