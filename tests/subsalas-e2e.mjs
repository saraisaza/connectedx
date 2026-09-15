import { chromium } from 'playwright'

// Prueba de punta a punta de subsalas con la app real: navegadores Chromium
// reales, WebRTC real, Durable Objects, D1 y el SFU de Cloudflare. Lo simulado
// son los medios (canvas y oscilador, como en la prueba de 16) y las personas.
const API = 'http://localhost:8787'
const results = []
const httpErrors = []
// Momentos de la prueba, para ubicar cada error HTTP respecto de lo que estaba pasando.
const marks = {}
// Avisos de la propia app en consola ("[sfu] ...").
const sfuLogs = []
// Señalización y suscripciones de cada pestaña, para reconstruir carreras
// cuando algo falla.
const userNames = new Map() // userId -> nombre, de las respuestas de /register
const wsEvents = []
const subsLog = []
const ownerOf = (trackName = '') => `${userNames.get(trackName.replace(/-(audio|video|screen)$/, '')) ?? trackName.slice(0, 8)}:${trackName.split('-').pop()}`
function dumpHistory(names, center, before = 20000, after = 5000) {
  for (const n of names) {
    console.log(`  historial de ${n}:`)
    const rows = [
      ...wsEvents.filter((w) => w.who === n).map((w) => ({ t: w.t, text: `${w.type} ${w.detail}` })),
      ...subsLog.filter((s) => s.who === n).map((s) => ({ t: s.t, text: `subscribe ${s.status} ${s.tracks.join(' ')}` })),
    ]
      .filter((r) => r.t >= center - before && r.t <= center + after)
      .sort((a, b) => a.t - b.t)
    for (const r of rows) console.log(`    ${((r.t - center) / 1000).toFixed(2)} s ${r.text}`)
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function check(name, ok, detail = '') {
  results.push({ name, ok: !!ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`)
}

function initScript(label) {
  return `
  (() => {
    window.__pcs = [];
    window.__sigSockets = [];
    const OrigPC = window.RTCPeerConnection;
    class WrappedPC extends OrigPC {
      constructor(...a) { super(...a); window.__pcs.push(this); }
    }
    window.RTCPeerConnection = WrappedPC;
    const OrigWS = window.WebSocket;
    class WrappedWS extends OrigWS {
      constructor(url, ...rest) {
        super(url, ...rest);
        if (String(url).includes('/ws?token=')) {
          window.__sigSockets.push(this);
          this.addEventListener('close', (e) => { (window.__sigCloses ??= []).push(e.code); });
        }
      }
    }
    window.WebSocket = WrappedWS;
    window.__pubAudioCtx = null;
    navigator.mediaDevices.getUserMedia = async (constraints) => {
      const tracks = [];
      if (!constraints || constraints.video) {
        const canvas = document.createElement('canvas');
        canvas.width = 160; canvas.height = 120;
        const g = canvas.getContext('2d');
        let hue = Math.floor(Math.random() * 360);
        const draw = () => { hue = (hue + 11) % 360; g.fillStyle = 'hsl(' + hue + ',55%,40%)'; g.fillRect(0, 0, 160, 120); g.fillStyle = '#fff'; g.font = '36px sans-serif'; g.fillText(${JSON.stringify(label)}, 10, 74); };
        draw(); setInterval(draw, 400);
        tracks.push(canvas.captureStream(3).getVideoTracks()[0]);
      }
      if (!constraints || constraints.audio) {
        const ctx = window.__pubAudioCtx || new AudioContext();
        window.__pubAudioCtx = ctx;
        ctx.resume().catch(() => {});
        const osc = ctx.createOscillator();
        osc.frequency.value = 220 + Math.floor(Math.random() * 200);
        const gain = ctx.createGain();
        gain.gain.value = 0;
        window.__gainNode = gain;
        const dest = ctx.createMediaStreamDestination();
        osc.connect(gain).connect(dest);
        osc.start();
        tracks.push(dest.stream.getAudioTracks()[0]);
      }
      return new MediaStream(tracks);
    };
  })();`
}

async function api(method, path, { body, headers } = {}) {
  const res = await fetch(API + path, {
    method,
    headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...(headers ?? {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  return { status: res.status, json: await res.json().catch(() => null) }
}

async function openAndJoin(browser, url, nombre, correo, label = nombre) {
  const ctx = await browser.newContext({ viewport: { width: 1360, height: 860 }, permissions: ['camera', 'microphone'] })
  await ctx.addInitScript(initScript(nombre))
  const page = await ctx.newPage()
  page.on('response', async (res) => {
    const path = new URL(res.url()).pathname
    const t = Date.now()
    if (path.endsWith('/register') && res.status() < 400) {
      const j = await res.json().catch(() => null)
      if (j?.userId) userNames.set(j.userId, j.nombre)
    }
    if (path.endsWith('/sfu/subscribe')) {
      let requested = []
      try {
        requested = (JSON.parse(res.request().postData() ?? '{}').tracks ?? []).map((x) => ownerOf(x.trackName))
      } catch {}
      const j = await res.json().catch(() => null)
      const tracks = res.status() < 400
        ? (j?.tracks ?? []).map((x) => `${ownerOf(x.trackName)}${x.mid ? `@${x.mid}` : ''}${x.errorCode ? `!${x.errorCode}` : ''}`)
        : [...requested, `(${j?.error ?? 'error'})`]
      subsLog.push({ t, who: label, status: res.status(), tracks })
    }
    if (res.status() < 400) return
    const body = await res.text().catch(() => '')
    httpErrors.push({ t, who: label, status: res.status(), path: path.replace(/\/api\/rooms\/[^/]+/, '/api/rooms/:id'), body: body.slice(0, 120) })
  })
  page.on('pageerror', (e) => httpErrors.push({ t: Date.now(), who: label, status: 'pageerror', path: '', body: e.message.slice(0, 160) }))
  page.on('console', (m) => {
    if (m.text().startsWith('[sfu]')) sfuLogs.push({ who: label, text: m.text().slice(0, 200) })
  })
  page.on('websocket', (ws) => {
    if (!ws.url().includes('/ws?token=')) return
    ws.on('framereceived', (frame) => {
      let msg
      try {
        msg = JSON.parse(frame.payload)
      } catch {
        return
      }
      const id = (connectionId) => `[${String(connectionId).slice(0, 4)}]`
      const detail =
        msg.type === 'hello' ? `${msg.room?.nombre} ${id(msg.connectionId)}: ${msg.participants.map((p) => `${p.nombre}${id(p.connectionId)}`).join(' ')}`
        : msg.type === 'participant-joined' ? `${msg.participant.nombre}${id(msg.participant.connectionId)}`
        : msg.type === 'participant-left' ? id(msg.connectionId)
        : msg.type === 'track-published' ? `${ownerOf(msg.trackName)}${id(msg.connectionId)}`
        : ['superseded', 'subsala-closed', 'room-closed'].includes(msg.type) ? ''
        : null
      if (detail !== null) wsEvents.push({ t: Date.now(), who: label, type: msg.type, detail })
    })
  })
  await page.goto(url)
  await page.waitForSelector('text=Registro de asistencia', { timeout: 30000 })
  await page.waitForFunction(() => [...document.querySelectorAll('button')].some((b) => b.textContent?.includes('Mic activo') && !b.disabled), null, { timeout: 30000 })
  await page.fill('input[placeholder="María Restrepo"]', nombre)
  await page.fill('input[placeholder="maria@enactuscolombia.org"]', correo)
  await page.click('button[type=submit]')
  await page.waitForSelector('text=Salir', { timeout: 60000 })
  return { ctx, page, nombre }
}

const NAMES = /^(Host|P\d)$/
async function gridState(page) {
  return page.evaluate((re) => {
    const regex = new RegExp(re)
    const spans = [...document.querySelectorAll('span')].filter((s) => regex.test(s.textContent?.trim() ?? ''))
    const names = spans.map((s) => s.textContent.trim())
    const speaking = spans
      .filter((s) => {
        let el = s
        for (let i = 0; i < 6 && el; i++) {
          const cs = getComputedStyle(el)
          if (cs.boxShadow && cs.boxShadow !== 'none') return true
          el = el.parentElement
        }
        return false
      })
      .map((s) => s.textContent.trim())
    const volver = [...document.querySelectorAll('button')].some((b) => b.textContent?.trim() === 'Volver a la principal')
    return { names: [...new Set(names)].sort(), speaking, enSubsala: volver, pcs: window.__pcs.length }
  }, NAMES.source)
}

async function inboundAudio(page) {
  return page.evaluate(async () => {
    const out = {}
    for (const [i, pc] of window.__pcs.entries()) {
      if (pc.connectionState === 'closed') continue
      ;(await pc.getStats()).forEach((r) => {
        if (r.type === 'inbound-rtp' && r.kind === 'audio') out[`${i}:${r.id}`] = r.bytesReceived ?? 0
      })
    }
    return out
  })
}
async function growingAudio(page, ms = 3000) {
  const a = await inboundAudio(page)
  await page.waitForTimeout(ms)
  const b = await inboundAudio(page)
  return Object.keys(b).filter((k) => a[k] !== undefined && b[k] > a[k]).length
}

async function waitFor(fn, ms = 15000, step = 300) {
  const end = Date.now() + ms
  while (Date.now() < end) {
    const v = await fn()
    if (v) return v
    await sleep(step)
  }
  return null
}

async function openPanel(page) {
  if ((await page.locator('aside[aria-label="Subsalas"]').count()) > 0) return
  await page.getByRole('button', { name: /^Subsalas/ }).click()
  await page.waitForSelector('aside[aria-label="Subsalas"]', { timeout: 5000 })
}

async function enterFromPanel(page, roomName) {
  await openPanel(page)
  const t0 = Date.now()
  await page.locator(`button[title="Entrar a ${roomName}"]`).click()
  const wantSubsala = roomName !== 'Sala principal'
  const ok = await waitFor(async () => {
    const s = await gridState(page)
    const moving = await page.evaluate(() => document.body.textContent.includes('Cambiando de sala'))
    return s.enSubsala === wantSubsala && !moving
  }, 20000, 100)
  return ok ? Date.now() - t0 : null
}

async function setGain(page, v) {
  await page.evaluate((x) => { if (window.__gainNode) window.__gainNode.gain.value = x }, v)
}

async function main() {
  const created = (await api('POST', '/api/rooms', { body: { nombre: 'Prueba subsalas E2E' } })).json
  const roomId = created.room.id
  console.log(`sala ${roomId}`)
  const browser = await chromium.launch({ args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required'] })
  const people = {}
  try {
    // --- Entrada: host con su link, 5 participantes con el link normal ---
    people.Host = await openAndJoin(browser, created.hostLink, 'Host', 'host-e2e@s4.test')
    check('la llave de host desaparece de la barra de direcciones', !people.Host.page.url().includes('#host='), people.Host.page.url())
    for (const n of ['P1', 'P2', 'P3', 'P4', 'P5']) {
      await sleep(500)
      people[n] = await openAndJoin(browser, created.link, n, `${n.toLowerCase()}-e2e@s4.test`)
    }
    const hostGrid0 = await waitFor(async () => { const s = await gridState(people.Host.page); return s.names.length === 5 ? s : null })
    check('el host ve a los 5 participantes en la principal', !!hostGrid0, JSON.stringify((await gridState(people.Host.page)).names))
    const p1HasButton = (await people.P1.page.getByRole('button', { name: /^Subsalas/ }).count()) > 0
    check('sin subsalas creadas, un participante no ve el botón de subsalas', !p1HasButton)

    // --- El host crea 2 subsalas ---
    await openPanel(people.Host.page)
    await people.Host.page.locator('#subsalas-cantidad').fill('2')
    await people.Host.page.getByRole('button', { name: 'Crear', exact: true }).click()
    const created2 = await waitFor(async () => (await people.Host.page.locator('button[title="Cerrar Subsala 2"]').count()) > 0)
    check('el host crea 2 subsalas desde el panel', !!created2)
    await people.Host.page.getByRole('button', { name: 'Cerrar panel' }).click()
    const seen = await waitFor(async () => (await people.P1.page.getByRole('button', { name: 'Subsalas (2)' }).count()) > 0, 10000)
    check('los participantes ven "Subsalas (2)" sin recargar (aviso subsalas-changed)', !!seen)

    // --- Movimientos ---
    marks['empiezan los movimientos'] = Date.now()
    const t1 = await enterFromPanel(people.P1.page, 'Subsala 1')
    const t2 = await enterFromPanel(people.P2.page, 'Subsala 1')
    const t3 = await enterFromPanel(people.P3.page, 'Subsala 2')
    check('P1 y P2 entran a Subsala 1 y P3 a Subsala 2', t1 !== null && t2 !== null && t3 !== null, `P1 ${t1} ms, P2 ${t2} ms, P3 ${t3} ms`)
    const pcsAfterMove = await Promise.all(['P1', 'P2', 'P3'].map((n) => people[n].page.evaluate(() => window.__pcs.length)))
    check('moverse no crea otra PeerConnection (misma sesión SFU)', pcsAfterMove.every((n) => n === 1), `PeerConnections: ${pcsAfterMove.join(', ')}`)

    const iso = await waitFor(async () => {
      const [h, p1, p3] = await Promise.all([gridState(people.Host.page), gridState(people.P1.page), gridState(people.P3.page)])
      const ok = JSON.stringify(h.names) === JSON.stringify(['P4', 'P5']) && JSON.stringify(p1.names) === JSON.stringify(['P2']) && p3.names.length === 0
      return ok ? { h, p1, p3 } : null
    }, 15000)
    const snap = await Promise.all([gridState(people.Host.page), gridState(people.P1.page), gridState(people.P3.page)])
    check('cada sala ve solo a su gente: principal {P4,P5}, Subsala 1 {P2} para P1, Subsala 2 nadie para P3', !!iso, `host ${snap[0].names}, P1 ${snap[1].names}, P3 ${snap[2].names}`)

    const audio = {}
    for (const n of ['Host', 'P1', 'P3']) audio[n] = await growingAudio(people[n].page)
    check('el audio sigue a la sala: el host recibe 2 (P4, P5), P1 recibe 1 (P2), P3 recibe 0', audio.Host === 2 && audio.P1 === 1 && audio.P3 === 0, JSON.stringify(audio))
    if (!(audio.Host === 2 && audio.P1 === 1 && audio.P3 === 0)) dumpHistory(['Host', 'P1', 'P3'], Date.now(), 45000, 0)

    await setGain(people.P2.page, 0.9)
    const marked = await waitFor(async () => (await gridState(people.P1.page)).speaking.includes('P2'), 8000, 250)
    const hostAudioWhileP2Speaks = await growingAudio(people.Host.page, 2000)
    await setGain(people.P2.page, 0)
    check('dentro de la subsala, P1 ve a P2 marcado cuando habla; el host sigue recibiendo solo 2 audios', !!marked && hostAudioWhileP2Speaks === 2, `audios del host: ${hostAudioWhileP2Speaks}`)

    // --- Volver a la principal ---
    const tBack0 = Date.now()
    await people.P2.page.getByRole('button', { name: 'Volver a la principal' }).click()
    const back = await waitFor(async () => {
      const [p2, h] = await Promise.all([gridState(people.P2.page), gridState(people.Host.page)])
      return !p2.enSubsala && h.names.includes('P2')
    }, 15000, 100)
    const p1Alone = await waitFor(async () => (await people.P1.page.evaluate(() => document.body.textContent.includes('Todavía no hay nadie más en esta subsala'))), 8000)
    check('P2 vuelve a la principal con el botón y el host lo ve; P1 queda solo en Subsala 1', !!back && !!p1Alone, `${Date.now() - tBack0} ms`)

    // --- El host cierra Subsala 1 con P1 adentro ---
    await openPanel(people.Host.page)
    await people.Host.page.locator('button[title="Cerrar Subsala 1"]').click()
    const returned = await waitFor(async () => {
      const [p1, h] = await Promise.all([gridState(people.P1.page), gridState(people.Host.page)])
      return !p1.enSubsala && h.names.includes('P1')
    }, 20000, 200)
    const noticeSeen = await people.P1.page.evaluate(() => document.body.textContent.includes('El host cerró esta subsala'))
    check('al cerrar Subsala 1, P1 vuelve solo a la principal y ve el aviso', !!returned && noticeSeen, `aviso ${noticeSeen}`)
    await people.Host.page.getByRole('button', { name: 'Cerrar panel' }).click().catch(() => {})

    // --- Reconexión: vuelve a la sala donde lo ubica D1 (Subsala 2) ---
    await people.P3.page.evaluate(() => window.__sigSockets.at(-1).close())
    const reconnecting = await waitFor(async () => people.P3.page.evaluate(() => document.body.textContent.includes('Reconectando')), 5000, 100)
    const recovered = await waitFor(async () => {
      const s = await gridState(people.P3.page)
      const stillReconnecting = await people.P3.page.evaluate(() => document.body.textContent.includes('Reconectando'))
      return s.enSubsala && !stillReconnecting && s.pcs === 2 ? s : null
    }, 30000, 250)
    const chip = await people.P3.page.evaluate(() => [...document.querySelectorAll('span')].some((s) => s.textContent?.trim() === 'Subsala 2'))
    check('si se corta la señalización en Subsala 2, reconecta y vuelve a Subsala 2 (no a la principal)', !!reconnecting && !!recovered && chip, `aviso ${!!reconnecting}, PeerConnections ${(await gridState(people.P3.page)).pcs}`)

    // --- Otra pestaña ---
    people.P4b = await openAndJoin(browser, created.link, 'P4', 'p4-e2e@s4.test', 'P4b')
    const superseded = await waitFor(async () => people.P4.page.evaluate(() => document.body.textContent.includes('Abriste la reunión en otro lado')), 15000)
    const closes = await people.P4.page.evaluate(() => window.__sigCloses ?? [])
    check('entrar con la misma persona desde otra pestaña deja la primera en "Abriste la reunión en otro lado"', !!superseded, `cierres vistos en la pestaña vieja: ${JSON.stringify(closes)}`)

    // --- El host termina la reunión con gente en una subsala ---
    marks['P5 empieza a moverse a Subsala 2'] = Date.now()
    await enterFromPanel(people.P5.page, 'Subsala 2')
    marks['P5 ya está en Subsala 2'] = Date.now()
    await openPanel(people.Host.page)
    await people.Host.page.getByRole('button', { name: 'Terminar reunión para todos' }).click()
    await people.Host.page.getByRole('button', { name: 'Confirmar: terminar para todos' }).click()
    marks['el host termina la reunión'] = Date.now()
    const closedFor = await waitFor(async () => {
      const flags = await Promise.all(['Host', 'P1', 'P2', 'P3', 'P4b', 'P5'].map((n) => people[n].page.evaluate(() => document.body.textContent.includes('Sala cerrada'))))
      return flags.every(Boolean) ? flags : null
    }, 20000, 300)
    const flagsNow = await Promise.all(['Host', 'P1', 'P2', 'P3', 'P4b', 'P5'].map(async (n) => `${n}:${await people[n].page.evaluate(() => document.body.textContent.includes('Sala cerrada'))}`))
    check('al terminar la reunión, todos (también quienes estaban en Subsala 2) ven "Sala cerrada"', !!closedFor, flagsNow.join(' '))

    // --- Asistencia ---
    const att = (await api('GET', `/api/rooms/${roomId}/attendance?grupo=1`)).json
    const byName = (n) => att.attendance.filter((a) => a.user_nombre === n)
    const p1Rows = byName('P1')
    const p3Rows = byName('P3')
    const reasonsP1 = p1Rows.map((r) => `${r.room_nombre}:${r.left_reason}`)
    check('asistencia de P1: principal (moved), Subsala 1 (room_closed), principal (room_closed)', JSON.stringify(reasonsP1) === JSON.stringify(['Prueba subsalas E2E:moved', 'Subsala 1:room_closed', 'Prueba subsalas E2E:room_closed']), JSON.stringify(reasonsP1))
    check('la reconexión rápida de P3 no duplicó su fila en Subsala 2', p3Rows.filter((r) => r.room_nombre === 'Subsala 2').length === 1, JSON.stringify(p3Rows.map((r) => `${r.room_nombre}:${r.left_reason}`)))
    check('no queda asistencia abierta al terminar la reunión', att.attendance.every((a) => a.left_at))
    const resumenP1 = att.resumen.find((r) => r.nombre === 'P1')
    check('el resumen suma el tiempo de P1 en todas sus salas', !!resumenP1 && resumenP1.tramos === 3 && resumenP1.totalMs > 0, resumenP1 && `${resumenP1.tramos} tramos, ${Math.round(resumenP1.totalMs / 1000)} s`)
  } finally {
    await browser.close().catch(() => {})
    await api('POST', `/api/rooms/${roomId}/close`, { headers: { 'x-host-key': created.hostKey } }).catch(() => {})
  }
}

try {
  await main()
} catch (err) {
  check('la prueba corrió completa', false, err.stack?.split('\n').slice(0, 4).join(' | '))
} finally {
  const grouped = {}
  for (const e of httpErrors) {
    const key = `${e.who} ${e.status} ${e.path} ${e.body}`
    grouped[key] = (grouped[key] ?? 0) + 1
  }
  console.log('\nerrores HTTP y de página:', Object.keys(grouped).length ? JSON.stringify(grouped, null, 1) : 'ninguno')
  // Cada error, ubicado respecto del momento marcado más cercano.
  for (const e of httpErrors) {
    const near = Object.entries(marks).sort((a, b) => Math.abs(e.t - a[1]) - Math.abs(e.t - b[1]))[0]
    console.log(`  ${e.who} ${e.status} ${e.path}: ${near ? `${((e.t - near[1]) / 1000).toFixed(2)} s respecto de "${near[0]}"` : 'antes de cualquier marca'}`)
  }
  for (const e of httpErrors.filter((x) => x.path.includes('/sfu/'))) {
    console.log(`\ncontexto de ${e.who} ${e.status} ${e.path}:`)
    dumpHistory([e.who], e.t, 12000, 3000)
  }
  console.log('\nmensajes [sfu] de la app:', sfuLogs.length ? '' : 'ninguno')
  for (const l of sfuLogs) console.log(`  ${l.who}: ${l.text}`)
  const failed = results.filter((r) => !r.ok)
  console.log(`\n${results.length - failed.length}/${results.length} PASS`)
  process.exit(failed.length ? 1 : 0)
}
