// Prueba de la API de subsalas contra el backend real: wrangler dev, D1 local y
// Durable Objects. Sin navegador: WebSockets de Node. Crea una sola sesión SFU
// real, para comprobar que al moverse se reutiliza la misma.
const API = 'http://localhost:8787'
const WS = 'ws://localhost:8787'
const created = [] // { id, hostKey }
const openConns = []
const results = []

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
function check(name, ok, detail = '') {
  results.push({ name, ok: !!ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`)
}

async function api(method, path, { body, headers } = {}) {
  const res = await fetch(API + path, {
    method,
    headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...(headers ?? {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await res.text()
  let json = null
  try { json = JSON.parse(text) } catch {}
  return { status: res.status, json, text }
}

async function createRoom(nombre, extra = {}) {
  const r = await api('POST', '/api/rooms', { body: { nombre, ...extra } })
  if (r.status === 201) created.push({ id: r.json.room.id, hostKey: r.json.hostKey })
  return r
}

function connect(roomId, token) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${WS}/api/rooms/${roomId}/ws?token=${encodeURIComponent(token)}`)
    const messages = []
    let closeInfo = null
    const closeWaiters = []
    const conn = {
      ws,
      messages,
      get hello() { return messages.find((m) => m.type === 'hello') },
      waitClose: (ms = 8000) => (closeInfo ? Promise.resolve(closeInfo) : Promise.race([new Promise((r) => closeWaiters.push(r)), sleep(ms).then(() => null)])),
      // El servidor cerró si llegó el evento close o si el socket quedó en
      // CLOSING (2) sin que el test lo cerrara: undici solo dispara `close`
      // cuando termina la conexión TCP, y workerd local no la corta.
      waitServerClose: async (ms = 8000) => {
        const end = Date.now() + ms
        while (Date.now() < end) {
          if (closeInfo) return { code: closeInfo.code }
          if (ws.readyState === 2) return { code: null }
          await sleep(50)
        }
        return null
      },
      waitMessage: async (type, ms = 8000) => {
        const end = Date.now() + ms
        while (Date.now() < end) {
          const m = messages.find((x) => x.type === type)
          if (m) return m
          await sleep(100)
        }
        return null
      },
      close: () => { try { ws.close() } catch {} },
    }
    openConns.push(conn)
    const timer = setTimeout(() => reject(new Error('timeout esperando hello')), 10000)
    ws.addEventListener('message', (e) => {
      const msg = JSON.parse(e.data)
      messages.push(msg)
      if (msg.type === 'hello') { clearTimeout(timer); resolve(conn) }
    })
    ws.addEventListener('close', (e) => {
      closeInfo = { code: e.code, reason: e.reason }
      clearTimeout(timer)
      reject(new Error(`se cerró antes del hello (código ${e.code})`))
      for (const w of closeWaiters) w(closeInfo)
    })
    ws.addEventListener('error', () => {})
  })
}

async function groupAttendance(roomId) {
  return (await api('GET', `/api/rooms/${roomId}/attendance?grupo=1`)).json
}
const rowsFor = (att, userId) => att.attendance.filter((a) => a.user_id === userId)
const entrada = (roomId, credencial, moveId = crypto.randomUUID()) => api('POST', `/api/rooms/${roomId}/entrada`, { body: { credencial, moveId } })
const host = (room) => ({ 'x-host-key': room.hostKey })

async function main() {
  // --- A. Límite de 7 salas: solo principales ---
  const before = await api('GET', '/api/rooms')
  const activeBefore = before.json.rooms.length
  let createdOk = true
  for (let i = 0; i < 7 - activeBefore; i++) {
    const r = await createRoom(`API subsalas ${i + 1}`)
    createdOk &&= r.status === 201 && !!r.json.hostKey && r.json.hostLink.includes('#host=') && r.json.room.tipo === 'principal' && !('host_key_hash' in r.json.room)
  }
  check(`se crean salas principales hasta 7 (${activeBefore} ya activas), con llave de host y sin exponer su hash`, createdOk)
  check('la octava sala principal se rechaza', (await createRoom('API extra')).status === 409)

  const [R1, R2, R3] = created
  const subs = await api('POST', `/api/rooms/${R1.id}/subsalas`, { body: { cantidad: 3 }, headers: host(R1) })
  check('el host crea 3 subsalas', subs.status === 201 && subs.json.subsalas.length === 3, `status ${subs.status}`)
  const listAfter = await api('GET', '/api/rooms')
  check('las subsalas no aparecen ni cuentan en la lista de salas activas', listAfter.json.rooms.length === 7 && listAfter.json.rooms.every((r) => r.tipo === 'principal'), `${listAfter.json.rooms.length} salas`)
  check('con 3 subsalas abiertas, otra principal sigue dando 409', (await createRoom('API extra 2')).status === 409)

  const last = created[created.length - 1]
  const closeLast = await api('POST', `/api/rooms/${last.id}/close`, { headers: host(last) })
  const sneaky = await createRoom('API subsala disfrazada', { tipo: 'subsala' })
  check('POST /api/rooms ignora "tipo": con tipo subsala crea una principal que sí cuenta', closeLast.status === 200 && sneaky.status === 201 && sneaky.json.room.tipo === 'principal', `cierre ${closeLast.status}, creación ${sneaky.status}, tipo ${sneaky.json?.room?.tipo}`)
  check('y vuelve a haber 7: la siguiente da 409', (await createRoom('API extra 3')).status === 409)

  // --- B. Llave de host y tope ---
  const noKey = await api('POST', `/api/rooms/${R1.id}/subsalas`, { body: { cantidad: 1 } })
  const badKey = await api('POST', `/api/rooms/${R1.id}/subsalas`, { body: { cantidad: 1 }, headers: { 'x-host-key': 'no-es-la-llave' } })
  check('crear subsalas sin llave o con llave equivocada da 403', noKey.status === 403 && badKey.status === 403, `${noKey.status}/${badKey.status}`)
  const cap = await api('POST', `/api/rooms/${R1.id}/subsalas`, { body: { cantidad: 30 }, headers: host(R1) })
  check('tope de 20: con 3 abiertas, pedir 30 crea 17', cap.status === 201 && cap.json.subsalas.length === 17, `status ${cap.status}, creadas ${cap.json?.subsalas?.length}`)
  check('con 20 abiertas, la siguiente da 409', (await api('POST', `/api/rooms/${R1.id}/subsalas`, { body: { cantidad: 1 }, headers: host(R1) })).status === 409)
  check('cerrar una subsala sin llave da 403', (await api('POST', `/api/rooms/${subs.json.subsalas[0].id}/close`)).status === 403)
  const legacy = before.json.rooms.find((r) => r.nombre === 'Comité Nacional')
  if (legacy) {
    check('una sala creada antes de la llave no puede tener subsalas', (await api('POST', `/api/rooms/${legacy.id}/subsalas`, { body: { cantidad: 1 } })).status === 403)
  }

  // --- C. Registro y credenciales ---
  const g2 = await api('POST', `/api/rooms/${R2.id}/subsalas`, { body: { nombres: ['Mesa A', 'Mesa B'] }, headers: host(R2) })
  const [S1, S2] = g2.json.subsalas
  check('registrarse en el link de una subsala da 409', (await api('POST', `/api/rooms/${S1.id}/register`, { body: { nombre: 'X', correo: 'x-api@s4.test' } })).status === 409)
  const u1 = (await api('POST', `/api/rooms/${R2.id}/register`, { body: { nombre: 'Ana API', correo: 'ana-api@s4.test' } })).json
  check('el registro devuelve token y credencial de grupo', !!u1?.token && !!u1?.credencial)
  const legacyReauth = await api('POST', `/api/rooms/${R2.id}/reauth`, { body: { userId: u1.userId } })
  check('reauth con solo un userId ya no sirve', legacyReauth.status === 401, `status ${legacyReauth.status}`)
  const reauth1 = await api('POST', `/api/rooms/${R2.id}/reauth`, { body: { credencial: u1.credencial } })
  check('reauth con credencial devuelve un token para la sala donde está (la principal)', reauth1.status === 200 && reauth1.json.roomId === R2.id)
  const ent1 = await entrada(S1.id, u1.credencial)
  check(
    'reauth y entrada devuelven la sala en "room", sin un "nombre" suelto que se confunda con el de la persona',
    reauth1.json.room?.id === R2.id && reauth1.json.room?.tipo === 'principal' && ent1.json?.room?.id === S1.id && ent1.json?.room?.tipo === 'subsala' && !('nombre' in reauth1.json) && !('nombre' in (ent1.json ?? {})),
    `reauth ${JSON.stringify(reauth1.json.room)}, entrada ${JSON.stringify(ent1.json?.room)}`
  )
  const other = (await api('POST', `/api/rooms/${R3.id}/register`, { body: { nombre: 'Beto Otro', correo: 'beto-api@s4.test' } })).json
  const cross = await entrada(S1.id, other.credencial)
  check('la credencial de otra reunión no entra a esta subsala', cross.status === 403, `status ${cross.status}`)
  check('moveId inválido da 400', (await entrada(S1.id, u1.credencial, 'x')).status === 400)
  check('un token de sesión no sirve como credencial de grupo', (await entrada(S1.id, u1.token)).status === 401)

  // --- D. Movimiento ---
  const c1 = await connect(R2.id, u1.token)
  check('entra a la principal: hello con sala, epoch y secreto de conexión', c1.hello.room.tipo === 'principal' && !!c1.hello.connectionSecret && c1.hello.epoch >= 1, `epoch ${c1.hello.epoch}`)
  const noSecret = await api('POST', `/api/rooms/${R2.id}/sfu/session`, { body: { connectionId: c1.hello.connectionId } })
  const wrongSecret = await api('POST', `/api/rooms/${R2.id}/sfu/session`, { body: { connectionId: c1.hello.connectionId, connectionSecret: 'otro' } })
  check('/sfu/* con el connectionId pero sin su secreto da 403', noSecret.status === 403 && wrongSecret.status === 403, `${noSecret.status}/${wrongSecret.status}`)
  const sess = await api('POST', `/api/rooms/${R2.id}/sfu/session`, { body: { connectionId: c1.hello.connectionId, connectionSecret: c1.hello.connectionSecret } })
  check('con el secreto crea la sesión SFU', sess.status === 200 && !!sess.json.sessionId, `status ${sess.status}`)

  // Cierre visto desde el cliente: con código si el evento llegó, o "cerrando"
  // si el servidor ya mandó el frame de cierre (ver waitServerClose).
  const closedWith = (c, code) => !!c && (c.code === null || c.code === code)
  const cierre = (c) => (c ? (c.code === null ? 'cerrando' : `cerrado ${c.code}`) : 'sigue abierto')

  const M1 = crypto.randomUUID()
  const c2 = await connect(S1.id, (await entrada(S1.id, u1.credencial, M1)).json.token)
  check('llega a la subsala con epoch +1 y la MISMA sesión SFU', c2.hello.room.tipo === 'subsala' && c2.hello.epoch === c1.hello.epoch + 1 && c2.hello.sfuSessionId === sess.json.sessionId, `epoch ${c1.hello.epoch} -> ${c2.hello.epoch}, sesión ${c2.hello.sfuSessionId === sess.json.sessionId ? 'igual' : 'distinta'}`)
  const old = await c1.waitMessage('superseded', 5000)
  const oldClose = await c1.waitServerClose(5000)
  check('la principal suelta la conexión vieja: aviso "superseded" y cierre', !!old && closedWith(oldClose, 4001), `aviso ${!!old}, ${cierre(oldClose)}`)
  let att = await groupAttendance(R2.id)
  let rows = rowsFor(att, u1.userId)
  check('asistencia: la fila de la principal se cierra con "moved" y se abre una en la subsala', rows.some((r) => r.room_id === R2.id && r.left_reason === 'moved') && rows.some((r) => r.room_id === S1.id && r.left_at === null), JSON.stringify(rows.map((r) => [r.room_nombre, r.left_reason])))
  const adopt = await api('POST', `/api/rooms/${S1.id}/sfu/adopt`, { body: { connectionId: c2.hello.connectionId, connectionSecret: c2.hello.connectionSecret, kinds: ['audio', 'video', 'screen'] } })
  check('la subsala adopta los tracks con nombres derivados del usuario (y descarta "screen")', adopt.status === 200 && adopt.json.tracks.audio === `${u1.userId}-audio` && adopt.json.tracks.video === `${u1.userId}-video` && !adopt.json.tracks.screen, `status ${adopt.status}`)
  const foreignName = await api('POST', `/api/rooms/${S1.id}/sfu/publish`, { body: { connectionId: c2.hello.connectionId, connectionSecret: c2.hello.connectionSecret, offer: { type: 'offer', sdp: 'x' }, tracks: [{ mid: '0', trackName: `${other.userId}-audio`, kind: 'audio' }] } })
  check('publicar con el nombre de track de otra persona da 400', foreignName.status === 400, `status ${foreignName.status}`)

  const c3 = await connect(S1.id, (await entrada(S1.id, u1.credencial, M1)).json.token)
  const replaced = await c2.waitMessage('superseded', 5000)
  const replacedClose = await c2.waitServerClose(5000)
  att = await groupAttendance(R2.id)
  rows = rowsFor(att, u1.userId)
  check('reintento con el mismo move_id: no sube el epoch, reemplaza la conexión y no duplica asistencia', c3.hello.epoch === c2.hello.epoch && !!replaced && closedWith(replacedClose, 4001) && rows.filter((r) => r.room_id === S1.id && r.left_at === null).length === 1 && rows.filter((r) => r.room_id === R2.id).length === 1, `epoch ${c3.hello.epoch}, aviso ${!!replaced}, ${cierre(replacedClose)}, ${rows.length} filas`)
  const reauth2 = await api('POST', `/api/rooms/${R2.id}/reauth`, { body: { credencial: u1.credencial } })
  check('reauth después de moverse devuelve la subsala: la reconexión va a donde dice D1', reauth2.json?.roomId === S1.id)

  const list = await api('GET', `/api/rooms/${R2.id}/subsalas`, { headers: { 'x-credencial': u1.credencial } })
  const listNoCred = await api('GET', `/api/rooms/${R2.id}/subsalas`)
  const personasS1 = list.json?.rooms?.find((r) => r.id === S1.id)?.personas
  check('la lista de salas del grupo pide credencial y cuenta personas por sala', list.status === 200 && listNoCred.status === 401 && personasS1 === 1 && list.json.host === false, `personas en Mesa A: ${personasS1}`)
  check('con la llave de host, la lista confirma host: true', (await api('GET', `/api/rooms/${R2.id}/subsalas`, { headers: host(R2) })).json?.host === true)

  // --- E. El host cierra una subsala con gente ---
  const u2 = (await api('POST', `/api/rooms/${R2.id}/register`, { body: { nombre: 'Caro API', correo: 'caro-api@s4.test' } })).json
  const d1 = await connect(R2.id, u2.token)
  const d2 = await connect(S2.id, (await entrada(S2.id, u2.credencial)).json.token)
  await d1.waitMessage('superseded', 5000)
  const closeS2 = await api('POST', `/api/rooms/${S2.id}/close`, { headers: host(R2) })
  const msgClosed = await d2.waitMessage('subsala-closed', 5000)
  const closeD2 = await d2.waitServerClose(5000)
  const reauthU2 = await api('POST', `/api/rooms/${R2.id}/reauth`, { body: { credencial: u2.credencial } })
  att = await groupAttendance(R2.id)
  check('cerrar una subsala con gente: aviso "subsala-closed", cierre y la ubicación vuelve a la principal', closeS2.status === 200 && msgClosed?.groupRoomId === R2.id && closedWith(closeD2, 4002) && reauthU2.json?.roomId === R2.id, `status ${closeS2.status}, ${cierre(closeD2)}`)
  check('su fila de asistencia en la subsala se cierra con "room_closed"', rowsFor(att, u2.userId).some((r) => r.room_id === S2.id && r.left_reason === 'room_closed'))
  check('entrar a la subsala cerrada da 410', (await entrada(S2.id, u2.credencial)).status === 410)
  check('las demás salas del grupo reciben "subsalas-changed"', !!(await c3.waitMessage('subsalas-changed', 5000)))

  // --- G. Otra pestaña ---
  const T1 = (await api('POST', `/api/rooms/${R3.id}/subsalas`, { body: { cantidad: 1 }, headers: host(R3) })).json.subsalas[0]
  const t1 = await connect(R3.id, other.token)
  const t2 = await connect(T1.id, (await entrada(T1.id, other.credencial)).json.token)
  await t1.waitMessage('superseded', 5000)
  const again = await api('POST', `/api/rooms/${R3.id}/register`, { body: { nombre: 'Beto Otro', correo: 'beto-api@s4.test' } })
  const kicked = await t2.waitMessage('superseded', 5000)
  const kickedClose = await t2.waitServerClose(5000)
  check('registrarse otra vez (otra pestaña) saca al instante la conexión que estaba en la subsala: aviso "superseded" y cierre', again.status === 200 && !!kicked && closedWith(kickedClose, 4001), `aviso ${!!kicked}, ${cierre(kickedClose)}`)

  // --- F. El host cierra la reunión con gente en subsalas ---
  const closeR2 = await api('POST', `/api/rooms/${R2.id}/close`, { headers: host(R2) })
  const roomClosed = await c3.waitMessage('room-closed', 5000)
  const c3Close = await c3.waitServerClose(5000)
  att = await groupAttendance(R2.id)
  const lateRegister = await api('POST', `/api/rooms/${R2.id}/register`, { body: { nombre: 'Tarde', correo: 'tarde-api@s4.test' } })
  check('cerrar la principal cierra el grupo: quien estaba en la subsala recibe "room-closed" y cierre', closeR2.status === 200 && closeR2.json.salasCerradas >= 2 && !!roomClosed && closedWith(c3Close, 4002), `salas cerradas ${closeR2.json?.salasCerradas}, ${cierre(c3Close)}`)
  check('no queda asistencia abierta en el grupo y ya no se puede registrar', att.attendance.every((a) => a.left_at) && lateRegister.status === 410, `registro ${lateRegister.status}`)

  // --- H. Resumen de asistencia ---
  const resumen = att.resumen.find((r) => r.userId === u1.userId)
  check('el resumen une los tramos de una persona en todas las salas', !!resumen && resumen.tramos === 2 && resumen.totalMs > 0 && Object.keys(resumen.porSala).length === 2, resumen && `${resumen.tramos} tramos, ${resumen.totalMs} ms, salas: ${Object.values(resumen.porSala).map((s) => s.nombre).join(', ')}`)
}

try {
  await main()
} catch (err) {
  check('la prueba corrió completa', false, err.stack)
} finally {
  for (const c of openConns) c.close()
  for (const r of created) await api('POST', `/api/rooms/${r.id}/close`, { headers: { 'x-host-key': r.hostKey } }).catch(() => {})
  const failed = results.filter((r) => !r.ok)
  console.log(`\n${results.length - failed.length}/${results.length} PASS`)
  // Salida explícita: los temporizadores de las esperas y los WebSockets que
  // cierra el servidor no deben dejar el proceso vivo.
  process.exit(failed.length ? 1 : 0)
}
