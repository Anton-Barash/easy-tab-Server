-- ============================================================
-- Migration: 005_add_report_data
-- Description: Добавляет столбец report_data в таблицу reports
--              для хранения JSON-данных отчёта в PostgreSQL.
-- Date: 2026-07-20
-- ============================================================

BEGIN;

ALTER TABLE reports
    ADD COLUMN IF NOT EXISTS report_data JSONB;

COMMENT ON COLUMN reports.report_data IS 'JSON-данные отчёта (основное хранилище). KS3-копия оставлена как бекап.';

CREATE INDEX IF NOT EXISTS idx_reports_report_data_gin
    ON reports USING GIN (report_data);

COMMIT;
