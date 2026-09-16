import { chromium } from 'playwright'

// Verificación de un despliegue con navegadores reales: dos personas entran,
// se ven, el host crea una subsala, se mueven, se escuchan ahí adentro, el host
// la cierra y después termina la reunión.
//
// Apunta a donde se le diga, así sirve para local y para producción:
//   API_BASE=https://api.tu-dominio APP_BASE=https://tu-frontend node verificacion-despliegue.mjs
//
// Deja datos reales en la base a la que apunte: dos usuarios, sus filas de
// asistencia y una sala cerrada con su subsala.
const API = process.env.API_BASE ?? 'http://localhost:8787'
const APP = process.env.APP_BASE ?? 'http://localhost:5173'
const SUFIJO = process.env.EMAIL_SUFFIX ?? '@verificacion.test'
const results = []
const httpErrors = []
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
    signal: AbortSignal.timeout(30000),
  })
  return { status: res.status, json: await res.json().catch(() => null) }
}

// Medios sintéticos: video de canvas con el nombre y un oscilador en silencio
// que sube de volumen cuando esa persona "habla".
function initScript(label) {
  return `
  (() => {
    window.__pcs = [];
    const OrigPC = window.RTCPeerConnection;
    class WrappedPC extends OrigPC { constructor(...a) { super(...a); window.__pcs.push(this); } }
    window.RTCPeerConnection = WrappedPC;
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
        const ctx = new AudioContext();
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

async function entrar(browser, url, nombre, correo) {
  const ctx = await browser.newContext({ viewport: { width: 1360, height: 860 }, permissions: ['camera', 'microphone'] })
  await ctx.addInitScript(initScript(nombre))
  const page = await ctx.newPage()
  page.on('response', async (res) => {
    if (res.status() < 400) return
    const body = await res.text().catch(() => '')
    httpErrors.push({ who: nombre, status: res.status(), path: new URL(res.url()).pathname.replace(/\/api\/rooms\/[^/]+/, '/api/rooms/:id'), body: body.slice(0, 140) })
  })
  page.on('pageerror', (e) => httpErrors.push({ who: nombre, status: 'pageerror', path: e.message.slice(0, 120) }))
  await page.goto(url)
  await page.waitForSelector('text=Registro de asistencia', { timeout: 60000 })
  await page.waitForFunction(() => [...document.querySelectorAll('button')].some((b) => b.textContent?.includes('Mic activo') && !b.disabled), null, { timeout: 60000 })
  await page.fill('input[placeholder="María Restrepo"]', nombre)
  await page.fill('input[placeholder="maria@enactuscolombia.org"]', correo)
  await page.click('button[type=submit]')
  await page.waitForSelector('text=Salir', { timeout: 90000 })
  return { ctx, page, nombre }
}

const NOMBRES = /^(Ana|Beto)$/
async function grid(page) {
  return page.evaluate((re) => {
    const regex = new RegExp(re)
    const spans = [...document.querySelectorAll('span')].filter((s) => regex.test(s.textContent?.trim() ?? ''))
    const hablando = spans
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
      nombres: [...new Set(spans.map((s) => s.textContent.trim()))].sort(),
      hablando,
      enSubsala: [...document.querySelectorAll('button')].some((b) => b.textContent?.trim() === 'Volver a la principal'),
      pcs: window.__pcs.length,
    }
  }, NOMBRES.source)
}

async function esperar(fn, ms = 30000, paso = 300) {
  const fin = Date.now() + ms
  while (Date.now() < fin) {
    const v = await fn()
    if (v) return v
    await sleep(paso)
  }
  return null
}

async function abrirPanel(page) {
  if ((await page.locator('aside[aria-label="Subsalas"]').count()) > 0) return
  await page.getByRole('button', { name: /^Subsalas/ }).click()
  await page.waitForSelector('aside[aria-label="Subsalas"]', { timeout: 15000 })
}

async function entrarA(page, sala) {
  await abrirPanel(page)
  await page.locator(`button[title="Entrar a ${sala}"]`).click()
  return esperar(async () => {
    const s = await grid(page)
    const moviendo = await page.evaluate(() => document.body.textContent.includes('Cambiando de sala'))
    return s.enSubsala === (sala !== 'Sala principal') && !moviendo
  }, 45000, 200)
}

const gain = (page, v) => page.evaluate((x) => { if (window.__gainNode) window.__gainNode.gain.value = x }, v)

async function main() {
  console.log(`API ${API}\napp ${APP}`)
  const sello = Date.now()
  const creada = (await api('POST', '/api/rooms', { body: { nombre: 'Verificación de despliegue' } })).json
  const sala = creada.room.id
  const browser = await chromium.launch({ args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required'] })
  try {
    const ana = await entrar(browser, `${APP}/r/${sala}#host=${creada.hostKey}`, 'Ana', `ana-${sello}${SUFIJO}`)
    const beto = await entrar(browser, `${APP}/r/${sala}`, 'Beto', `beto-${sello}${SUFIJO}`)
    const juntos = await esperar(async () => {
      const [a, b] = await Promise.all([grid(ana.page), grid(beto.page)])
      return a.nombres.includes('Beto') && b.nombres.includes('Ana')
    })
    check('las dos personas entran a la sala principal y se ven', !!juntos)

    await abrirPanel(ana.page)
    await ana.page.locator('#subsalas-cantidad').fill('1')
    await ana.page.getByRole('button', { name: 'Crear', exact: true }).click()
    const creadaSub = await esperar(async () => (await ana.page.locator('button[title="Cerrar Subsala 1"]').count()) > 0, 20000)
    await ana.page.getByRole('button', { name: 'Cerrar panel' }).click()
    const vista = await esperar(async () => (await beto.page.getByRole('button', { name: 'Subsalas (1)' }).count()) > 0, 20000)
    check('el host crea una subsala y la otra persona la ve sin recargar', !!creadaSub && !!vista)

    const tBeto = Date.now()
    const movidoBeto = await entrarA(beto.page, 'Subsala 1')
    const solos = await esperar(async () => {
      const [a, b] = await Promise.all([grid(ana.page), grid(beto.page)])
      return !a.nombres.includes('Beto') && b.nombres.length === 0
    }, 20000)
    check('al entrar a la subsala, cada una queda sola en su sala', !!movidoBeto && !!solos, `${Date.now() - tBeto} ms`)

    const movidaAna = await entrarA(ana.page, 'Subsala 1')
    const reunidas = await esperar(async () => {
      const [a, b] = await Promise.all([grid(ana.page), grid(beto.page)])
      return a.nombres.includes('Beto') && b.nombres.includes('Ana')
    }, 25000)
    const pcs = await Promise.all([ana.page.evaluate(() => window.__pcs.length), beto.page.evaluate(() => window.__pcs.length)])
    check('el host también entra y se ven ahí, sin reconectar', !!movidaAna && !!reunidas && pcs.every((n) => n === 1), `PeerConnections: ${pcs.join(', ')}`)

    await gain(beto.page, 0.9)
    const marcado = await esperar(async () => (await grid(ana.page)).hablando.includes('Beto'), 30000, 250)
    await gain(beto.page, 0)
    check('dentro de la subsala, el audio llega: el host marca a Beto cuando habla', !!marcado)

    await ana.page.getByRole('button', { name: 'Volver a la principal' }).click()
    await esperar(async () => !(await grid(ana.page)).enSubsala, 30000)
    await abrirPanel(ana.page)
    await ana.page.locator('button[title="Cerrar Subsala 1"]').click()
    const volvio = await esperar(async () => {
      const [a, b] = await Promise.all([grid(ana.page), grid(beto.page)])
      return !b.enSubsala && a.nombres.includes('Beto')
    }, 45000)
    check('al cerrar la subsala, quien estaba adentro vuelve solo a la principal', !!volvio)

    await abrirPanel(ana.page)
    await ana.page.getByRole('button', { name: 'Terminar reunión para todos' }).click()
    await ana.page.getByRole('button', { name: 'Confirmar: terminar para todos' }).click()
    const cerrada = await esperar(async () => {
      const flags = await Promise.all([ana.page, beto.page].map((p) => p.evaluate(() => document.body.textContent.includes('Sala cerrada'))))
      return flags.every(Boolean)
    }, 30000)
    check('terminar la reunión cierra todo y las dos ven "Sala cerrada"', !!cerrada)

    const att = (await api('GET', `/api/rooms/${sala}/attendance?grupo=1`)).json
    const abiertas = att?.attendance?.filter((a) => !a.left_at).length ?? -1
    check('no queda asistencia abierta y el resumen tiene a las dos', abiertas === 0 && att?.resumen?.length === 2, `${att?.attendance?.length} filas, ${att?.resumen?.length} personas`)
    console.log(`sala verificada: ${sala}`)
  } finally {
    await browser.close().catch(() => {})
    await api('POST', `/api/rooms/${sala}/close`, { headers: { 'x-host-key': creada.hostKey } }).catch(() => {})
  }
}

try {
  await main()
} catch (err) {
  check('la verificación corrió completa', false, err.stack?.split('\n').slice(0, 3).join(' | '))
} finally {
  console.log('\nerrores HTTP y de página:', httpErrors.length ? JSON.stringify(httpErrors).slice(0, 400) : 'ninguno')
  const fallidos = results.filter((r) => !r.ok)
  console.log(`\n${results.length - fallidos.length}/${results.length} PASS`)
  process.exit(fallidos.length ? 1 : 0)
}
