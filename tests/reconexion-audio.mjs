import { chromium } from 'playwright'

// Después de que alguien se reconecta (PeerConnection y sesión SFU nuevas),
// ¿los demás lo vuelven a escuchar de verdad, y esa persona a ellos? Se mide en
// la app, no solo en RTP: el borde de "hablando" necesita que el audio se
// decodifique por su <audio> y pase por el analizador de esa conexión.
// Real: Chromium, WebRTC, Worker/Durable Objects/D1 de wrangler dev y el SFU de
// Cloudflare. Simulado: las personas y sus medios (canvas y oscilador).
const API = 'http://localhost:8787'
const results = []
const httpErrors = []
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
    window.__audios = [];
    const OrigPC = window.RTCPeerConnection;
    class WrappedPC extends OrigPC {
      constructor(...a) { super(...a); window.__pcs.push(this); }
    }
    window.RTCPeerConnection = WrappedPC;
    const OrigWS = window.WebSocket;
    class WrappedWS extends OrigWS {
      constructor(url, ...rest) {
        super(url, ...rest);
        if (String(url).includes('/ws?token=')) window.__sigSockets.push(this);
      }
    }
    window.WebSocket = WrappedWS;
    const OrigAudio = window.Audio;
    function WrappedAudio(...a) { const el = new OrigAudio(...a); window.__audios.push(el); return el; }
    WrappedAudio.prototype = OrigAudio.prototype;
    window.Audio = WrappedAudio;
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

async function openAndJoin(browser, url, nombre, correo) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, permissions: ['camera', 'microphone'] })
  await ctx.addInitScript(initScript(nombre))
  const page = await ctx.newPage()
  page.on('response', async (res) => {
    if (res.status() < 400) return
    const body = await res.text().catch(() => '')
    httpErrors.push({ who: nombre, status: res.status(), path: new URL(res.url()).pathname.replace(/\/api\/rooms\/[^/]+/, '/api/rooms/:id'), body: body.slice(0, 120) })
  })
  page.on('pageerror', (e) => httpErrors.push({ who: nombre, status: 'pageerror', path: '', body: e.message.slice(0, 160) }))
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
    return {
      names: [...new Set(spans.map((s) => s.textContent.trim()))].sort(),
      speaking,
      reconnecting: document.body.textContent.includes('Reconectando'),
      pcs: window.__pcs.length,
      openPcs: window.__pcs.filter((pc) => pc.connectionState !== 'closed').length,
      playingAudios: window.__audios.filter((el) => el.srcObject && !el.paused && el.srcObject.getAudioTracks().some((t) => t.readyState === 'live')).length,
    }
  }, NAMES.source)
}

async function growingAudio(page, ms = 3000) {
  const snap = () =>
    page.evaluate(async () => {
      const out = {}
      for (const [i, pc] of window.__pcs.entries()) {
        if (pc.connectionState === 'closed') continue
        ;(await pc.getStats()).forEach((r) => {
          if (r.type === 'inbound-rtp' && r.kind === 'audio') out[`${i}:${r.id}`] = r.bytesReceived ?? 0
        })
      }
      return out
    })
  const a = await snap()
  await page.waitForTimeout(ms)
  const b = await snap()
  return Object.keys(b).filter((k) => a[k] !== undefined && b[k] > a[k]).length
}

async function waitFor(fn, ms = 15000, step = 250) {
  const end = Date.now() + ms
  while (Date.now() < end) {
    const v = await fn()
    if (v) return v
    await sleep(step)
  }
  return null
}

const setGain = (page, v) => page.evaluate((x) => { if (window.__gainNode) window.__gainNode.gain.value = x }, v)

// Hace hablar a `speaker` y mide cuánto tarda cada oyente en marcarlo.
async function speakAndMeasure(speaker, listeners, ms) {
  const t0 = Date.now()
  await setGain(speaker.page, 0.9)
  const times = {}
  await waitFor(async () => {
    for (const l of listeners) {
      if (times[l.nombre] !== undefined) continue
      if ((await gridState(l.page)).speaking.includes(speaker.nombre)) times[l.nombre] = Date.now() - t0
    }
    return listeners.every((l) => times[l.nombre] !== undefined)
  }, ms)
  await setGain(speaker.page, 0)
  await waitFor(async () => {
    for (const l of listeners) if ((await gridState(l.page)).speaking.includes(speaker.nombre)) return false
    return true
  }, 8000)
  return times
}
const fmt = (times, listeners) => listeners.map((l) => `${l.nombre} ${times[l.nombre] !== undefined ? `${times[l.nombre]} ms` : 'nunca'}`).join(', ')

async function main() {
  const created = (await api('POST', '/api/rooms', { body: { nombre: 'Prueba reconexión y audio' } })).json
  const browser = await chromium.launch({ args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required'] })
  try {
    const Host = await openAndJoin(browser, created.link, 'Host', 'host-reconexion@s4.test')
    const P1 = await openAndJoin(browser, created.link, 'P1', 'p1-reconexion@s4.test')
    const P2 = await openAndJoin(browser, created.link, 'P2', 'p2-reconexion@s4.test')
    const all = [Host, P1, P2]
    const others = (p) => all.filter((x) => x !== p)
    const settled = await waitFor(async () => {
      const g = await Promise.all(all.map((p) => gridState(p.page)))
      return g.every((s, i) => JSON.stringify(s.names) === JSON.stringify(others(all[i]).map((x) => x.nombre).sort()))
    }, 20000)
    check('los tres se ven entre sí', !!settled)

    const before = await speakAndMeasure(P2, [Host, P1], 15000)
    check('antes de reconectar, Host y P1 marcan a P2 cuando habla', Object.keys(before).length === 2, fmt(before, [Host, P1]))

    // --- P2 pierde la señalización y la app reconstruye su conexión ---
    const tCut = Date.now()
    await P2.page.evaluate(() => window.__sigSockets.at(-1).close())
    const sawReconnecting = await waitFor(async () => (await gridState(P2.page)).reconnecting, 8000, 100)
    const recovered = await waitFor(async () => {
      const s = await gridState(P2.page)
      return !s.reconnecting && s.pcs === 2 && s.openPcs === 1 && JSON.stringify(s.names) === JSON.stringify(['Host', 'P1']) ? s : null
    }, 30000)
    check('P2 muestra "Reconectando…" y vuelve con una PeerConnection nueva (la vieja cerrada)', !!sawReconnecting && !!recovered, recovered ? `${Date.now() - tCut} ms` : JSON.stringify(await gridState(P2.page)))
    const seenAgain = await waitFor(async () => (await Promise.all([Host, P1].map((p) => gridState(p.page)))).every((s) => s.names.includes('P2')), 15000)
    check('Host y P1 vuelven a ver a P2 en la grilla', !!seenAgain)

    const after = await speakAndMeasure(P2, [Host, P1], 30000)
    check('después de reconectar, Host y P1 vuelven a marcar a P2 cuando habla', Object.keys(after).length === 2, fmt(after, [Host, P1]))
    const reverse = await speakAndMeasure(Host, [P2], 30000)
    check('P2, ya reconectado, marca a Host cuando habla', Object.keys(reverse).length === 1, fmt(reverse, [P2]))

    const final = await Promise.all(all.map(async (p) => ({ nombre: p.nombre, rtp: await growingAudio(p.page), elementos: (await gridState(p.page)).playingAudios })))
    check(
      'cada uno recibe 2 audios con bytes creciendo y tiene exactamente 2 <audio> sonando (ninguno de la conexión vieja de P2)',
      final.every((f) => f.rtp === 2 && f.elementos === 2),
      final.map((f) => `${f.nombre}: RTP ${f.rtp}, <audio> ${f.elementos}`).join(' · ')
    )
  } finally {
    await browser.close().catch(() => {})
    await api('POST', `/api/rooms/${created.room.id}/close`, { headers: { 'x-host-key': created.hostKey } }).catch(() => {})
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
  const failed = results.filter((r) => !r.ok)
  console.log(`\n${results.length - failed.length}/${results.length} PASS`)
  process.exit(failed.length ? 1 : 0)
}
