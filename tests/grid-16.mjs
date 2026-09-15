import { chromium } from 'playwright';
import fs from 'node:fs';

// Semana 4 -- requisito previo, segunda versión del arnés.
//
// Qué es real y qué es simulado: cada participante es una sesión real
// (Chromium real, WebRTC real, Durable Object, D1 y SFU de Cloudflare
// reales). Lo simulado es la persona y sus medios: video = canvas animado
// con el nombre, audio = oscilador en silencio digital salvo cuando "habla".
//
// Por qué medios más livianos que la primera corrida: 16 clientes con video
// 320x240 y audio tonal saturaron UNA laptop y UNA conexión compartida
// (llamadas a Cloudflare de 3 a 47 segundos, 5 reconexiones). Eso no
// representa a 16 personas con redes independientes. Con video 160x120 a 3fps
// y audio en silencio digital (salvo quien habla) la lógica bajo prueba
// (paginación, cap de video, active speaker, llegada de audio) es la misma,
// pero el ancho de banda total del arnés baja varias veces.
//
// FAKE_AUDIO_OUT=1 agrega --disable-audio-output (salida de audio falsa). Un
// sondeo aislado mostró que 34 AudioContexts simples no fallan con ni sin el
// flag, así que queda apagado por defecto.
//
// SPEAKER_PROBE=1 hace que P1 "hable" después de la fase estable y mide la
// cadena completa: nivel de la fuente en P1, RMS que llega al observador y si
// la app lo marca como hablando.
//
// Instrumentación de prueba (no toca la app): transiciones de
// RTCPeerConnection, cierres del WebSocket de señalización, RTT y pérdida; una
// línea de tiempo tomada desde Playwright que sobrevive a una recarga; el dueño
// de cada track recibido (respuestas reales de /register y /sfu/subscribe); los
// tracks rechazados dentro de respuestas 200 de publish y subscribe; y el
// estado de la fuente de audio propia de cada pestaña.

const N_TOTAL = Number(process.env.N_TOTAL ?? 16);
const N_PUB = N_TOTAL - 1;
const JOIN_GAP_MS = Number(process.env.JOIN_GAP_MS ?? 600);
const LABEL = process.env.LABEL ?? `light-n${N_TOTAL}`;
const FAKE_AUDIO_OUT = process.env.FAKE_AUDIO_OUT === '1';
const SPEAKER_PROBE = process.env.SPEAKER_PROBE === '1';
const API = 'http://localhost:8787';
const OUT_DIR = new URL('./resultados/', import.meta.url);
const args = ['--no-sandbox', '--autoplay-policy=no-user-gesture-required', ...(FAKE_AUDIO_OUT ? ['--disable-audio-output'] : [])];

function initScript(label) {
  return `
  (() => {
    window.__pcs = [];
    window.__netEvents = [];
    // Subclases, no funciones envoltorio: conservan constantes estáticas y
    // prototipo, así la instrumentación no puede cambiar el comportamiento de
    // la app ni del cliente de Vite.
    const OrigPC = window.RTCPeerConnection;
    class WrappedPC extends OrigPC {
      constructor(...a) {
        super(...a);
        const idx = window.__pcs.push(this) - 1;
        this.addEventListener('connectionstatechange', () => {
          window.__netEvents.push({ t: Date.now(), kind: 'pc', pc: idx, state: this.connectionState });
          console.log('[diag] pc' + idx + ' connection=' + this.connectionState);
        });
        this.addEventListener('iceconnectionstatechange', () => {
          console.log('[diag] pc' + idx + ' ice=' + this.iceConnectionState);
        });
      }
    }
    window.RTCPeerConnection = WrappedPC;

    const OrigWS = window.WebSocket;
    class WrappedWS extends OrigWS {
      constructor(url, ...rest) {
        super(url, ...rest);
        const kind = String(url).includes('/ws?token=') ? 'sig' : 'otro';
        this.addEventListener('close', (e) => {
          if (kind === 'sig') window.__netEvents.push({ t: Date.now(), kind: 'ws-close', code: e.code });
          console.log('[diag] ws ' + kind + ' close code=' + e.code + ' clean=' + e.wasClean);
        });
      }
    }
    window.WebSocket = WrappedWS;

    window.__pubAudioCtx = null;
    navigator.mediaDevices.getUserMedia = async (constraints) => {
      const wantVideo = !constraints || !!constraints.video;
      const wantAudio = !constraints || !!constraints.audio;
      const tracks = [];
      if (wantVideo) {
        const canvas = document.createElement('canvas');
        canvas.width = 160; canvas.height = 120;
        const g = canvas.getContext('2d');
        let hue = Math.floor(Math.random() * 360);
        const draw = () => {
          hue = (hue + 11) % 360;
          g.fillStyle = 'hsl(' + hue + ',55%,40%)';
          g.fillRect(0, 0, 160, 120);
          g.fillStyle = '#fff';
          g.font = '40px sans-serif';
          g.fillText(${JSON.stringify(label)}, 12, 76);
        };
        draw();
        setInterval(draw, 400);
        tracks.push(canvas.captureStream(3).getVideoTracks()[0]);
      }
      if (wantAudio) {
        const ctx = window.__pubAudioCtx || new AudioContext();
        window.__pubAudioCtx = ctx;
        ctx.addEventListener('error', () => console.error('[diag] AudioContext del micrófono sintético: error'));
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
  })();`;
}

const errorLog = [];
const timeline = [];
const livePages = {};
const phases = {};
const userIdToName = new Map();
const nameToUserId = new Map();
const midToTrack = {}; // participante -> Map(mid -> trackName)
const REJECTED_KINDS = new Set(['subscribe-track-error', 'publish-track-error']);

function mark(name) {
  phases[name] = Date.now();
  console.log(`\n=== ${name} ===`);
}
function trackOwner(trackName) {
  const m = /^(.*)-(audio|video|screen)$/.exec(trackName ?? '');
  if (!m) return String(trackName);
  return `${userIdToName.get(m[1]) ?? m[1].slice(0, 8)}:${m[2]}`;
}
const dedupe = (arr) => arr.filter((x, i) => i === 0 || x !== arr[i - 1]);

function printTimeline() {
  const t0 = phases.join ?? timeline[0]?.t ?? Date.now();
  const rows = timeline.filter((e) => !REJECTED_KINDS.has(e.kind) && !(e.kind === 'console.debug' && /\[vite\] (connecting|connected)/.test(e.detail)));
  console.log(`\n=== línea de tiempo (${rows.length} eventos) ===`);
  for (const e of rows) console.log(`  +${((e.t - t0) / 1000).toFixed(1).padStart(6)}s ${e.who.padEnd(7)} ${e.kind} ${e.detail}`);
  const rejected = timeline.filter((e) => REJECTED_KINDS.has(e.kind));
  const grouped = {};
  for (const e of rejected) {
    const key = `${e.kind === 'publish-track-error' ? 'PUBLISH ' : ''}${e.who} <- ${e.detail}`;
    grouped[key] = (grouped[key] ?? 0) + 1;
  }
  console.log(`\n=== tracks rechazados dentro de respuestas 200 (publish y subscribe): ${rejected.length} ===`);
  if (rejected.length) {
    const byCount = {};
    for (const [k, n] of Object.entries(grouped)) (byCount[n] ??= []).push(k);
    for (const [n, keys] of Object.entries(byCount).sort((a, b) => Number(b[0]) - Number(a[0]))) console.log(`  ${n} vez/veces: ${keys.join(' | ')}`);
  }
}

async function join(browser, link, nombre, correo) {
  const t0 = Date.now();
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, permissions: ['camera', 'microphone'] });
  await ctx.addInitScript(initScript(nombre));
  const page = await ctx.newPage();
  livePages[nombre] = page;
  const tl = (kind, detail = '') => timeline.push({ t: Date.now(), who: nombre, kind, detail });

  page.on('response', async (res) => {
    const path = new URL(res.url()).pathname;
    if (res.status() < 400) {
      // Solo /register trae el nombre de la persona: desde la Semana 4, /reauth
      // devuelve el nombre de la sala a la que vuelve (antes, una reconexión
      // re-etiquetaba los tracks de esa persona con el nombre de la sala).
      if (path.endsWith('/register') && res.request().method() === 'POST') {
        try {
          const j = await res.json();
          if (j.userId) { userIdToName.set(j.userId, j.nombre); nameToUserId.set(j.nombre, j.userId); }
        } catch {}
      } else if (path.endsWith('/sfu/subscribe')) {
        try {
          const j = await res.json();
          const map = (midToTrack[nombre] ??= new Map());
          for (const t of j.tracks ?? []) {
            if (t.mid && t.trackName) map.set(String(t.mid), t.trackName);
            if (t.errorCode || !t.mid) tl('subscribe-track-error', `${trackOwner(t.trackName)} ${t.errorCode ?? 'sin mid'}`);
          }
        } catch {}
      } else if (path.endsWith('/sfu/publish')) {
        try {
          const j = await res.json();
          for (const t of j.tracks ?? []) {
            if (t.errorCode) tl('publish-track-error', `${trackOwner(t.trackName)} ${t.errorCode} ${t.errorDescription ?? ''}`.trim());
          }
          tl('publish', (j.tracks ?? []).map((t) => `${trackOwner(t.trackName)}@mid${t.mid ?? '?'}${t.errorCode ? '(ERROR)' : ''}`).join(' ') || '(respuesta sin tracks)');
        } catch {}
      }
      return;
    }
    let body = '';
    try { body = await res.text(); } catch {}
    errorLog.push({
      t: Date.now(), who: nombre, status: res.status(), method: res.request().method(),
      path: path.replace(/\/api\/rooms\/[^/]+/, '/api/rooms/:id'), body: body.slice(0, 160),
    });
  });
  page.on('pageerror', (e) => errorLog.push({ t: Date.now(), who: nombre, status: 'pageerror', body: String(e.message).slice(0, 160) }));

  let mainNavs = 0;
  page.on('framenavigated', (f) => { if (f === page.mainFrame() && ++mainNavs > 1) tl('RECARGA', f.url()); });
  page.on('websocket', (ws) => {
    const kind = ws.url().includes('/ws?token=') ? 'sig' : ws.url().includes(':5173') ? 'vite' : 'ws';
    tl(`${kind}-open`);
    ws.on('close', () => tl(`${kind}-close`));
    ws.on('socketerror', (e) => tl(`${kind}-error`, String(e)));
  });
  page.on('console', (m) => {
    const txt = m.text();
    if (m.type() === 'error' || m.type() === 'warning' || txt.startsWith('[diag]') || txt.startsWith('[vite]')) tl(`console.${m.type()}`, txt.slice(0, 220));
  });
  page.on('requestfailed', (r) => tl('request-failed', `${r.method()} ${new URL(r.url()).pathname.replace(/\/api\/rooms\/[^/]+/, '/api/rooms/:id')} ${r.failure()?.errorText ?? ''}`));
  page.on('crash', () => tl('CRASH'));

  await page.goto(link);
  await page.waitForSelector('text=Registro de asistencia', { timeout: 30000 });
  await page.waitForFunction(() => {
    const b = [...document.querySelectorAll('button')].find((x) => x.textContent?.includes('Mic activo'));
    return b && !b.disabled;
  }, null, { timeout: 30000 });
  await page.fill('input[placeholder="María Restrepo"]', nombre);
  await page.fill('input[placeholder="maria@enactuscolombia.org"]', correo);
  await page.click('button[type=submit]');
  tl('submit');
  // Si la entrada falla (la app deja el formulario con un error), se vuelve a
  // tocar "Entrar" una vez, como haría una persona, y queda registrado.
  const inCall = await page.waitForSelector('text=Salir', { timeout: 30000 }).then(() => true).catch(() => false);
  if (!inCall) {
    const shown = await page.evaluate(() => document.body.innerText.replace(/\s+/g, ' ').slice(0, 160)).catch(() => '');
    tl('REINTENTO MANUAL', shown);
    console.log(`  ${nombre}: la entrada no terminó en 30 s, se vuelve a tocar Entrar`);
    await page.click('button[type=submit]', { timeout: 60000 }).catch(() => {});
  }
  await page.waitForSelector('text=Salir', { timeout: 90000 });
  const ms = Date.now() - t0;
  tl('adentro', `${ms}ms`);
  console.log(`  ${nombre} adentro en ${ms}ms`);
  return { page, joinMs: ms };
}

async function inbound(page) {
  return page.evaluate(async () => {
    const pc = window.__pcs[window.__pcs.length - 1];
    const out = { audio: {}, video: {}, outAudio: 0 };
    if (!pc) return out;
    const stats = await pc.getStats();
    stats.forEach((r) => {
      if (r.type === 'inbound-rtp' && (r.kind === 'audio' || r.kind === 'video')) out[r.kind][r.mid ?? r.id] = r.bytesReceived ?? 0;
      // Audio propio saliendo hacia el SFU.
      if (r.type === 'outbound-rtp' && r.kind === 'audio') out.outAudio += r.bytesSent ?? 0;
    });
    return out;
  });
}
const growingMids = (a, b, kind) => Object.keys(b[kind]).filter((m) => a[kind][m] !== undefined && b[kind][m] > a[kind][m]);

// De quién es cada audio que llega con bytes creciendo, de quién falta, y
// cuáles de los que faltan ni siquiera tienen suscripción aceptada por el SFU.
function audioReport(name, before, after, everyone) {
  const map = midToTrack[name] ?? new Map();
  const ownerOf = (trackName) => trackOwner(trackName).replace(/:audio$/, '');
  const got = new Set(growingMids(before, after, 'audio').map((m) => ownerOf(map.get(String(m)))));
  const subscribed = new Set([...map.values()].filter((tn) => tn.endsWith('-audio')).map(ownerOf));
  const missing = everyone.filter((n) => n !== name && !got.has(n));
  return { count: got.size, missing, notSubscribed: missing.filter((n) => !subscribed.has(n)) };
}

// Estado de la fuente de audio propia de una pestaña: si el AudioContext del
// micrófono sintético avanza, si el track que sale está vivo, cuántas muestras
// por segundo entrega (stats media-source), su nivel y cuántos paquetes salen.
async function sourceDiag(page) {
  return page.evaluate(async () => {
    const pc = window.__pcs[window.__pcs.length - 1];
    const ac = window.__pubAudioCtx;
    const snap = async () => {
      const s = { samples: null, level: null, packets: 0 };
      if (!pc) return s;
      (await pc.getStats()).forEach((r) => {
        if (r.type === 'media-source' && r.kind === 'audio') { s.samples = r.totalSamplesDuration ?? null; s.level = r.audioLevel ?? null; }
        if (r.type === 'outbound-rtp' && r.kind === 'audio') s.packets += r.packetsSent ?? 0;
      });
      return s;
    };
    const t0 = ac ? ac.currentTime : 0;
    const a = await snap();
    await new Promise((r) => setTimeout(r, 1000));
    const b = await snap();
    const tr = pc?.getTransceivers().find((t) => t.direction === 'sendonly' && t.receiver.track.kind === 'audio');
    const track = tr?.sender.track;
    return {
      ctx: ac ? `${ac.state} +${(ac.currentTime - t0).toFixed(2)}s` : 'sin contexto',
      track: tr ? (track ? `${track.readyState}${track.muted ? ' muted' : ''}${track.enabled ? '' : ' disabled'}` : 'null') : 'sin transceiver',
      samplesPerSec: a.samples != null && b.samples != null ? +(b.samples - a.samples).toFixed(2) : null,
      level: b.level,
      packetsPerSec: b.packets - a.packets,
    };
  });
}
const fmtSource = (s) => `contexto ${s.ctx} | track ${s.track} | muestras/s ${s.samplesPerSec} | nivel ${s.level} | paquetes/s ${s.packetsPerSec}`;

// Nivel real (RMS) del audio de `speaker` tal como llega a `page`, medido con
// un analizador propio del arnés sobre el receptor WebRTC -- independiente de
// la detección de la app, para separar "no llega sonido" de "llega y la app
// no lo marca".
async function receiverLevel(page, pageName, speaker) {
  const trackName = `${nameToUserId.get(speaker)}-audio`;
  const mid = [...(midToTrack[pageName] ?? new Map()).entries()].find(([, tn]) => tn === trackName)?.[0];
  if (!mid) return 'sin mid';
  return page.evaluate(async (mid) => {
    const pc = window.__pcs[window.__pcs.length - 1];
    const tr = pc.getTransceivers().find((t) => t.mid === mid);
    if (!tr) return 'sin transceiver';
    const ac = (window.__probeCtx ??= new AudioContext());
    await ac.resume().catch(() => {});
    const src = ac.createMediaStreamSource(new MediaStream([tr.receiver.track]));
    const an = ac.createAnalyser();
    an.fftSize = 512;
    src.connect(an);
    const buf = new Uint8Array(an.fftSize);
    let max = 0;
    for (let i = 0; i < 8; i++) {
      await new Promise((r) => setTimeout(r, 150));
      an.getByteTimeDomainData(buf);
      let s = 0;
      for (const v of buf) { const x = (v - 128) / 128; s += x * x; }
      max = Math.max(max, Math.sqrt(s / buf.length));
    }
    src.disconnect();
    return +max.toFixed(3);
  }, mid);
}

async function netHealth(page) {
  return page.evaluate(async () => {
    const pc = window.__pcs[window.__pcs.length - 1];
    if (!pc) return null;
    const stats = await pc.getStats();
    let rtt = null, outBps = null, lost = 0, recv = 0;
    stats.forEach((r) => {
      if (r.type === 'candidate-pair' && r.nominated && r.state === 'succeeded') { rtt = r.currentRoundTripTime ?? rtt; outBps = r.availableOutgoingBitrate ?? outBps; }
      if (r.type === 'inbound-rtp') { lost += r.packetsLost ?? 0; recv += r.packetsReceived ?? 0; }
    });
    return { rttMs: rtt == null ? null : Math.round(rtt * 1000), outKbps: outBps == null ? null : Math.round(outBps / 1000), lossPct: recv + lost > 0 ? +(100 * lost / (recv + lost)).toFixed(2) : 0, pcs: window.__pcs.length, state: pc.connectionState };
  });
}

async function ui(page) {
  return page.evaluate(() => {
    const txt = document.body.innerText;
    const pg = txt.match(/p[aá]gina\s+(\d+)\s+de\s+(\d+)/i);
    const pc = txt.match(/(\d+)\s+participantes/i);
    const spans = [...document.querySelectorAll('span')].filter((s) => /^P\d+$/.test(s.textContent?.trim() || ''));
    const names = spans.map((s) => s.textContent.trim());
    const speaking = spans.filter((s) => {
      let el = s;
      for (let i = 0; i < 6 && el; i++) { const cs = getComputedStyle(el); if (cs.boxShadow && cs.boxShadow !== 'none') return true; el = el.parentElement; }
      return false;
    }).map((s) => s.textContent.trim());
    return { page: pg ? Number(pg[1]) : 1, pages: pg ? Number(pg[2]) : 1, participants: pc ? Number(pc[1]) : null, names, speaking, reconnecting: /reconectando/i.test(txt) };
  });
}

async function clickPager(page, label) {
  const btn = page.locator('button', { hasText: label });
  if ((await btn.count()) === 0 || (await btn.isDisabled())) return false;
  await btn.click();
  return true;
}
async function setGain(page, v) {
  await page.evaluate((x) => { if (window.__gainNode) window.__gainNode.gain.value = x; }, v);
}
async function sampleVideoActive(page, durationMs, stepMs) {
  const counts = [];
  let prev = await inbound(page);
  const end = Date.now() + durationMs;
  while (Date.now() < end) {
    await page.waitForTimeout(stepMs);
    const cur = await inbound(page);
    counts.push(growingMids(prev, cur, 'video').length);
    prev = cur;
  }
  return counts;
}
function summarizeErrors(fromT, toT) {
  const groups = {};
  for (const e of errorLog.filter((x) => x.t >= fromT && x.t < toT)) {
    let code = e.body;
    try { code = JSON.parse(e.body).error ?? e.body; } catch {}
    const key = `${e.status} ${e.method ?? ''} ${e.path ?? ''} -> ${code}`;
    groups[key] = (groups[key] ?? 0) + 1;
  }
  return groups;
}

async function main() {
  const { room, link, hostKey } = await (await fetch(`${API}/api/rooms`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ nombre: `Semana 4 escala ${LABEL}` }),
  })).json();
  console.log(`sala ${room.id} | N_TOTAL=${N_TOTAL} (observador + ${N_PUB}) | gap ${JOIN_GAP_MS}ms | salida de audio ${FAKE_AUDIO_OUT ? 'falsa' : 'real'}`);

  const results = { label: LABEL, nTotal: N_TOTAL, roomId: room.id, fakeAudioOut: FAKE_AUDIO_OUT, checks: {}, joinMs: {} };
  // N_BROWSERS > 1 reparte las pestañas en varios procesos de Chromium: con 16
  // pestañas en uno solo, desde la undécima el navegador de prueba ya no
  // arrancaba el AudioContext del micrófono sintético ("error from the audio
  // device or the WebAudio renderer"), así que esas fuentes no mandaban audio.
  const N_BROWSERS = Math.max(1, Number(process.env.N_BROWSERS ?? 1));
  const browsers = [];
  for (let b = 0; b < N_BROWSERS; b++) {
    const instance = await chromium.launch({ args, ...(process.env.BROWSER_CHANNEL ? { channel: process.env.BROWSER_CHANNEL } : {}) });
    instance.on('disconnected', () => timeline.push({ t: Date.now(), who: `browser${b}`, kind: 'DISCONNECTED', detail: '' }));
    browsers.push(instance);
  }
  const browser = { close: () => Promise.all(browsers.map((x) => x.close())) };
  console.log(`navegador: ${process.env.BROWSER_CHANNEL ?? 'Chromium headless shell de Playwright'} ${browsers[0].version()} | procesos de navegador: ${N_BROWSERS}`);
  const pages = {};
  try {
    mark('join');
    try {
      for (const [i, name] of ['Obs', ...Array.from({ length: N_PUB }, (_, k) => `P${k + 1}`)].entries()) {
        if (i > 0) await new Promise((r) => setTimeout(r, JOIN_GAP_MS));
        const j = await join(browsers[i % N_BROWSERS], link, name, `${name.toLowerCase()}-${LABEL}@s4.test`);
        pages[name] = j.page;
        results.joinMs[name] = j.joinMs;
      }
    } catch (err) {
      console.log('\n=== falló el join: estado de cada página ===');
      for (const [name, p] of Object.entries(livePages)) {
        const snap = await Promise.race([
          p.evaluate(() => ({ text: document.body.innerText.replace(/\s+/g, ' ').slice(0, 180), net: window.__netEvents })),
          new Promise((r) => setTimeout(() => r({ text: '(evaluate no respondió en 3s)' }), 3000)),
        ]).catch((e) => ({ text: `evaluate falló: ${e.message}` }));
        console.log(`  ${name}: ${snap.text} | net ${JSON.stringify(snap.net ?? [])}`);
      }
      throw err;
    }
    const obs = pages.Obs;
    const all = Object.entries(pages);
    const everyone = Object.keys(pages);
    const joins = Object.values(results.joinMs);
    console.log(`[entradas] mediana ${[...joins].sort((a, b) => a - b)[Math.floor(joins.length / 2)]}ms, máxima ${Math.max(...joins)}ms`);

    mark('steady');
    await obs.waitForTimeout(10000);

    const u0 = await ui(obs);
    console.log(`[UI observador] página ${u0.page} de ${u0.pages}, "${u0.participants} participantes", en la página 1: ${u0.names.join(',')}`);
    const expectPages = Math.ceil(N_PUB / 10);
    results.checks.paginacion = u0.pages === expectPages && u0.participants === N_TOTAL && u0.names.length === Math.min(10, N_PUB);
    console.log(`[1] paginación real (${expectPages} páginas, ${Math.min(10, N_PUB)} cuadritos en la página 1, "${N_TOTAL} participantes"):`, results.checks.paginacion ? 'PASS' : 'FAIL');

    const snapA = {};
    for (const [name, p] of all) snapA[name] = await inbound(p);
    await obs.waitForTimeout(4000);
    const perPage = {};
    for (const [name, p] of all) {
      const b = await inbound(p);
      const audio = audioReport(name, snapA[name], b, everyone);
      perPage[name] = { audio: audio.count, audioTotal: Object.keys(b.audio).length, missing: audio.missing, notSubscribed: audio.notSubscribed, sendingAudio: b.outAudio > snapA[name].outAudio, video: growingMids(snapA[name], b, 'video').length, net: await netHealth(p) };
    }
    console.log('[por participante] audio con bytes creciendo/transceivers de audio | video creciendo | red (RTT, pérdida, PeerConnections creadas, estado):');
    for (const [name, v] of Object.entries(perPage)) {
      const faltan = v.missing.length ? ` | sin audio de: ${v.missing.join(',')}${v.notSubscribed.length ? ` (sin suscripción aceptada: ${v.notSubscribed.join(',')})` : ' (todos suscritos)'}` : '';
      console.log(`  ${name.padEnd(4)} audio ${String(v.audio).padStart(2)}/${String(v.audioTotal).padEnd(2)} video ${String(v.video).padStart(2)} | rtt ${v.net?.rttMs}ms pérdida ${v.net?.lossPct}% pcs ${v.net?.pcs} ${v.net?.state}${v.sendingAudio ? '' : ' | NO ENVÍA AUDIO'}${faltan}`);
    }
    const sources = Object.fromEntries(await Promise.all(all.map(async ([name, p]) => [name, await sourceDiag(p)])));
    results.sources = sources;
    console.log('[fuente de audio propia de cada pestaña]');
    for (const [name, s] of Object.entries(sources)) console.log(`  ${name.padEnd(4)} ${fmtSource(s)}`);
    results.perPageSteady = perPage;
    const missingAudio = Object.entries(perPage).filter(([, v]) => v.missing.length > 0).map(([n, v]) => `${n} sin ${v.missing.join('+')}`);
    const overCap = Object.entries(perPage).filter(([, v]) => v.video > 10).map(([n, v]) => `${n}:${v.video}`);
    results.checks.audioDeTodos = missingAudio.length === 0;
    results.checks.capVideoSteady = overCap.length === 0;
    console.log(`[2] el audio de los ${N_PUB} llega a cada uno de los ${N_TOTAL}:`, missingAudio.length === 0 ? 'PASS' : `FAIL -> ${missingAudio.join(' | ')}`);
    console.log('[3] nadie tiene más de 10 videos fluyendo:', overCap.length === 0 ? 'PASS' : `FAIL -> ${overCap.join(' ')}`);

    if (SPEAKER_PROBE) {
      mark('speakerProbe');
      const who = 'P1';
      const mid = [...(midToTrack.Obs ?? new Map()).entries()].find(([, tn]) => tn === `${nameToUserId.get(who)}-audio`)?.[0];
      // Lo que el receptor WebRTC del observador decodifica para ese track:
      // tamaño de paquete (silencio frente a tono), muestras decodificadas por
      // segundo (0 = nadie está tirando del audio) y audioLevel.
      const inboundDetail = () => obs.evaluate(async (mid) => {
        const pc = window.__pcs[window.__pcs.length - 1];
        const read = async () => { let found = null; (await pc.getStats()).forEach((r) => { if (r.type === 'inbound-rtp' && r.kind === 'audio' && String(r.mid) === mid) found = r; }); return found; };
        const a = await read();
        await new Promise((r) => setTimeout(r, 1000));
        const b = await read();
        if (!a || !b) return 'sin stats';
        const dp = b.packetsReceived - a.packetsReceived;
        return `bytes/paquete ${dp > 0 ? ((b.bytesReceived - a.bytesReceived) / dp).toFixed(1) : '—'} | paquetes/s ${dp} | muestras decodificadas/s ${(b.totalSamplesReceived ?? 0) - (a.totalSamplesReceived ?? 0)} | audioLevel ${b.audioLevel ?? '—'}`;
      }, mid);
      const waitMarked = async () => {
        const t0 = Date.now();
        for (let i = 0; i < 10; i++) {
          await obs.waitForTimeout(500);
          if ((await ui(obs)).speaking.includes(who)) return `sí, a los ${Date.now() - t0}ms`;
        }
        return 'no (5 s)';
      };
      console.log(`[sonda] ${who} en silencio -> fuente: ${fmtSource(await sourceDiag(pages[who]))} | recibido: ${await inboundDetail()}`);
      await setGain(pages[who], 0.9);
      const marked = await waitMarked();
      console.log(`[sonda] ${who} con ganancia 0.9 -> fuente: ${fmtSource(await sourceDiag(pages[who]))} | recibido: ${await inboundDetail()}`);
      console.log(`[sonda]   RMS medido por el arnés en el observador: ${await receiverLevel(obs, 'Obs', who)} | la app lo marca hablando: ${marked}`);
      // Variante: el mismo track también conectado a un <audio> silenciado.
      const attached = await obs.evaluate(async (mid) => {
        const pc = window.__pcs[window.__pcs.length - 1];
        const tr = pc.getTransceivers().find((t) => t.mid === mid);
        if (!tr) return 'sin transceiver';
        const el = document.createElement('audio');
        el.muted = true;
        el.srcObject = new MediaStream([tr.receiver.track]);
        document.body.appendChild(el);
        try { await el.play(); return 'reproduciendo silenciado'; } catch (e) { return `play falló: ${e.message}`; }
      }, mid);
      await obs.waitForTimeout(1500);
      const marked2 = await waitMarked();
      console.log(`[sonda] con <audio> silenciado en el observador (${attached}) -> recibido: ${await inboundDetail()}`);
      console.log(`[sonda]   RMS medido por el arnés: ${await receiverLevel(obs, 'Obs', who)} | la app lo marca hablando: ${marked2}`);
      await setGain(pages[who], 0);
    }

    if (N_PUB > 10) {
      mark('page2');
      const s1a = await inbound(obs); await obs.waitForTimeout(3000); const s1b = await inbound(obs);
      const page1Mids = new Set(growingMids(s1a, s1b, 'video'));
      await clickPager(obs, '►');
      await obs.waitForTimeout(4000);
      const s2a = await inbound(obs); await obs.waitForTimeout(3000); const s2b = await inbound(obs);
      const page2Mids = growingMids(s2a, s2b, 'video');
      const u2 = await ui(obs);
      const overlap = page2Mids.filter((m) => page1Mids.has(m));
      console.log(`[página 2] UI: página ${u2.page}, cuadritos ${u2.names.join(',')} | video creciendo ${page2Mids.length} (página 1: ${page1Mids.size}), mids compartidos con la página 1: ${overlap.length}`);
      results.checks.cambioPagina = u2.page === 2 && u2.names.length === N_PUB - 10 && page2Mids.length === N_PUB - 10 && overlap.length === 0;
      console.log('[4] cambiar de página cambia los tracks realmente suscritos:', results.checks.cambioPagina ? 'PASS' : 'FAIL');

      mark('rapidNav');
      const sampler = sampleVideoActive(obs, 9000, 500);
      for (let i = 0; i < 8; i++) { await clickPager(obs, i % 2 === 0 ? '◄' : '►'); await obs.waitForTimeout(120); }
      await clickPager(obs, '◄');
      const counts = await sampler;
      const settled = await sampleVideoActive(obs, 4000, 1000);
      console.log(`[navegación rápida] videos activos cada 500ms: ${counts.join(' ')} | asentado: ${settled.join(' ')}`);
      results.rapidNav = { counts, settled };
      results.checks.capVideoRapid = Math.max(...counts, ...settled) <= 10;
      console.log('[5] nunca más de 10 videos activos navegando rápido:', results.checks.capVideoRapid ? 'PASS' : `REVISAR (máx ${Math.max(...counts, ...settled)})`);

      mark('speaker');
      // Quien habla sale de la página 2 y tiene que tener audio saliendo de
      // verdad (ver [audio saliente]); si no, el check mediría al arnés y no a
      // la app. Se prefiere el último de la página 2.
      const page2Names = Array.from({ length: N_PUB - 10 }, (_, k) => `P${k + 11}`);
      const last = [...page2Names].reverse().find((n) => perPage[n]?.sendingAudio) ?? `P${N_PUB}`;
      const before = await ui(obs);
      console.log(`[antes] observador en página ${before.page}; ¿${last} en pantalla? ${before.names.includes(last)}`);
      const tSpeak = Date.now();
      await setGain(pages[last], 0.9);
      let promotedAt = null, borderAt = null;
      const trace6 = [];
      for (let i = 0; i < 30; i++) {
        await obs.waitForTimeout(500);
        const u = await ui(obs);
        trace6.push(`${u.page}:${u.speaking.join('+') || '-'}`);
        if (borderAt === null && u.speaking.includes(last)) borderAt = Date.now() - tSpeak;
        if (promotedAt === null && u.page === 1 && u.names.includes(last)) promotedAt = Date.now() - tSpeak;
        if (promotedAt !== null && borderAt !== null) break;
      }
      const lvl6 = await receiverLevel(obs, 'Obs', last);
      const src6 = await sourceDiag(pages[last]);
      const afterSpeak = await ui(obs);
      console.log(`[hablando] fuente de ${last}: ${fmtSource(src6)} | RMS recibido en el observador: ${lvl6} | en la página 1 tras ${promotedAt ?? '—'}ms, borde tras ${borderAt ?? '—'}ms | recorrido página:hablando ${dedupe(trace6).join(' > ')} | página 1: ${afterSpeak.names.join(',')}`);
      results.speaker = { speaker: last, promotedAt, borderAt, level: lvl6, source: src6, trace: dedupe(trace6) };
      results.checks.speakerSube = promotedAt !== null && borderAt !== null;
      console.log(`[6] quien habla (${last}, venía de la página 2) sube a la página visible:`, results.checks.speakerSube ? 'PASS' : 'FAIL');

      await setGain(pages[last], 0);
      await obs.waitForTimeout(13000);
      const quietUi = await ui(obs);
      results.checks.speakerBaja = !quietUi.names.includes(last) && quietUi.names.length === 10;
      console.log(`[7] al callarse vuelve a la página 2 y la página 1 queda con 10:`, results.checks.speakerBaja ? 'PASS' : `REVISAR (página 1: ${quietUi.names.join(',')})`);

      mark('autoJump');
      await clickPager(obs, '►');
      await obs.waitForTimeout(9000);
      const onP2 = await ui(obs);
      await setGain(pages.P3, 0.9);
      const tJump = Date.now();
      let jumpedAt = null;
      const trace8 = [];
      for (let i = 0; i < 30; i++) {
        await obs.waitForTimeout(500);
        const u = await ui(obs);
        trace8.push(`${u.page}:${u.speaking.join('+') || '-'}`);
        if (u.page === 1 && u.speaking.includes('P3')) { jumpedAt = Date.now() - tJump; break; }
      }
      const lvl8 = await receiverLevel(obs, 'Obs', 'P3');
      const src8 = await sourceDiag(pages.P3);
      console.log(`[salto] observador en página ${onP2.page}; P3 (página 1) habla -> fuente: ${fmtSource(src8)} | RMS recibido en el observador ${lvl8} | vuelve a la página 1 con P3 marcado tras ${jumpedAt ?? '—'}ms | recorrido ${dedupe(trace8).join(' > ')}`);
      results.autoJump = { jumpedAt, level: lvl8, source: src8, trace: dedupe(trace8) };
      results.checks.autoJump = onP2.page === 2 && jumpedAt !== null;
      console.log('[8] estando en la página 2, si alguien de la destacada empieza a hablar vuelvo a verlo:', results.checks.autoJump ? 'PASS' : 'FAIL');
      await setGain(pages.P3, 0);
    }

    mark('end');
    const sa = {};
    for (const [name, p] of all) sa[name] = await inbound(p);
    await obs.waitForTimeout(4000);
    const fin = {};
    for (const [name, p] of all) {
      const b = await inbound(p);
      fin[name] = { audio: audioReport(name, sa[name], b, everyone), video: growingMids(sa[name], b, 'video').length };
    }
    const finMissing = Object.entries(fin).filter(([, v]) => v.audio.missing.length > 0).map(([n, v]) => `${n} sin ${v.audio.missing.join('+')}`);
    const finOver = Object.entries(fin).filter(([, v]) => v.video > 10).map(([n, v]) => `${n}:${v.video}`);
    results.checks.audioDeTodosFinal = finMissing.length === 0;
    results.checks.capVideoFinal = finOver.length === 0;
    console.log(`[final] audio completo: ${finMissing.length === 0 ? 'PASS' : 'FAIL ' + finMissing.join(' | ')} | cap de video: ${finOver.length === 0 ? 'PASS' : 'FAIL ' + finOver.join(' ')}`);

    const net = {};
    for (const [name, p] of all) net[name] = await p.evaluate(() => window.__netEvents);
    results.netEvents = net;
    const reconnected = Object.entries(net).filter(([, ev]) => ev.some((e) => e.kind === 'ws-close') || ev.some((e) => e.state === 'disconnected' || e.state === 'failed'));
    console.log(`[red] participantes con WS cerrado o PeerConnection disconnected/failed: ${reconnected.length ? reconnected.map(([n, ev]) => `${n}(${ev.map((e) => e.kind === 'pc' ? `pc${e.pc}:${e.state}` : `ws:${e.code}`).join('>')})`).join(' ') : 'ninguno'}`);
  } finally {
    phases.close = Date.now();
    printTimeline();
    await browser.close().catch(() => {});
    await fetch(`${API}/api/rooms/${room.id}/close`, { method: 'POST', headers: { 'x-host-key': hostKey } }).catch(() => {});
  }

  const t = phases;
  results.errors = {
    join: summarizeErrors(t.join, t.steady ?? t.close),
    steady: summarizeErrors(t.steady ?? t.close, t.page2 ?? t.end ?? t.close),
    navegacion: summarizeErrors(t.page2 ?? t.close, t.speaker ?? t.close),
    speaker: summarizeErrors(t.speaker ?? t.close, t.end ?? t.close),
    total: summarizeErrors(0, Infinity),
  };
  results.errorRows = errorLog;
  results.timeline = timeline;
  console.log('\n=== errores HTTP / de página por fase ===');
  console.log(JSON.stringify(results.errors, null, 2));
  const noSfu = errorLog.filter((e) => e.body.includes('no_sfu_session'));
  console.log(`no_sfu_session: ${noSfu.length} (participantes: ${[...new Set(noSfu.map((e) => e.who))].join(',') || 'ninguno'})`);
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(new URL(`grid-16-${LABEL}.json`, OUT_DIR), JSON.stringify(results, null, 2));
}

main().catch((e) => { console.error('FAILED', e); process.exit(1); });
