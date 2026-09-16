# meets

Reuniones y webinars sobre Cloudflare: registro previo obligatorio, medios por el SFU de
Cloudflare Realtime con suscripción selectiva, grid paginado con active speaker,
simulcast, pantalla compartida, modo solo audio, reconexión y subsalas.

| Semana | Qué agrega |
|---|---|
| 1 | Señalización WebRTC con un Durable Object por sala y modelo de datos en D1 |
| 2 | Registro previo obligatorio, límite de 7 salas activas y SFU protegido por token |
| 3 | Tope de 10 videos por cliente, grid paginado con active speaker, simulcast de dos capas, pantalla compartida, modo solo audio y reconexión |
| 4 | Subsalas: moverse entre la sala principal y sus subsalas sin quedar en dos salas ni en ninguna |

## Stack

- Backend: Cloudflare Workers + [Hono](https://hono.dev/) (`/backend`)
- Señalización y estado de cada sala: un Durable Object (`RoomSession`) por sala
- Medios: [Cloudflare Realtime SFU](https://developers.cloudflare.com/realtime/sfu/) (nunca malla peer-to-peer)
- NAT traversal: Cloudflare Realtime TURN (opcional, ver abajo)
- Base de datos: Cloudflare D1 (`/migrations`)
- Frontend: React + Vite (`/frontend`)
- Pruebas de punta a punta: Playwright contra la app local (`/tests`)

## 0. Requisitos

- Node.js 18.17+ (probado con 18.17.1 y 22.23.2)
- Una cuenta de Cloudflare con **Realtime** habilitado

> **Wrangler:** `backend/package.json` fija Wrangler 3.x (`^3.114.0`), que corre en Node 18.
> Corre los comandos de Wrangler desde `backend/`: fuera de esa carpeta, `npx` descarga la
> última versión y no encuentra `wrangler.toml` ("No configuration file found").

## 1. Setup

### 1.1 Credenciales de Cloudflare Realtime

1. En el [dashboard de Cloudflare](https://dash.cloudflare.com/) → **Realtime**, crea una App.
   Te da un **App ID** (público) y un **App Secret** (privado).
2. Pon el App ID en `CALLS_APP_ID`, en `backend/wrangler.toml`.
3. Los secretos nunca van en `wrangler.toml` ni en el repo. Para desarrollo local van en
   `backend/.dev.vars`, que ya está en `.gitignore`:

   ```
   CALLS_APP_SECRET=<tu App Secret>
   SESSION_SIGNING_SECRET=<cadena aleatoria larga, por ejemplo la salida de openssl rand -hex 32>
   # Opcionales: si faltan, el backend usa el STUN público de Cloudflare
   TURN_TOKEN_ID=<id del TURN Token>
   TURN_TOKEN_SECRET=<secreto del TURN Token>
   # Para que los links de sala apunten al frontend local y no al de producción
   FRONTEND_BASE_URL=http://localhost:5173
   ```

   Para producción:

   ```bash
   cd backend
   echo "<tu App Secret>" | npx wrangler secret put CALLS_APP_SECRET
   openssl rand -hex 32 | npx wrangler secret put SESSION_SIGNING_SECRET
   ```

   `SESSION_SIGNING_SECRET` firma los tokens de sesión (120 s) y las credenciales de grupo
   (12 h). Si cambia, todo lo que ya se emitió deja de valer.

### 1.2 D1

```bash
cd backend
npx wrangler d1 create meets-db
# copia el database_id que devuelve en wrangler.toml (database_id = "...")
npm run db:migrate:local   # aplica migrations/ a la base local
```

| Migración | Qué hace |
|---|---|
| `0001_init.sql` | Tablas `rooms`, `users` y `attendance` |
| `0002_users_correo_unico.sql` | Un solo usuario por correo |
| `0003_subsalas.sql` | Llave de host (solo su hash), motivo de salida en `attendance` y la tabla `ubicacion_grupo` |

### 1.3 Dependencias

```bash
cd backend && npm install
cd ../frontend && npm install
```

### 1.4 Configuración

Lo que no es secreto está en `[vars]`, en `backend/wrangler.toml`:

| Variable | Valor | Para qué |
|---|---|---|
| `CALLS_APP_ID`, `CALLS_API_BASE_URL` | | La App de Cloudflare Realtime |
| `FRONTEND_BASE_URL` | `https://connectedx.dpdns.org` | Origen de los links que devuelve `POST /api/rooms`. En local lo pisa `backend/.dev.vars` con `http://localhost:5173` |
| `MAX_ACTIVE_ROOMS` | `7` | Salas principales activas a la vez; las subsalas no cuentan |
| `MAX_VISIBLE_TILES` | `10` | Videos suscritos por cliente; el audio no tiene tope |
| `SIMULCAST_LOW_HEIGHT`, `SIMULCAST_LOW_MAX_BITRATE_BPS`, `SIMULCAST_HIGH_HEIGHT`, `SIMULCAST_HIGH_MAX_BITRATE_BPS` | `180`, `150000`, `720`, `1500000` | Las dos capas de video |
| `SCREEN_SHARE_MAX_BITRATE_BPS` | `2500000` | Pantalla compartida, en una sola capa |
| `ATTENDANCE_GRACE_WINDOW_MS` | `90000` | Una reconexión dentro de esta ventana reabre la fila de asistencia en vez de crear otra |
| `MAX_SUBSALAS_PER_ROOM` | `20` | Subsalas abiertas por sala principal |
| `RECONCILE_INTERVAL_MS` | `60000` | Cada cuánto una sala con gente se reconcilia contra D1 (nunca menos de 5 s) |

## 2. Correr todo local

Dos terminales:

```bash
# Terminal 1
cd backend
npm run dev        # wrangler dev, http://localhost:8787

# Terminal 2
cd frontend
npm run dev        # vite, http://localhost:5173
```

Si cambias el puerto del backend, define `VITE_API_BASE` en `frontend/.env.local`
(por defecto apunta a `http://localhost:8787`; `frontend/.env.production` solo se usa al
construir). Los links de sala que devuelve la API salen de `FRONTEND_BASE_URL`: en local
lo pisa `backend/.dev.vars`, así apuntan a `http://localhost:5173`.

## 3. Probar a mano

### Crear una sala

No hay UI para crear salas: se crean por API.

```bash
curl -s -X POST http://localhost:8787/api/rooms -H 'content-type: application/json' \
  -d '{"nombre":"Reunión de prueba"}'
# {"room":{...},"link":"http://localhost:5173/r/<roomId>","hostKey":"<llave>","hostLink":"http://localhost:5173/r/<roomId>#host=<llave>"}
```

- `link` es para los participantes.
- `hostLink` es para quien coordina: la misma sala, con la llave de host. La app quita la
  llave de la barra de direcciones y la guarda solo en esa pestaña. Con ella se crean y
  cierran subsalas y se termina la reunión. La llave no se puede recuperar: guarda
  `hostKey` si la vas a necesitar, por ejemplo para cerrar la sala por API.

### Entrar

1. Abre el `link` en dos navegadores distintos, o en dos perfiles: tienen que ser
   contextos separados para pedir cámara y micrófono dos veces.
2. Aparece la pantalla de **registro**, no la sala. Completa nombre, correo y rol,
   distintos en cada uno, y entra. Acepta los permisos de cámara y micrófono.
3. Cada uno ve su propio video y el del otro, con su nombre real, y se escuchan.

### Subsalas

1. Desde el `hostLink`, abre **Subsalas**, elige cuántas y toca **Crear**.
2. Los participantes ven **Subsalas (N)** sin recargar y entran a la que quieran;
   **Volver a la principal** los devuelve. Cambiar de sala tarda menos de un segundo y no
   vuelve a pedir cámara ni registro.
3. El host puede cerrar una subsala (su gente vuelve sola a la principal) o **Terminar
   reunión para todos**.

Lo mismo por API:

```bash
# crear 3 subsalas
curl -s -X POST http://localhost:8787/api/rooms/<roomId>/subsalas -H 'content-type: application/json' \
  -H 'x-host-key: <hostKey>' -d '{"cantidad":3}'
# cerrar la sala principal: cierra también todas sus subsalas
curl -s -X POST http://localhost:8787/api/rooms/<roomId>/close -H 'x-host-key: <hostKey>'
```

### Probar que el registro es obligatorio

```bash
# sin token: el WebSocket de la sala rechaza el upgrade antes de llegar al Durable Object
curl -i "http://localhost:8787/api/rooms/<roomId>/ws"
# -> 401 {"error":"token requerido"}

# el token lo devuelve /register y solo sirve para la sala con la que se pidió
curl -s -X POST http://localhost:8787/api/rooms/<roomId>/register -H 'content-type: application/json' \
  -d '{"nombre":"Ana","correo":"ana@ejemplo.com","rol":"participante"}'
```

El registro se hace en la sala principal; con el id de una subsala responde 409.

### Verificar en D1

```bash
cd backend
npx wrangler d1 execute meets-db --local --command "SELECT * FROM rooms"
npx wrangler d1 execute meets-db --local --command "SELECT * FROM users"
npx wrangler d1 execute meets-db --local --command "SELECT * FROM attendance"
npx wrangler d1 execute meets-db --local --command "SELECT * FROM ubicacion_grupo"
```

- `attendance` tiene una fila por tramo en cada sala. `left_reason` dice por qué terminó:
  `disconnect`, `moved` (pasó a otra sala de la reunión), `room_closed` u `orphan` (la
  cerró la reconciliación porque ya no había conexión).
- `ubicacion_grupo` dice en qué sala de la reunión está cada persona, con un `epoch` que
  sube en cada movimiento.
- `GET /api/rooms/<roomId>/attendance?grupo=1` devuelve toda la reunión con un resumen por
  persona: tiempo total (unión de tramos, así una pestaña duplicada no cuenta dos veces) y
  tiempo por sala.

Registrar el mismo `correo` dos veces reutiliza la misma fila de `users`.

### Probar el límite de 7 salas activas

```bash
for i in $(seq 1 7); do
  curl -s -X POST http://localhost:8787/api/rooms -H 'content-type: application/json' \
    -d "{\"nombre\":\"Sala $i\"}"
done
# la octava tiene que rechazar con 409:
curl -i -X POST http://localhost:8787/api/rooms -H 'content-type: application/json' \
  -d '{"nombre":"Sala 8"}'
```

Las subsalas no cuentan para este límite. El chequeo y el INSERT viven en una sola
sentencia SQL (`db.createRoomIfUnderLimit`, en `backend/src/db.ts`), así dos creaciones
concurrentes no pueden colarse las dos cuando queda un solo cupo: D1 serializa las
escrituras de una misma base, y esa sentencia compuesta es atómica sin `BEGIN/COMMIT`.

## 4. Endpoints del backend

| Método | Ruta | Qué hace |
|---|---|---|
| POST | `/api/rooms` | Crea una sala principal (409 si ya hay `MAX_ACTIVE_ROOMS` activas; ignora `tipo`). Devuelve `link`, `hostKey` y `hostLink` |
| GET | `/api/rooms` | Lista las salas principales activas |
| GET | `/api/rooms/:id` | Pre-chequeo de la pantalla de registro: 404 si no existe; si existe, `estado`, `tipo` y `parentRoomId` |
| POST | `/api/rooms/:id/close` | Cierra con `x-host-key`. En la principal cierra la reunión entera; en una subsala, solo esa, y su gente vuelve a la principal. Las salas creadas antes de la llave de host se cierran sin llave |
| GET | `/api/rooms/:id/attendance` | Asistencia de la sala (`?format=csv` para exportar; `?grupo=1` para toda la reunión, con resumen por persona) |
| POST | `/api/rooms/:id/subsalas` | Con `x-host-key`: crea subsalas (`cantidad` o `nombres`), hasta `MAX_SUBSALAS_PER_ROOM` abiertas |
| GET | `/api/rooms/:id/subsalas` | Con `x-credencial` o `x-host-key`: las salas de la reunión y cuántas personas hay en cada una |
| POST | `/api/rooms/:id/register` | Registro previo (nombre, correo y rol), solo en la sala principal. Devuelve `userId`, un `token` de 120 s y la `credencial` de grupo. Reutiliza el usuario si el correo ya existía |
| POST | `/api/rooms/:id/reauth` | Con la `credencial`: token nuevo para la sala donde D1 ubica a la persona, para reconectar. La sala viene en `room` |
| POST | `/api/rooms/:id/entrada` | Con la `credencial` y un `moveId`: token para entrar a otra sala de la reunión. La sala viene en `room` |
| GET | `/api/rooms/:id/ws?token=` | WebSocket de la sala. **Requiere** un token (401 si falta, venció o es de otra sala) |
| GET | `/api/rooms/:id/sfu/ice-servers` | Credenciales ICE (TURN, o STUN de respaldo) |
| POST | `/api/rooms/:id/sfu/session` | Crea la sesión SFU de la conexión |
| POST | `/api/rooms/:id/sfu/publish` | Publica tracks locales (offer → answer). Cada track se tiene que llamar `<userId>-<kind>` |
| POST | `/api/rooms/:id/sfu/adopt` | La sala adopta la sesión SFU y los tracks de quien llega desde otra sala de la reunión |
| POST | `/api/rooms/:id/sfu/subscribe` | Suscribe a tracks remotos, hasta 64 por llamada. Video limitado a `MAX_VISIBLE_TILES` (409 `video_tile_limit`); audio y pantalla sin límite |
| PUT | `/api/rooms/:id/sfu/unsubscribe` | Deja de recibir tracks, sin renegociar |
| PUT | `/api/rooms/:id/sfu/renegotiate` | Completa la renegociación al suscribirse |
| PUT | `/api/rooms/:id/sfu/track-quality` | Cambia la capa de simulcast de videos ya suscritos |
| PUT | `/api/rooms/:id/sfu/screen-share/stop` | Deja de compartir pantalla |
| PUT | `/api/rooms/:id/sfu/media-state` | Avisa a la sala si la cámara o el micrófono están apagados |
| GET | `/api/rooms/:id/participants` | Debug: participantes actuales del Durable Object |

Las rutas `/sfu/*` que llegan al Durable Object (todas menos `ice-servers`) exigen el
`connectionId` y el `connectionSecret` que la sala manda en el hello del WebSocket; sin el
secreto responden 403.

## 5. Decisiones de arquitectura

Comentadas también en el código; acá el resumen.

### Semanas 1 y 2

- **WebSocket Hibernation API** (`ctx.acceptWebSocket`, no `addEventListener`) en
  `RoomSession`: el runtime puede descargar el Durable Object de memoria entre eventos sin
  cerrar los sockets. Importa en un webinar de 300 personas, donde la mayoría de las
  conexiones están inactivas casi todo el tiempo.
- **Estado del participante en `ctx.storage`, no en un `Map` de JS**: sobrevive a la
  hibernación, y las lecturas son I/O local rápido.
- **La llegada a una sala escribe en D1 antes de aceptar el WebSocket.** Correcto y simple
  con pocos participantes; con 300 entradas simultáneas (el arranque de un webinar) serializa
  escrituras contra D1 y se vuelve el cuello de botella de la entrada.
- **`broadcast()` es O(n) por evento**: itera todos los WebSockets de la sala. Con 300
  participantes y mucha rotación puede generar ráfagas de mensajes; la salida natural es
  agrupar los `participant-joined`/`left`.
- **El servidor no llama a `closeTracks` cuando alguien se desconecta de golpe**: confía en
  el garbage collection de Cloudflare Realtime. Los demás clientes sueltan los tracks de
  quien se fue al recibir `participant-left`.
- Se eligió **no** usar `partytracks` a propósito, para entender y controlar el flujo de
  señalización SFU (sesión, publish, subscribe, renegotiate). El wrapper de
  `backend/src/realtime.ts` está verificado contra el código fuente de esa librería y del
  demo oficial `cloudflare/meet`.
- **Credencial de sesión sin estado**: `backend/src/session.ts` firma un token con
  HMAC-SHA256 sobre `SESSION_SIGNING_SECRET`, sin guardar sesiones en D1 ni KV, así no hay
  lookups extra al entrar. TTL corto (120 s): solo tiene que sobrevivir el tramo entre el
  registro y la apertura del WebSocket.
- **`GET /ws` verifica el token y pisa `userId` y `nombre` en la URL que reenvía al Durable
  Object** con los valores del token, no con los que mandó el cliente.

### Semana 3

- **Tope de video por cliente (`MAX_VISIBLE_TILES`, modelo Meet)**: suscribirse a todos
  los videos es inviable con 300 personas, ni el navegador los decodifica ni el egress de
  Cloudflare lo aguanta. El audio nunca se capa. El tope se valida en el Durable Object, no
  solo en el frontend, con dos cuidados verificados contra la documentación y la API real:
  - El `kind` que manda el cliente nunca decide qué cuenta contra el tope: se resuelve contra
    lo que cada participante publicó de verdad (`resolveKind`). Si no, alcanzaría con
    etiquetar un video como `audio`.
  - El cupo se reserva ANTES de llamar a Cloudflare. Los input gates de Durable Objects
    protegen operaciones de `ctx.storage`, pero no los `fetch()` salientes: mientras se
    espera la respuesta, el runtime puede procesar otra request al mismo objeto.
- **`PUT tracks/close` con `force: true` para desuscribirse**: no pide renegociación SDP,
  así que el cliente no toca su `RTCPeerConnection` solo para dejar de ver a alguien.
- **Cloudflare puede devolver 200 con errores por track** (`not_found_track_error` mientras
  el publicador todavía no manda paquetes). La reserva de cupo se corrige contra el
  resultado real, track por track, y el cliente reintenta: el video 3 veces cada 700 ms, y
  el audio y la pantalla en segundo plano durante unos 45 s.
- **Active speaker medido en el navegador**: Cloudflare no reenvía la extensión
  `ssrc-audio-level`, así que el nivel se mide con un `AnalyserNode` por participante. Cada
  participante remoto suena por su propio `<audio>`: Chromium no decodifica un track WebRTC
  remoto que solo va a WebAudio.
- **Simulcast de dos capas** con `sendEncodings`; cada cliente elige la capa de cada video
  con `tracks/update` (`preferredRid`), sin renegociar.
- **Cámara y micrófono apagados de verdad**: `replaceTrack(null)` deja de mandar RTP, en vez
  de solo `track.enabled = false`.

### Semana 4: subsalas

- **Cada subsala es su propio Durable Object**, y su relación con la principal vive en D1
  (`parent_room_id`).
- **D1 decide dónde está cada persona** (`ubicacion_grupo`, con un `epoch`). Moverse es
  una transacción de D1 que ejecuta la sala destino cuando la persona llega: sube el epoch,
  cierra la fila de asistencia anterior con `moved` y abre la nueva. Un `move_id` repetido
  no aplica nada dos veces.
- **Cambiar de sala reutiliza la PeerConnection y la sesión SFU**: se sueltan los tracks de
  la sala anterior y se piden los de la nueva. La sala destino adopta la sesión
  (`/sfu/adopt`) tomándola de D1, nunca del navegador.
- **Los avisos entre salas son de mejor esfuerzo**: van por `fetch()` a rutas `/internal/*`
  que el Worker no expone, y no por RPC, porque mezclar ambos en el mismo stub rompe el orden
  ([workerd #6561](https://github.com/cloudflare/workerd/issues/6561)). Si uno se pierde, la
  alarma de reconciliación de cada sala corrige contra D1 las conexiones fantasma, la
  asistencia huérfana y los cierres no avisados.
- **Llave de host**: 32 bytes aleatorios. En D1 solo queda su hash SHA-256, y se compara en
  tiempo constante. La **credencial de grupo** (HMAC, 12 h) permite entrar a cualquier sala
  de la reunión sin volver a registrarse; `/reauth` ya no acepta un `userId` solo.
- **Un secreto por conexión** (`connectionSecret`): conocer el `connectionId` de otra
  persona ya no alcanza para tocar su sesión SFU.
- **Suscripciones en vuelo**: un pedido de suscripción puede salir antes de un cambio de
  sala, o antes de que se vaya quien publica, y volver después. Cada respuesta se valida
  contra la sala actual y contra la conexión de quien publica, y lo que ya no corresponde
  se suelta. Si la respuesta SDP no se pudo entregar porque la sala anterior ya dio de
  baja la conexión, se entrega con la conexión nueva: sin ella, la sesión SFU rechaza todo
  pedido siguiente.
- **Cierres de WebSocket**: con `compatibility_date = "2024-09-23"`, el runtime no responde
  solo el cierre que pide el cliente, así que `webSocketClose` lo responde. Y como un cierre
  que inicia la sala no siempre termina de llegarle al cliente, la sala avisa antes por
  mensaje (`superseded`, `room-closed`, `subsala-closed`) y el cliente actúa con lo primero
  que llegue.

## 6. Fuera de alcance

No construido todavía: login y autenticación real, tablero, encuestas, UI de
administración y de creación de salas (se crean por API), y recuperar o rotar la llave de
host. El `rol` del registro (`participante` o `admin`) no habilita ni restringe nada: es
dato para el panel de administración. El schema de `polls`, `poll_votes` y
`whiteboard_sessions` está diseñado y comentado en `migrations/0001_init.sql`.

Sin probar todavía: subsalas con cientos de personas moviéndose a la vez, un Durable Object
que muere a mitad de la transacción de llegada, y transceivers acumulados después de muchos
cambios de sala.

## 7. Desplegar

El Worker se sirve en `https://api.connectedx.dpdns.org` (custom domain declarado en
`routes`, en `backend/wrangler.toml`) y el frontend en `https://connectedx.dpdns.org`.

```bash
cd backend
npm run db:migrate:remote   # primero la base: el Worker nuevo necesita las migraciones
npm run deploy              # la primera vez crea el registro DNS del custom domain
```

- La zona `connectedx.dpdns.org` tiene que estar en la misma cuenta de Cloudflare que el
  Worker; si no, el despliegue falla al crear el custom domain.
- Si es el primer Worker de la cuenta, Cloudflare no acepta el despliegue hasta que exista
  el subdominio `*.workers.dev` ("You need a workers.dev subdomain in order to proceed").
  Se registra abriendo una vez **Workers & Pages** en el dashboard y eligiendo el nombre.
- Los secretos de producción se cargan con `wrangler secret put` (ver 1.1). Son los mismos
  que en `.dev.vars`, sin `FRONTEND_BASE_URL`: ese valor ya está en `wrangler.toml`.
- El frontend es estático y `frontend/.env.production` ya apunta a la API. Se sirve con
  Cloudflare Pages, en el proyecto `meets-frontend`:

  ```bash
  cd frontend
  npm run build
  ../backend/node_modules/.bin/wrangler pages deploy dist --project-name meets-frontend
  ```

  Se usa el binario del repo por ruta: los comandos `pages` no toleran el `wrangler.toml`
  del Worker en la carpeta actual, y `npx wrangler` desde `frontend/` descargaría otra
  versión.

  `frontend/public/_redirects` manda cualquier ruta a `index.html`. Sin eso, abrir el link
  de una sala (`/r/<roomId>`) daría 404 en Pages.

  El dominio raíz se agrega una sola vez y a mano, porque `wrangler` no tiene comando para
  eso: dashboard → Workers & Pages → `meets-frontend` → Custom domains → Set up a custom
  domain → `connectedx.dpdns.org`. Mientras no se agregue, el sitio vive en
  `https://meets-frontend.pages.dev`.

  La app necesita el backend desplegado: hasta entonces carga, pero el registro y el video
  fallan.

La migración `0003_subsalas.sql` solo agrega columnas opcionales y una tabla: se puede
aplicar antes de desplegar el Worker nuevo sin afectar al que está corriendo.

## 8. Pruebas

Las pruebas de punta a punta están en [`tests/`](tests/README.md). Corren contra la app
local con el SFU real de Cloudflare; lo simulado son las personas y sus medios.

## 9. Qué se probó de punta a punta

### Semana 4 (subsalas)

Con `wrangler dev` y `vite` locales, el SFU real de Cloudflare y Chromium vía Playwright:

- moverse entre la principal y las subsalas desde el panel tardó entre 219 y 786 ms, siempre
  con una sola PeerConnection, y cada sala vio y escuchó solo a su gente;
- cerrar una subsala con gente la devolvió a la principal, y terminar la reunión cerró
  también las subsalas y dejó la asistencia sin filas abiertas y con sus motivos;
- entrar con la misma persona desde otra pestaña dejó la primera en "Abriste la reunión en
  otro lado";
- la alarma de reconciliación corrigió en su primera pasada (60 s) un movimiento con el
  aviso perdido, una fila de asistencia huérfana y un cierre de subsala no avisado;
- quien se reconecta vuelve a escucharse y a escuchar a los demás, medido con el borde de
  "hablando" y con los `<audio>` que suenan;
- con 16 participantes, la entrada tardó 2,36 s de mediana, el audio de los 15 llegó a los
  16, nunca hubo más de 10 videos y no hubo errores HTTP.

### Semana 2

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

### Semana 3, Parte A (tope de video)

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
  quedado afuera del cap: mismo resultado, y ningún otro tile se congela durante el
  intercambio (`currentTime` de cada `<video>` sigue avanzando),
- regresión de Semana 2 completa: dos usuarios reales viéndose/escuchándose, `GET /ws`
  sin token → 401, límite de 7 salas bajo concurrencia, sin sesiones de `attendance`
  menores a 1 segundo.
