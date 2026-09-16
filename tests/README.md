# Pruebas de punta a punta

Corren contra la app levantada en local: `wrangler dev` (Worker, Durable Objects y D1
locales) y `vite`, con las credenciales reales de Cloudflare Realtime. No hay mocks: el
SFU es el de Cloudflare. Lo simulado son las personas y sus medios (video de canvas y
audio de oscilador) y, en `subsalas-alarma.mjs`, la pérdida de avisos entre salas.

## Antes de correrlas

1. Backend y frontend corriendo, con la base local migrada (ver el README principal):

   ```bash
   cd backend && npm run db:migrate:local && npm run dev   # http://localhost:8787
   cd frontend && npm run dev                               # http://localhost:5173
   ```

   `backend/.dev.vars` tiene que incluir `FRONTEND_BASE_URL=http://localhost:5173`: las
   pruebas abren el `link` que devuelve la API, y en `wrangler.toml` ese valor es el del
   dominio de producción.

2. Dependencias de las pruebas:

   ```bash
   cd tests
   npm install
   npx playwright install chromium
   ```

Cada prueba crea sus propias salas y las cierra al terminar. Esas salas cuentan para el
límite de 7 salas activas, así que conviene correr las pruebas de a una.

## Qué verifica cada una

| Comando | Qué verifica | Duración aprox. |
|---|---|---|
| `npm run api` | Límite de salas sin subsalas, llave de host, tope de subsalas, credencial de grupo, secreto de conexión, movimiento con epoch y la misma sesión SFU, idempotencia por `move_id`, cierres con gente adentro y resumen de asistencia. Clientes WebSocket de Node, sin navegador. | unos segundos |
| `npm run e2e` | La app con un host y 5 participantes: crear subsalas desde el panel, entrar y volver, aislamiento de video y audio por sala, cerrar una subsala con gente, reconexión a la subsala, otra pestaña de la misma persona, terminar la reunión y la asistencia que queda. | 1 min |
| `npm run alarma` | La alarma de reconciliación corrige tres avisos perdidos: un movimiento, una fila de asistencia huérfana y el cierre de una subsala. Provoca la pérdida escribiendo directo en la D1 **local**. | 1 min |
| `npm run reconexion` | Quien se reconecta vuelve a escucharse y a escuchar a los demás, medido en la app: el borde de "hablando" y los `<audio>` que suenan. | 30 s |
| `npm run grid-16` | 16 participantes: paginación real, nunca más de 10 videos, el audio de los 15 llega a los 16 y quien habla sube a la página visible. Deja un resumen en `resultados/`. | 5 min |

Resultados de referencia, en una sola laptop, el 14 de septiembre de 2026: 40/40, 19/19 en
seis corridas seguidas, 10/10, 7/7 y 10/10.

## Cuidados

- `grid-16` reparte las 16 pestañas en dos procesos de Chromium (`N_BROWSERS=2`). Con las
  16 en un solo proceso, el Chromium de prueba deja de arrancar `AudioContext` desde la
  undécima pestaña; es del navegador de prueba, no de la app.
- Todo corre en una sola máquina con una sola conexión, así que los tiempos medidos son
  cotas superiores.
- Si una corrida de `grid-16` muestra una reconexión (sección `[red]`), revisa la línea de
  tiempo antes de culpar a la app: con 16 pestañas en una laptop, a veces ICE no conecta
  a la primera y la app se reconecta sola, como debe.
- Las carreras de los cambios de sala no aparecen en todas las corridas: conviene correr
  `e2e` varias veces seguidas. Cuando algo falla, imprime la señalización y las
  suscripciones de cada pestaña alrededor del error, y los avisos `[sfu]` de la app.
- En una corrida de `grid-16`, Cloudflare respondió `not_found_track_error` durante más de
  un minuto para el audio de un participante que sí estaba publicando, y los demás dejaron
  de reintentar a los 45 s. No se repitió en la corrida siguiente ni se encontró la causa.
