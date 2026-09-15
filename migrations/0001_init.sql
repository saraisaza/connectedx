-- Semana 1: modelo de datos base (señalización + registro de asistencia).
-- SQLite (D1). Tipos de fecha: TEXT ISO-8601 (compatible con CURRENT_TIMESTAMP de SQLite).

CREATE TABLE rooms (
  id              TEXT PRIMARY KEY,                 -- también es el id del Durable Object (idFromName)
  nombre          TEXT NOT NULL,
  estado          TEXT NOT NULL DEFAULT 'activa'
                    CHECK (estado IN ('activa', 'cerrada')),
  tipo            TEXT NOT NULL DEFAULT 'principal'
                    CHECK (tipo IN ('principal', 'subsala')),
  parent_room_id  TEXT REFERENCES rooms(id),         -- nullable; para subsalas (Semana futura)
  creada_en       TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
  cerrada_en      TEXT
);

-- Solo se permite un máximo de 7 salas con estado = 'activa' a la vez.
-- Esa regla se aplica en el backend (Hono), no aquí, porque D1/SQLite no
-- soporta CHECK constraints que cuenten filas de la misma tabla.
CREATE INDEX idx_rooms_estado ON rooms(estado);
CREATE INDEX idx_rooms_parent_room_id ON rooms(parent_room_id);

CREATE TABLE users (
  id          TEXT PRIMARY KEY,
  nombre      TEXT NOT NULL,
  correo      TEXT,                                  -- sin validación real esta semana (Semana 2: registro completo)
  rol         TEXT NOT NULL DEFAULT 'participante'
                CHECK (rol IN ('participante', 'admin')),
  creado_en   TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
);

CREATE TABLE attendance (
  id          TEXT PRIMARY KEY,
  room_id     TEXT NOT NULL REFERENCES rooms(id),
  user_id     TEXT NOT NULL REFERENCES users(id),
  joined_at   TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
  left_at     TEXT                                    -- NULL mientras el participante sigue conectado
);

CREATE INDEX idx_attendance_room_id ON attendance(room_id);
CREATE INDEX idx_attendance_user_id ON attendance(user_id);

-- ---------------------------------------------------------------------------
-- Fuera de alcance esta semana. Dejamos el diseño planeado en comentarios
-- para que Semana 2+ no tenga que rediseñar el modelo desde cero.
-- ---------------------------------------------------------------------------

-- CREATE TABLE polls (
--   id            TEXT PRIMARY KEY,
--   room_id       TEXT NOT NULL REFERENCES rooms(id),
--   created_by    TEXT NOT NULL REFERENCES users(id),
--   pregunta      TEXT NOT NULL,
--   opciones      TEXT NOT NULL,   -- JSON array de opciones, ej: '["Sí","No"]'
--   estado        TEXT NOT NULL DEFAULT 'abierta' CHECK (estado IN ('abierta', 'cerrada')),
--   creada_en     TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
--   cerrada_en    TEXT
-- );

-- CREATE TABLE poll_votes (
--   id            TEXT PRIMARY KEY,
--   poll_id       TEXT NOT NULL REFERENCES polls(id),
--   user_id       TEXT NOT NULL REFERENCES users(id),
--   opcion_index  INTEGER NOT NULL,
--   votado_en     TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
--   UNIQUE (poll_id, user_id)   -- un voto por usuario por encuesta
-- );

-- CREATE TABLE whiteboard_sessions (
--   id            TEXT PRIMARY KEY,
--   room_id       TEXT NOT NULL REFERENCES rooms(id),
--   snapshot      TEXT,           -- JSON serializado del estado del tablero (o referencia a R2/KV si crece mucho)
--   actualizada_en TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
-- );
