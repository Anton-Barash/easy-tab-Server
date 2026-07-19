-- Migration: 004_add_is_public
-- Description: Добавляет столбец is_public в таблицу reports для управления публичным доступом
-- Date: 2026-07-18

BEGIN;

ALTER TABLE reports
ADD COLUMN IF NOT EXISTS is_public BOOLEAN NOT NULL DEFAULT FALSE;

COMMENT ON COLUMN reports.is_public IS 'Публичный доступ к отчёту (true - доступен без авторизации, false - только владельцу)';

COMMIT;
