# meets — Parte A: suscripción selectiva a tracks

Base de señalización WebRTC + modelo de datos (Semana 1), registro previo obligatorio +
límite de 7 salas + SFU protegido por token (Semana 2), y suscripción de video capada a
`MAX_VISIBLE_TILES` por cliente para poder escalar a un webinar de 300 personas sin que
cada navegador tenga que decodificar 300 videos ni el egress de Cloudflare se dispare
(Parte A). Ninguna feature de producto (tablero, encuestas, subsalas, grid paginado,
active speaker) está construida todavía — ver "Fuera de alcance" al final.

## Stack

- Backend: Cloudflare Workers + [Hono](https://hono.dev/) (`/backend`)
- Señalización / estado de sala: 1 Durable Object (`RoomSession`) por sala activa
- Medios: [Cloudflare Realtime SFU](https://developers.cloudflare.com/realtime/sfu/) (nunca malla peer-to-peer)
- NAT traversal: Cloudflare Realtime TURN (opcional esta semana, ver abajo)
- Base de datos: Cloudflare D1 (`/migrations`)
- Frontend: React + Vite (`/frontend`), prototipo sin estilos

## 0. Requisitos

- Node.js 18.17+ (probado con 18.17.1)
- Una cuenta de Cloudflare con **Realtime** habilitado

> **Nota sobre Wrangler:** la versión 4 de Wrangler requiere Node 22+. Este repo fija
> Wrangler en la serie **3.x** (`^3.114.0`) en `backend/package.json`, que sigue
> soportando Workers + Hono + Durable Objects + D1 sin problema y corre en Node 18.
> Si más adelante actualizás a Node 22+, podés subir a Wrangler 4 sin cambios de código.

## 1. Setup

### 1.1 Credenciales de Cloudflare Realtime SFU

1. Entrá al [dashboard de Cloudflare](https://dash.cloudflare.com/) → **Realtime** → creá una App.
   Te da un **App ID** (público) y un **App Secret/Token** (privado).
2. Poné el App ID en `backend/wrangler.toml` (reemplazá `REPLACE_WITH_CALLS_APP_ID`).
3. El secret **nunca** va en `wrangler.toml`. Para desarrollo local:

   ```bash
   cd backend
   echo "<TU_APP_SECRET>" | npx wrangler secret put CALLS_APP_SECRET --local
   ```

   (Para producción, correr el mismo comando sin `--local`.)

4. (Opcional esta semana) Si además configurás un TURN Token separado, el backend lo usa
   automáticamente; si no, cae a STUN público de Cloudflare — alcanza para la prueba de
   dos navegadores en la misma red.

   ```bash
   echo "<TURN_TOKEN_ID>" | npx wrangler secret put TURN_TOKEN_ID --local
   echo "<TURN_TOKEN_SECRET>" | npx wrangler secret put TURN_TOKEN_SECRET --local
   ```

5. **Semana 2**: `SESSION_SIGNING_SECRET` firma la credencial de sesión que protege el
   WebSocket de la sala (ver punto 3 más abajo). Cualquier valor aleatorio largo sirve:

   ```bash
   openssl rand -hex 32 | npx wrangler secret put SESSION_SIGNING_SECRET --local
   ```

### 1.2 D1

```bash
cd backend
npx wrangler d1 create meets-db
# copiá el database_id que te devuelve a wrangler.toml (database_id = "...")

npm run db:migrate:local   # aplica migrations/0001_init.sql a la base local
```

### 1.3 Dependencias

```bash
cd backend && npm install
cd ../frontend && npm install
```

## 2. Correr todo local

Dos terminales:

```bash
# Terminal 1
cd backend
npm run dev        # wrangler dev, http://localhost:8787

# Terminal 2
cd frontend
npm run dev         # vite, http://localhost:5173
```

Si cambiás el puerto del backend, seteá `VITE_API_BASE` en `frontend/.env.local`
(por defecto apunta a `http://localhost:8787`).

## 3. Probar el criterio de aceptación central

No hay UI para crear salas todavía (ver "Fuera de alcance") — se crean por API y se
comparte el `link` que devuelve la respuesta:

```bash
curl -s -X POST http://localhost:8787/api/rooms -H 'content-type: application/json' \
  -d '{"nombre":"Reunión de prueba"}'
# {"room":{...},"link":"http://localhost:5173/r/<roomId>"}
```

1. Abrí ese `link` en **dos navegadores distintos** (o dos perfiles/ventanas de
   incógnito — tienen que ser contextos separados para pedir cámara/mic dos veces).
2. En cada uno debería aparecer la pantalla de **registro** (no la sala directamente).
   Completá nombre, correo y rol — distintos en cada pestaña — y **Entrar a la sala**.
   Aceptá los permisos de cámara/micrófono.
3. A los pocos segundos cada pestaña debería mostrar su propio video (silenciado, con su
   nombre real) y el video del otro participante, con audio.
4. Cerrá una de las dos pestañas: la otra debería dejar de mostrar ese participante
   (con algo de delay — no hay reconexión inteligente esta semana).

### Probar que el registro es obligatorio

```bash
# sin token: el WebSocket del DO rechaza el upgrade antes de tocarlo
curl -i "http://localhost:8787/api/rooms/<roomId>/ws"
# -> 401 {"error":"token requerido"}

# el token lo devuelve /register, y solo sirve para la sala con la que se pidió
curl -s -X POST http://localhost:8787/api/rooms/<roomId>/register -H 'content-type: application/json' \
  -d '{"nombre":"Ana","correo":"ana@ejemplo.com","rol":"participante"}'
```

### Verificar en D1

```bash
cd backend
npx wrangler d1 execute meets-db --local --command "SELECT * FROM rooms"
npx wrangler d1 execute meets-db --local --command "SELECT * FROM users"
npx wrangler d1 execute meets-db --local --command "SELECT * FROM attendance"
```

Deberías ver la sala creada, los dos usuarios (con su `correo`), y sus filas de
`attendance` con `joined_at` (y `left_at` si ya salieron). Registrar el mismo `correo`
dos veces reutiliza la misma fila de `users` en vez de duplicarla.

### Probar el límite de 7 salas activas

```bash
for i in $(seq 1 7); do
  curl -s -X POST http://localhost:8787/api/rooms -H 'content-type: application/json' \
    -d "{\"nombre\":\"Sala $i\"}"
done
# la 8va tiene que rechazar con 409:
curl -i -X POST http://localhost:8787/api/rooms -H 'content-type: application/json' \
  -d '{"nombre":"Sala 8"}'
```

El chequeo de límite y el INSERT viven en una sola sentencia SQL
(`db.createRoomIfUnderLimit`, ver `backend/src/db.ts`) para que dos creaciones
concurrentes no puedan colarse las dos cuando queda un solo cupo — D1 serializa los
writes de una misma base, así que esa sentencia compuesta es atómica sin necesitar
`BEGIN/COMMIT` explícito.

## 4. Endpoints del backend

| Método | Ruta | Qué hace |
|---|---|---|
| POST | `/api/rooms` | Crea una sala (rechaza con 409 si ya hay `MAX_ACTIVE_ROOMS` activas). Devuelve `link` listo para compartir |
| GET | `/api/rooms` | Lista salas activas |
| GET | `/api/rooms/:id` | Pre-chequeo para la pantalla de registro: 404 si no existe, 200 con `estado` si existe (activa o cerrada) |
| POST | `/api/rooms/:id/close` | Cierra una sala (D1 + fuerza el cierre de todos los WS del DO) |
| GET | `/api/rooms/:id/attendance` | Asistencia de la sala (`?format=csv` para exportar) |
| POST | `/api/rooms/:id/register` | Registro previo obligatorio (nombre + correo + rol → userId + token de sesión). Reutiliza el usuario si el correo ya existía |
| GET | `/api/rooms/:id/ws?token=` | Upgrade a WebSocket — **requiere** el `token` de `/register` (401 si falta/vencido/de otra sala); dispara el "unirse" en el DO |
| GET | `/api/rooms/:id/sfu/ice-servers` | Credenciales ICE (TURN o fallback STUN) |
| POST | `/api/rooms/:id/sfu/session` | Crea la Session del participante en el SFU (requiere `connectionId` de un WS ya unido) |
| POST | `/api/rooms/:id/sfu/publish` | Publica tracks locales (offer → answer) |
| POST | `/api/rooms/:id/sfu/subscribe` | Suscribe a tracks remotos. Video queda limitado a `MAX_VISIBLE_TILES` por cliente (409 `video_tile_limit` si se pasa); audio no tiene límite |
| PUT | `/api/rooms/:id/sfu/unsubscribe` | Deja de recibir un track (sin renegociar SDP — ver Parte A abajo) |
| PUT | `/api/rooms/:id/sfu/renegotiate` | Completa la renegociación al suscribirse |
| GET | `/api/rooms/:id/participants` | Debug: participantes actuales del DO |

No hay UI de administración esta semana (ver "Fuera de alcance"); estos endpoints ya
alcanzan para probar los criterios de aceptación con curl.

## 5. Decisiones de arquitectura y cuellos de botella a 300 participantes

(Comentado también inline en el código, acá el resumen.)

- **WebSocket Hibernation API** (`ctx.acceptWebSocket`, no `addEventListener`) en
  `RoomSession`: el runtime puede descargar el DO de memoria entre eventos sin cerrar
  los sockets. Importante para un webinar de 300 personas donde la mayoría de las
  conexiones están inactivas la mayor parte del tiempo.
- **Estado del participante en `ctx.storage`, no en un `Map` en memoria de JS**: sobrevive
  a la hibernación gratis, y las lecturas son I/O local rápido (no hay red de por medio).
  Es, en la práctica, la "lista en memoria" que pide el enunciado.
- **El INSERT de `attendance` en el join es síncrono** (bloquea el upgrade del WebSocket
  hasta que D1 confirma). Correcto y simple con pocos participantes; a 300 joins
  simultáneos (arranque de un webinar) esto serializa escrituras contra D1 y se vuelve
  el cuello de botella del join. Salida documentada en `roomSession.ts`: aceptar el
  WebSocket primero y mover el INSERT a `ctx.waitUntil(...)`.
- **`selectTracksToSubscribe(...)` en `roomSession.ts`** es la función explícita y
  parametrizable de suscripción que pide el enunciado: hoy se llama sin límite (pocos
  participantes, se suscribe a todo). Semana 3 la llama con `maxTracks: 10` (modelo
  Meet) sin tener que tocar su firma ni el resto del flujo de señalización.
- **`broadcast()` es O(n) por evento** (itera todos los WebSockets del DO). Con 300
  participantes y alta rotación (entradas/salidas seguidas al arrancar un webinar), esto
  puede generar ráfagas de mensajes. No se optimiza esta semana; la salida natural es
  debouncear/batchear los `participant-joined`/`left` en vez de mandarlos uno por uno.
- **No se llama a `closeTracks` en el SFU cuando alguien se desconecta abruptamente**: se
  confía en el garbage collection propio de Cloudflare Realtime (tracks inactivos se
  limpian solos). Evita una llamada HTTP extra en el camino de salida.
- Se eligió **no** usar la librería `partytracks` (mantenida por Cloudflare) a propósito:
  el objetivo de esta semana es entender y controlar el flujo de señalización SFU
  directamente (creación de sesión, publish, subscribe, renegotiate), no depender de una
  abstracción. El wrapper de `backend/src/realtime.ts` está verificado contra el código
  fuente de esa librería y del demo oficial `cloudflare/meet`.
- **(Semana 2) Credencial de sesión sin estado**: `backend/src/session.ts` firma un JWT
  casero (HMAC-SHA256 sobre `SESSION_SIGNING_SECRET`) en vez de guardar sesiones en D1 o
  KV — no hay lookup extra en el camino caliente del join, consistente con el resto de
  las decisiones de esta semana orientadas a los 300 participantes de un webinar. TTL
  corto (120s): el token solo tiene que sobrevivir el tramo registro→apertura del
  WebSocket, no la duración de la llamada.
- **(Semana 2) `GET /ws` verifica el token y pisa `userId`/`nombre` en la URL reenviada
  al Durable Object** con los valores del token, no los que mandó el cliente —
  `roomSession.ts` no cambió nada, sigue confiando en esos query params porque ahora
  están garantizados antes de llegar ahí.
- **(Parte A) Suscripción selectiva con cap de video (`MAX_VISIBLE_TILES`, modelo
  Meet)**: cada cliente se suscribía a audio+video de TODOS los demás ("todos con
  todos"), inviable a 300 personas (ni el navegador decodifica 300 videos, ni el
  bolsillo aguanta el egress de Cloudflare — $0.05/GB pasado 1TB/mes gratis). Ahora el
  video queda capado por cliente; el audio nunca se capa (lo necesita el active
  speaker de una parte futura). El cap se valida en el Durable Object, no solo en el
  frontend — un cliente que se salte el frontend y pida 11+ videos de un saque se
  rechaza igual (`roomSession.ts: handleSubscribe`). Dos cuidados no obvios, verificados
  contra la documentación y contra el comportamiento real de la API, no asumidos:
  - El `kind` que manda el cliente en la request nunca se usa para decidir qué cuenta
    contra el cap — se resuelve contra lo que cada participante publicó de verdad
    (`resolveKind`). Si no, alcanzaría con etiquetar un video como `kind:"audio"` para
    saltarse el límite (Cloudflare identifica tracks por `sessionId`+`trackName`, nunca
    por `kind`).
  - La reserva de cupo se hace ANTES de llamar a la API de Cloudflare, no después.
    Confirmado contra la documentación de Durable Objects: los "input gates" protegen
    operaciones de `ctx.storage`, pero NO llamadas `fetch()` salientes — mientras se
    espera la respuesta HTTP, el runtime puede procesar otra request concurrente al
    mismo DO. Reservar antes evita que dos `subscribe` concurrentes del mismo cliente
    superen el cap entre los dos.
- **(Parte A) `PUT tracks/close` con `force: true` para desuscribirse**: no pide
  renegociación SDP (confirmado empíricamente contra la API real, no solo contra la
  doc) — el cliente no toca su `RTCPeerConnection` solo para dejar de ver a alguien.
- **(Parte A) Cloudflare puede devolver 200 con errores POR TRACK dentro de un
  subscribe masivo** (`not_found_track_error`: el publicador todavía no había
  estabilizado ese track en el instante exacto del subscribe — visto en la práctica al
  probar con 12 sesiones reales simultáneas, más probable cuanta más gente se une de
  golpe, que es justo el escenario de arranque de un webinar de 300). Eso no tira
  excepción, así que la reserva de cupo de arriba se corrige explícitamente contra el
  resultado real, track por track — si no, un cliente puede quedar con un cupo
  "fantasma" ocupado para siempre en esa sesión aunque ese video nunca haya llegado a
  fluir. No hay reintento automático todavía (el viewer se queda sin ese tile, en vez de
  reintentarlo) — mejora futura, no de esta parte.

## 6. Fuera de alcance esta semana

Explícitamente no construido (ver brief completo): login/autenticación real, grid
paginado / active speaker / simulcast, subsalas, tablero, encuestas, compartir pantalla,
modo solo-audio, UI de administración (ni de creación de salas — se sigue haciendo por
API), reconexión automática inteligente. El `rol` que se captura en el registro
(`participante`/`admin`) no habilita ni restringe nada todavía — es solo dato para el
panel de administración de Semana 7. El schema de `polls`, `poll_votes` y
`whiteboard_sessions` está diseñado y comentado en `migrations/0001_init.sql` para no
tener que rediseñar el modelo de datos más adelante.

**Limitación conocida (preexistente de Semana 1, no cerrada esta semana)**: el
`connectionId` de cada participante se difunde en claro a todos los demás participantes
de la sala (mensajes `hello`/`participant-joined` por WebSocket), y los endpoints
`/sfu/session|publish|subscribe|renegotiate` confían en el `connectionId` del body sin
atarlo a la conexión que lo está llamando. Un participante ya registrado podría, en
teoría, usar el `connectionId` de otro participante de la misma sala (no adivinándolo,
sino porque lo recibió legítimamente) para tocar su sesión SFU. Es un problema distinto
al que cierra la credencial de sesión de esta semana (esa protege contra alguien que
nunca se registró, no contra la confianza mutua entre participantes ya registrados).
Arreglarlo bien requiere atar cada `connectionId` a su propio WebSocket — cambio más
grande del que da esta semana.

**Fuera de alcance de la Parte A** (ver brief completo): grid paginado y su UI, active
speaker, simulcast. El cap de video usa "los primeros `MAX_VISIBLE_TILES` en el orden
que devuelve el backend" — no hay selección inteligente de quién es visible todavía, ni
UI para pedir explícitamente otro tile (las funciones `subscribeToTracks`/
`unsubscribeFromTracks` de `sfu.ts` ya están listas para que esa UI las use). Tampoco hay
reintento automático cuando Cloudflare devuelve `not_found_track_error` para un track
puntual — ese viewer se queda sin ese tile en vez de reintentarlo.

## 7. Qué se probó de punta a punta (Semana 2)

Con `wrangler dev` + `vite dev` locales, credenciales reales de Cloudflare Realtime, y
Chromium (vía Playwright, sin sandbox de fake-device para no depender de cámara/mic
real):

- el límite de 7 salas activas bajo concurrencia real (20 `POST /api/rooms` en paralelo
  contra el mismo `wrangler dev`: exactamente 7 pasan con 201, el resto 409, confirmado
  contando filas en D1),
- registro con el mismo correo dos veces → misma fila de `users`, `nombre` actualizado,
- `GET /ws` sin token / con token inválido / vencido / de otra sala → 401 sin tocar el
  Durable Object; con token válido pero `userId`/`nombre` falsificados en la query →
  igual queda registrada la identidad real del token, no la falsificada,
- `POST /sfu/session` con un `connectionId` inventado → 404 (sin pasar por `/register`
  no hay forma de llegar a tener uno real),
- flujo completo en dos navegadores reales (dos `BrowserContext` separados): pantalla de
  "sala no encontrada" para un link roto, registro con nombre/correo/rol distintos,
  ambos llegan a la pantalla de la sala, se ven por nombre real y el `RTCPeerConnection`
  llega a `connected` contra el SFU real de Cloudflare,
- con `React.StrictMode` prendido (sin tocar `main.tsx`): una sola fila de `attendance`
  por usuario, sin duplicados ni sesiones de menos de 1 segundo.

## 8. Qué se probó de punta a punta (Parte A — cap de video)

Todo real salvo la cámara (canvas + oscilador sintético en vez de `getUserMedia`, que se
cuelga en este Chromium headless de macOS — igual que Semana 2). D1, el Durable Object,
y el SFU de Cloudflare Realtime son los reales, sin mockear nada:

- 6 sesiones WebRTC reales con `MAX_VISIBLE_TILES` bajado a 3: el último en entrar recibe
  exactamente 3 tracks de video y 5 de audio (contados en su `RTCPeerConnection` real, no
  en el estado de React),
- 12 sesiones WebRTC reales con el default de 10: el último en entrar recibe exactamente
  10 tracks de video y 11 de audio,
- un cliente real pidiendo los videos reales de todos los demás en una sola request
  (saltándose lo que el frontend jamás pediría) → 409 `video_tile_limit`,
- desuscribir un track real y volver a suscribirlo: la conexión sigue `connected` y el
  track vuelve a fluir; desuscribir uno y suscribir un track distinto que antes había
  quedado afuera del cap: mismo resultado (con reintento automático del lado del test
  cuando el primer candidato todavía no estaba listo del lado del publicador —
  `not_found_track_error`, ver arriba), y ningún otro tile se congela durante el
  intercambio (`currentTime` de cada `<video>` sigue avanzando),
- regresión de Semana 2 completa: dos usuarios reales viéndose/escuchándose, `GET /ws`
  sin token → 401, límite de 7 salas bajo concurrencia, sin sesiones de `attendance`
  menores a 1 segundo.
