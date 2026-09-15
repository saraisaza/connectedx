# Handoff: Sala de registro y sala en vivo — Enactus Meets

## Overview

Rediseño visual del frontend de una app de videollamadas para Enactus Colombia. Cubre dos pantallas: el **pre-join** (donde la persona se registra con nombre y correo antes de entrar) y la **sala en vivo** (grilla de video con speaker destacado y controles).

El código actual vive en `frontend/` — Vite + React 18 + TypeScript, sin framework de CSS, con estilos inline. La UI existente es HTML sin estilo. Este handoff es solo de presentación: la lógica de WebRTC (`src/sfu.ts`), la capa de API (`src/api.ts`) y el ruteo (`src/router.ts`) no cambian.

**Empezá por `PROMPT.md`** en esta misma carpeta — es el prompt listo para pegar en Claude Code. Este README es la especificación de respaldo.

## About the Design Files

`Sala Enactus.dc.html` es una **referencia de diseño creada en HTML** — un prototipo que muestra el look y el comportamiento buscados, no código de producción para copiar. La tarea es recrear ese diseño en el entorno que ya existe en `frontend/`: React 18 + TypeScript, estilos inline, sin dependencias nuevas de estilo.

Abrilo directamente en el navegador. Necesita `support.js` y `assets/` al lado (ya están incluidos). El archivo trae **dos layouts alternativos**:

- **1a — Split oscuro** *(el que se implementa)*: preview grande a la izquierda, panel de registro fijo a la derecha.
- **1b — Bloques amarillos**: panel amarillo pleno con los datos de la reunión, registro en columna a la derecha.

Ambos comparten tokens, tipografía y componentes. Este README especifica **1a**; donde 1b difiere se indica.

## Fidelity

**Alta fidelidad.** Colores, tipografía, espaciado y estados son finales. Recreá la UI con precisión usando los valores de este documento.

Dos salvedades:

- Los recuadros de video son **placeholders** (rayado diagonal + iniciales). En la implementación real van elementos `<video>` con el `MediaStream`.
- El contenido es de ejemplo: "Comité Nacional", "Valentina Ríos", "12 participantes", "19:00 GMT-5". Todo eso sale del backend o del estado en runtime.

Diseñado a **1440px de ancho, escritorio**. No hay specs móviles.

---

## Design Tokens

Extraelos a `src/theme.ts` como objeto `as const` y usalos en todos los estilos inline.

### Colores

| Token | Hex | Uso |
|---|---|---|
| `yellow` | `#FFC220` | Color de marca. Bordes de speaker, botón primario, badges activos, etiquetas de sección, iniciales de avatar. |
| `yellowHover` | `#FFD24D` | Hover del botón primario. |
| `yellowSoft` | `#FFD866` | Hover de links. |
| `ink` | `#15150F` | Texto sobre amarillo. Casi negro con calidez. |
| `bg` | `#08080A` | Fondo del documento. |
| `surface` | `#0D0D10` | Fondo de pantalla (canvas del app). |
| `surfaceRaised` | `#101014` | Barras superior e inferior. |
| `surfacePanel` | `#131317` | Panel de registro, panel lateral. |
| `surfaceInput` | `#0F0F13` | Fondo de campos de formulario. |
| `surfaceTile` | `#16161B` | Tiles de video, avatares. |
| `surfaceTileAlt` | `#14141A` | Tiles secundarios. |
| `surfaceControl` | `#17171C` | Botones de control inactivos. |
| `controlOff` | `#232329` | Fondo de mic/cámara/mano en off. |
| `border` | `#24242A` | Divisores, bordes de pantalla. |
| `borderSoft` | `#2A2A31` | Bordes de tiles secundarios. |
| `borderInput` | `#2E2E36` | Bordes de campos y botones fantasma. |
| `borderControl` | `#26262C` | Bordes de botones de control. |
| `textPrimary` | `#F5F5F0` | Texto principal. |
| `textHeading` | `#F7F7F2` | Titulares en Anton. |
| `textBody` | `#E8E8E2` | Nombres en tiles. |
| `textMuted` | `#9B9BA3` | Texto secundario. |
| `textDim` | `#85858E` | Labels de formulario, metadatos. |
| `textFaint` | `#6E6E78` | Placeholders de estado, notas al pie. |
| `textInput` | `#5F5F69` | Placeholder de inputs. |
| `danger` | `#F0563C` | Badge "En vivo", botón salir, errores de validación, mic silenciado. |
| `dangerHover` | `#FF7A64` | Hover del botón salir en 1b. |

Fondos con alpha:

- Badge sala abierta: `rgba(255,194,32,.12)` con borde `rgba(255,194,32,.35)`
- Badge en vivo: `rgba(240,86,60,.14)` con borde `rgba(240,86,60,.4)` (`.45` en la barra inferior)
- Checkbox marcado: `rgba(255,194,32,.15)` con borde `#FFC220`
- Overlays sobre video: `rgba(10,10,12,.82)` con `backdrop-filter: blur(6px)`
- Sobre fondo amarillo (1b): texto secundario `rgba(21,21,15,.78)`, terciario `rgba(21,21,15,.62)`, divisores `rgba(21,21,15,.22)`

### Tipografía

Tres familias, vía Google Fonts.

```html
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Anton&family=DM+Sans:wght@400;500;700&family=IBM+Plex+Mono:wght@400;500&display=swap" rel="stylesheet">
```

**Anton** (400, único peso) — titulares y botón primario. Siempre `text-transform: uppercase`. Es condensada y de alto impacto; nunca la uses para texto corrido.

| Uso | Tamaño | Tracking | Line-height |
|---|---|---|---|
| Titular de sala (1b) | 78px | — | .86 |
| Titular de registro (1a) | 52px | — | .9 |
| Nombre del speaker (spotlight) | 26–30px | — | normal |
| Título de barra superior (1b) | 24px | — | normal |
| Botón primario | 24–26px | .04em | normal |
| Nombre en tile grande | 22px | — | normal |
| Iniciales de avatar | 18–40px según tamaño | — | normal |

**DM Sans** (400, 500, 700) — texto de interfaz.

| Uso | Tamaño | Peso |
|---|---|---|
| Párrafo descriptivo | 15–17px / 1.5 | 400 |
| Input (valor y placeholder) | 15px | 400 |
| Nombre en overlay de video | 13px | 500 |
| Nombre en lista de participantes | 14px | 400 |
| Mensaje de chat | 14px / 1.5 | 400 |
| Texto de checkbox | 13px / 1.5 | 400 |

**IBM Plex Mono** (400, 500) — etiquetas, badges, metadatos, botones de control. Siempre mayúsculas con tracking amplio; es lo que le da el aire técnico al diseño.

| Uso | Tamaño | Peso | Tracking |
|---|---|---|---|
| Etiqueta de sección (amarilla) | 11px | 500 | .20em |
| Label de campo | 11px | 500 | .16em |
| Badge de estado | 11px | 500 | .16em |
| Botón de control | 12px | 500 | .12em |
| Metadato de barra superior | 12px | 500 | .08–.10em |
| Timestamp de chat | 10px | 500 | — |
| Micro-badge en tile | 10px | 500 | .12–.14em |

Aplicá `text-wrap: pretty` a los párrafos largos.

### Espaciado

Escala base de 4px. Valores efectivos: `4, 6, 8, 10, 12, 14, 16, 18, 20, 22, 26, 30, 34, 44, 46, 56`.

- Padding de barras: `0 30px` (1b) / `0 34px` (1a)
- Padding de paneles: `46px 44px` (1a) / `46px 64px` (1b)
- Gap entre campos de formulario: `16px`
- Gap label→input: `8px`
- Gap entre botones de control: `10–12px`

### Radios

| Valor | Uso |
|---|---|
| `999px` | Badges, avatares, botones de control en 1a, puntos de estado |
| `18px` | Tile del speaker, preview de cámara grande |
| `16px` | Contenedor de pantalla, tiles de grilla |
| `14px` | Preview de cámara chico (1b), overlay de nombre |
| `12px` | Tiles secundarios, botón primario, mensajes de chat, botones de rol |
| `10px` | Inputs, botones de control en 1b |
| `8px` | Botones dentro del switch de rol |
| `5px` | Checkbox |
| `2px` | Punto cuadrado del ícono de cámara |

### Sombras

- Contenedor de pantalla: `0 40px 80px -40px rgba(0,0,0,.9)`
- Speaker / preview con borde amarillo: `0 30px 70px -35px rgba(255,194,32,.45)` — el preview del pre-join usa `.45`, el speaker de la sala `.5`. Es el glow amarillo que hace que el borde no se sienta plano.

### Textura

Bandas diagonales, el motivo gráfico del diseño. Tres densidades:

```css
/* Fondo de pantalla, sutil */
repeating-linear-gradient(115deg, rgba(255,194,32,.04) 0 2px, transparent 2px 18px)

/* Fondo de pre-join, un poco más presente */
repeating-linear-gradient(115deg, rgba(255,194,32,.05) 0 2px, transparent 2px 16px)

/* Placeholder de video (reemplazar por el <video> real) */
repeating-linear-gradient(115deg, rgba(255,255,255,.045) 0 2px, transparent 2px 13px)

/* Panel amarillo en 1b */
repeating-linear-gradient(115deg, rgba(21,21,15,.08) 0 12px, transparent 12px 34px)
```

Siempre 115°, siempre sobre un `background-color` sólido.

### Animación

Una sola keyframe, para los puntos de estado:

```css
@keyframes livePulse { 0%,100% { opacity: 1 } 50% { opacity: .35 } }
```

- Punto "Sala abierta": `livePulse 2s ease-in-out infinite`
- Punto "En vivo": `livePulse 1.6s ease-in-out infinite` (más rápido = más urgente)

Los hover son cambios de color instantáneos, sin transición declarada. Si agregás transiciones, `120ms ease` como máximo — la interfaz debe sentirse inmediata.

---

## Screens / Views

El tipo `Screen` en `App.tsx` tiene cinco valores: `'loading' | 'not-found' | 'closed' | 'form' | 'call'`. El diseño cubre `form` y `call`; los otros tres comparten un layout de estado simple descrito al final.

### 1. Pre-join (`screen === 'form'`)

**Propósito:** la persona revisa cómo se ve y se oye, elige rol, escribe nombre y correo, y entra.

**Layout:** contenedor de 1440×880, `border-radius: 16px`, `overflow: hidden`, fondo `#0D0D10`, borde `1px solid #24242A`. Columna vertical: barra superior de 78px fija, luego el cuerpo en `grid-template-columns: 1fr 480px`.

#### Barra superior (78px)

Fondo `#101014`, borde inferior `1px solid #24242A`, `padding: 0 34px`, `justify-content: space-between`.

*Izquierda*, gap 22px: logo (`src/media/mainlogo.avif`, altura 44px) → divisor vertical de 1×26px en `#2C2C33` → código de sala en mono 11px/.18em mayúsculas `#8A8A93`. Usá un guion no separable en el código de sala.

*Derecha*, gap 26px: hora en mono 12px/.08em `#9B9BA3` → badge "SALA ABIERTA" → "Ayuda" en 14px `#85858E`.

El badge es un pill: `padding: 7px 14px`, `border-radius: 999px`, fondo `rgba(255,194,32,.12)`, borde `1px solid rgba(255,194,32,.35)`, con un punto de 7px `#FFC220` pulsando a 2s y el texto en mono 11px/.16em `#FFC220`.

#### Columna izquierda — preview

Fondo `#0D0D10` + textura diagonal `.05`. Centrado vertical y horizontal, `padding: 44px 56px`, gap 26px.

**Tile de cámara:** ancho máximo 720px, `aspect-ratio: 16/9`, **`border: 4px solid #FFC220`**, `border-radius: 18px`, `overflow: hidden`, fondo `#15151A`, más el glow amarillo. Este borde es el elemento de marca principal de la pantalla — no lo reduzcas ni lo cambies por un outline.

Tres estados:

- *Cámara encendida:* el `<video>` con `autoPlay playsInline muted`, `object-fit: cover`, ocupando el tile.
- *Cámara apagada:* fondo `#16161B`, círculo de 108px con `border: 3px solid #FFC220` e iniciales en Anton 40px amarillo, y debajo "CÁMARA APAGADA" en mono 11px/.20em `#6E6E78`.
- *Permiso denegado:* mismo layout que apagada, con el texto cambiado y una nota corta explicando cómo habilitar la cámara.

*Overlay de nombre:* abajo a la izquierda, `left/bottom: 18px`, pill `rgba(10,10,12,.82)` con `backdrop-filter: blur(6px)`, `padding: 8px 15px`. Punto de 7px que cambia de color según el mic (`#FFC220` activo / `#F0563C` silenciado) y el texto "Tú · Nombre" en 13px/500 `#F5F5F0`.

**Controles**, fila con gap 12px, altura 48px, `border-radius: 999px`, `padding: 0 20px`, tipografía mono 12px/.12em mayúsculas:

| Botón | Activo | Inactivo |
|---|---|---|
| Mic | fondo `#FFC220`, texto `#15150F`, label "MIC ACTIVO" | fondo `#232329`, texto `#C9C9D1`, label "SILENCIADO" |
| Cámara | fondo `#FFC220`, texto `#15150F`, label "CÁMARA" | fondo `#232329`, texto `#C9C9D1`, label "CÁMARA OFF" |
| Dispositivos | fondo `#17171C`, borde `1px solid #26262C`, texto `#9B9BA3` | hover: borde y texto pasan a `#FFC220` |

Mic y cámara llevan un indicador de `currentColor` a la izquierda: círculo de 7px el mic, cuadrado de 8px con `border-radius: 2px` la cámara.

**Fila de asistentes:** stack de avatares de 34px superpuestos con `margin-left: -10px` y `border: 2px solid #0D0D10` (el color del fondo, para que se recorten entre sí). El primero es amarillo con texto oscuro, el resto `#2A2A31`, y el último es un contador `+N` en `#17171C` con texto `#9B9BA3`. Al lado, "N personas ya están dentro" en 14px `#85858E`.

#### Columna derecha — registro (480px)

Fondo `#131317`, borde izquierdo `1px solid #24242A`, `padding: 46px 44px`, columna con gap 26px.

1. **Encabezado:** etiqueta "REGISTRO DE ASISTENCIA" en mono 11px/.20em `#FFC220` → nombre de la sala en **Anton 52px**, `line-height: .9`, mayúsculas, `#F7F7F2` (viene de `roomInfo.nombre`; contemplá nombres de dos líneas) → descripción en 15px/1.5 `#9B9BA3`.
2. **Divisor** de 1px `#24242A`.
3. **Switch de rol:** label "ENTRAS COMO" en mono 11px/.16em `#85858E`. Debajo, contenedor con `padding: 5px`, fondo `#0F0F13`, borde `1px solid #26262C`, `border-radius: 12px`, con dos botones `flex: 1` de 42px y `border-radius: 8px`. El activo va amarillo con texto `#15150F`; el inactivo transparente con texto `#9B9BA3`. **Mapea a `rol: 'participante' | 'admin'`** — el backend no acepta otros valores.
4. **Campos:** "NOMBRE COMPLETO" y "CORREO". Label en mono 11px/.16em `#85858E`, gap 8px al input. Input de 54px, `box-sizing: border-box`, `padding: 0 16px`, fondo `#0F0F13`, borde `1px solid #2E2E36`, `border-radius: 10px`, texto DM Sans 15px `#F5F5F0`, `outline: none`. **Focus:** el borde pasa a `#FFC220`. Placeholder `#5F5F69`.
5. **Checkbox de código de conducta:** cuadrado de 20px, `border-radius: 5px`, borde `#FFC220`, fondo `rgba(255,194,32,.15)` cuando está marcado. Texto 13px/1.5 `#9B9BA3` al lado.
6. **Botón primario:** 60px de alto, ancho completo, `border-radius: 12px`, fondo `#FFC220`, texto `#15150F` en **Anton 24px** mayúsculas con `.04em`. Hover `#FFD24D`. Va empujado al fondo con `margin-top: auto`. Estado `joining`: label "ENTRANDO…", `disabled`, `opacity: .6`, `cursor: not-allowed`.
7. **Nota al pie:** mono 11px/.10em `#6E6E78`, centrada.

**Errores de validación:** en mono 12px `#F0563C`, debajo del campo que falló, y el borde del input pasa a `#F0563C`. Las reglas actuales de `App.tsx` se mantienen: nombre no vacío, y `EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/` para el correo. Los errores de red van arriba del botón con el mismo tratamiento.

### 2. Sala en vivo (`screen === 'call'`)

Mismo contenedor de 1440×880. Tres franjas: barra superior 78px, cuerpo flexible, barra de controles 96px.

#### Barra superior

Igual que en pre-join, con: logo 44px → divisor → nombre de la sala en 15px/500 `#F5F5F0` → **badge "EN VIVO mm:ss"** en rojo (`rgba(240,86,60,.14)`, borde `rgba(240,86,60,.4)`, punto `#F0563C` pulsando a 1.6s, texto `#F0563C`). A la derecha: contador de participantes en mono 12px `#9B9BA3` y botón "INVITAR" fantasma de 40px (borde `#2E2E36`, hover a amarillo).

El cronómetro arranca al entrar a la sala y se formatea `mm:ss`.

#### Cuerpo — vista Speaker (por defecto)

Fondo `#0D0D10` + textura `.04`, `padding: 30px 34px`, `grid-template-columns: 1fr 296px`, gap 22px.

**Tile del speaker:** **`border: 5px solid #FFC220`**, `border-radius: 18px`, glow `0 30px 70px -35px rgba(255,194,32,.5)`. Es el elemento más importante de la pantalla: el borde amarillo es lo que identifica quién está hablando.

- *Badge "HABLANDO"*, arriba a la izquierda a 22px: pill sólido `#FFC220` con texto `#15150F` en mono 11px/.16em y un punto oscuro de 7px.
- *Placa de identidad*, abajo a la izquierda a 22px: `rgba(10,10,12,.82)` con blur, `border-radius: 14px`, `padding: 12px 18px`. Nombre en **Anton 26px** `#F7F7F2` y, debajo, rol/capítulo en mono 11px/.16em `#FFC220`.

**Columna lateral (296px):** tiles 16:9 con gap 14px, `border-radius: 12px`, borde `1px solid #2A2A31`. Nombre abajo a la izquierda en 13px/500 `#E8E8E2`. Sin video, muestran un círculo de 58px con borde amarillo de 2px e iniciales en Anton 20px. Los micro-badges (mano levantada) van arriba a la derecha en mono 10px/.14em `#FFC220`. Al final, un tile de overflow con `border: 1px dashed #2E2E36` y "+N PARTICIPANTES" en mono 11px/.16em `#6E6E78`; hover a amarillo.

#### Cuerpo — vista Cuadrícula (alternativa)

`grid-template-columns: 1fr 1fr`, `grid-template-rows: 1fr 1fr`, gap 20px, `border-radius: 16px`. El speaker activo mantiene su borde amarillo de 5px con glow; el resto lleva `1px solid #2A2A31`. Nombres en Anton 22px sobre el tile del speaker y en 15px/500 sobre los demás. El badge "HABLANDO" se reduce a mono 10px/.16em con `padding: 5px 10px`.

Con más de 4 participantes, paginá o pasá a auto-fit manteniendo el 16:9.

#### Barra de controles (96px)

Fondo `#101014`, borde superior `1px solid #24242A`, botones centrados con gap 12px, altura 50px, `border-radius: 999px`, `padding: 0 22px`, mono 12px/.12em mayúsculas.

Orden: Mic · Cámara · Compartir · Mano · Chat · divisor de 1×34px `#26262C` con `margin: 0 8px` · Salir.

Mic, cámara y mano usan el patrón activo/inactivo de la tabla anterior (amarillo `#FFC220`+`#15150F` cuando están activos, `#232329`+`#C9C9D1` cuando no). Compartir y Chat son fantasma (`#17171C`, borde `#26262C`, texto `#9B9BA3`, hover a amarillo). **Salir** va aparte: fondo `rgba(240,86,60,.14)`, borde `1px solid rgba(240,86,60,.45)`, texto `#F0563C`, `padding: 0 24px`; en hover se invierte a fondo `#F0563C` con texto `#15150F`.

### 3. Pantallas de estado (`loading`, `not-found`, `closed`)

No están en el prototipo. Un solo componente `StatusScreen` sobre fondo `#08080A` con la textura `.04`: logo centrado a 44px, titular en Anton 44px `#F7F7F2` y texto en 15px/1.5 `#9B9BA3`, ancho máximo 480px, todo centrado. Copys actuales de `App.tsx`:

- `loading` — "Cargando…"
- `not-found` — "Sala no encontrada" / "Este link no corresponde a ninguna sala. Pedile al organizador que te comparta uno nuevo."
- `closed` — "Sala cerrada" / `"{roomInfo.nombre}" ya terminó. Pedile al organizador que te comparta el link de una sala activa.`
- Sin `roomId` — "meets" / "Abrí el link que te compartieron para entrar a una sala."

En `closed` y sin `roomId`, un botón secundario fantasma es opcional.

---

## Interactions & Behavior

**Toggle de mic:** `localStream.getAudioTracks().forEach(t => t.enabled = !t.enabled)`. Actualiza el fondo del botón, el label y el punto del overlay de nombre. **Es solo local** — los demás participantes no se enteran. Dejá un `TODO` para el mensaje de señalización.

**Toggle de cámara:** igual con `getVideoTracks()`. Cuando está en off, el tile muestra el avatar con iniciales.

**Mano levantada:** solo visual por ahora — cambia el botón a amarillo y muestra el badge en el tile propio.

**Permisos de cámara:** pedí `getUserMedia({ audio: true, video: true })` al entrar a la pantalla `form`, no en el submit. Estados a manejar: pendiente (skeleton en el tile), concedido (preview), denegado (`NotAllowedError` → avatar + aviso), sin dispositivo (`NotFoundError` → aviso distinto). Guardá el stream en `localStream` y reusalo en `handleSubmit` para no pedirlo dos veces.

**Submit:** valida nombre y correo → `getUserMedia` (o reusa el stream) → `registerForRoom` → construye el `SFUClient` → `client.join(stream)` → `setScreen('call')`. Durante todo eso, `joining = true` deshabilita el formulario. Los errores vuelven al formulario con el mensaje visible; el flujo actual de `App.tsx` ya hace esto y no debería cambiar.

**Salir:** llama a `leave()`, que cierra el `SFUClient`, para los tracks, limpia participantes y vuelve a `screen: 'form'`. Considerá un diálogo de confirmación (no está diseñado — preguntá antes de agregarlo).

**Speaker activo:** hoy no hay detección de voz. Por ahora, fijá el speaker en el anfitrión o en el primer participante remoto, y dejá un `TODO`. Cuando exista, animá el cambio de borde en ~200ms.

**Hover:** todos los botones fantasma pasan borde y texto a `#FFC220`. El botón primario aclara a `#FFD24D`. Los inputs pasan el borde a `#FFC220` en focus.

**Foco de teclado:** el prototipo no lo especifica. Usá un anillo `2px solid #FFC220` con `outline-offset: 2px` en todos los interactivos — no lo elimines.

**Responsive:** fuera de alcance. El diseño asume 1440px. Si necesitás un mínimo, `min-width: 1100px` con scroll horizontal es aceptable como puente.

---

## State Management

Lo que ya existe en `App.tsx` y se mantiene: `roomId`, `screen`, `roomInfo`, `nombre`, `correo`, `rol`, `joining`, `error`, `status`, `localStream`, `participants`, y el `sfuRef`.

Nuevo, todo local a la UI:

| Estado | Tipo | Uso |
|---|---|---|
| `micOn` | `boolean` | Estilo del botón de mic y punto del overlay. Default `true`. |
| `camOn` | `boolean` | Preview vs avatar. Default `true`. |
| `handRaised` | `boolean` | Botón de mano y badge en el tile. Default `false`. |
| `permission` | `'pending' \| 'granted' \| 'denied' \| 'no-device'` | Qué se muestra en el tile de preview. |
| `viewMode` | `'speaker' \| 'grid'` | Layout del cuerpo de la sala. Default `'speaker'`. |
| `elapsed` | `number` | Segundos desde que se entró, para el badge "EN VIVO". |
| `fieldErrors` | `{ nombre?: string; correo?: string }` | Errores por campo, separados del `error` global. |

Sin fetching nuevo. Los endpoints existentes (`fetchRoom`, `registerForRoom`, `fetchIceServers`) son suficientes.

**Fuera de alcance — está dibujado pero no tiene backend:** chat, lista de participantes con aprobación de invitados, compartir pantalla, grabación, agenda y horarios de la reunión, avatares de usuario, y la propagación de mute/mano al resto. No cablees nada de esto contra endpoints inexistentes.

---

## Assets

En `assets/` de este bundle, copiados desde `frontend/src/media/`:

| Archivo | Notas |
|---|---|
| `mainlogo.avif` / `.png` | Logo principal, 375×250. Blanco + flecha amarilla, para fondo oscuro. |
| `mainlogo2.avif` / `.png` | Variante alterna. |
| `enactus-logo.avif` | Copia de `mainlogo.avif` usada por el prototipo. |

**Ojo con el logo:** el wordmark ocupa solo la banda central del archivo, así que a menos de 40px de alto el texto se vuelve ilegible. Por eso el diseño lo usa a **44px** en barras oscuras. Si vas a usarlo más chico, recortá el espacio muerto del archivo primero. Servilo con `<picture>` (AVIF con fallback PNG) y `alt="Enactus Colombia"`.

Los favicons (`favicon.ico`, `favicon-16x16.png`, `favicon-32x32.png`) ya están en `src/media/` pero **no están referenciados en `index.html`** — agregalos.

Sin librería de íconos: los indicadores son formas CSS (círculos y cuadrados con `border-radius`) y flechas de texto (`↑`). Si agregás íconos, elegí un set de trazo fino y uniforme.

---

## Files

**En este bundle:**

- `PROMPT.md` — el prompt para pegar en Claude Code. Empezá acá.
- `README.md` — este documento.
- `Sala Enactus.dc.html` — el prototipo. Abrilo en el navegador.
- `support.js` — runtime que necesita el prototipo. No es parte de la app.
- `assets/` — logos y variantes.

**En el repo, a modificar:**

- `frontend/index.html` — fonts, favicons, `<title>`.
- `frontend/src/App.tsx` — hoy tiene las cinco pantallas inline; se divide en componentes.

**En el repo, a crear:**

- `frontend/src/theme.ts` — tokens.
- `frontend/src/screens/PreJoinScreen.tsx`, `CallScreen.tsx`, `StatusScreen.tsx`
- `frontend/src/components/Logo.tsx`, `VideoTile.tsx`, `ControlButton.tsx`, `LiveBadge.tsx`

**En el repo, sin tocar:**

- `frontend/src/sfu.ts`, `src/api.ts`, `src/router.ts`, `src/main.tsx`
