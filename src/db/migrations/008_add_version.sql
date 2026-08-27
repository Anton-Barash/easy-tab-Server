-- ============================================================
-- Migration: 008_add_version
-- Description: Добавляет столбец version в таблицу reports
--              для optimistic locking при совместном редактировании.
-- Date: 2026-08-27
-- ============================================================

BEGIN;

ALTER TABLE reports
    ADD COLUMN IF NOT EXISTS version INT NOT NULL DEFAULT 1;

COMMENT ON COLUMN reports.version IS 'Номер версии отчета для optimistic locking.';

COMMIT;
