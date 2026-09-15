-- Migration number: 0003
-- Semana 4: subsalas (ver el documento de diseño "Subsalas sin split-brain").

-- Llave de host: solo se guarda su hash SHA-256 (hex). NULL en las salas
-- creadas antes de esta migración, que se siguen pudiendo cerrar sin llave
-- pero no pueden tener subsalas.
ALTER TABLE rooms ADD COLUMN host_key_hash TEXT;

-- Por qué terminó cada tramo de asistencia. NULL mientras la fila sigue
-- abierta y en las filas anteriores a esta migración.
ALTER TABLE attendance ADD COLUMN left_reason TEXT
  CHECK (left_reason IS NULL OR left_reason IN ('disconnect', 'moved', 'room_closed', 'orphan'));

-- Fuente autoritativa de "dónde debe estar cada persona" dentro de un grupo
-- (la sala principal y sus subsalas). Los Durable Objects solo guardan quién
-- está conectado ahora y convergen a esta tabla. `epoch` sube en cada
-- movimiento: una conexión con un epoch menor al de esta fila es un fantasma.
-- `move_id` hace idempotente un movimiento reintentado.
CREATE TABLE ubicacion_grupo (
  group_room_id   TEXT NOT NULL REFERENCES rooms(id),
  user_id         TEXT NOT NULL REFERENCES users(id),
  room_id         TEXT NOT NULL REFERENCES rooms(id),
  epoch           INTEGER NOT NULL DEFAULT 1,
  move_id         TEXT,
  sfu_session_id  TEXT,
  updated_at      TEXT NOT NULL,
  PRIMARY KEY (group_room_id, user_id)
);

CREATE INDEX idx_ubicacion_grupo_room_id ON ubicacion_grupo(room_id);
CREATE INDEX idx_attendance_room_open ON attendance(room_id, left_at);
