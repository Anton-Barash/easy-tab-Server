-- ============================================================
-- Migration: 011_add_reports_updated_at
-- Description: Добавляет updated_at (дату последнего изменения отчёта).
--              Обновляется при каждом сохранении/слиянии на сервере и
--              возвращается списком /reports, чтобы клиент показывал
--              «дату изменения» в списке отчётов.
-- Date: 2026-09-12
-- ============================================================

BEGIN;

ALTER TABLE reports
    ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ;

-- Для существующих отчётов датой изменения считаем дату создания.
UPDATE reports
SET updated_at = created_at
WHERE updated_at IS NULL;

ALTER TABLE reports
    ALTER COLUMN updated_at SET DEFAULT now(),
    ALTER COLUMN updated_at SET NOT NULL;

COMMENT ON COLUMN reports.updated_at
    IS 'Дата последнего изменения отчёта на сервере (обновляется при save/patch)';

COMMIT;