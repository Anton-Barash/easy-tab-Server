-- ============================================================
-- Migration: 006_add_public_id
-- Description: Добавляет публичный короткий идентификатор отчёта,
--              используемый вместо числового id в URL просмотра.
-- Date: 2026-07-27
-- ============================================================

BEGIN;

ALTER TABLE reports
    ADD COLUMN IF NOT EXISTS public_id TEXT UNIQUE;

COMMENT ON COLUMN reports.public_id IS 'Публичный короткий идентификатор отчёта для URL (вместо числового id)';

CREATE INDEX IF NOT EXISTS idx_reports_public_id
    ON reports(public_id);

-- Заполняем public_id для существующих отчётов
UPDATE reports
SET public_id = substr(md5(random()::text || id::text || clock_timestamp()::text), 1, 10)
WHERE public_id IS NULL;

COMMIT;
