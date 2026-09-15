-- Migration number: 0002 	 2026-08-19T22:32:06.576Z

-- Registro previo (Semana 2): un usuario por correo. Reutilizamos la fila
-- existente (por id) en vez de duplicar cuando el mismo correo se registra
-- de nuevo (ver db.ts: upsertUserByEmail). SQLite trata cada NULL como
-- distinto para UNIQUE, así que esto no rompe las filas locales de Semana 1
-- que tienen correo NULL.
CREATE UNIQUE INDEX idx_users_correo ON users(correo);
