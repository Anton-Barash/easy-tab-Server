-- ============================================================
-- Migration: 009_add_verification_code
-- Description: Добавляет внутренний секретный код подлинности отчёта.
--              Генерируется при создании отчёта и хранится на сервере;
--              по паре (id + verification_code) можно установить подлинность
--              отчёта и узнать его автора.
-- Date: 2026-09-11
-- ============================================================

BEGIN;

ALTER TABLE reports
    ADD COLUMN IF NOT EXISTS verification_code TEXT;

COMMENT ON COLUMN reports.verification_code
    IS 'Внутренний секретный код подлинности отчёта (не отдаётся в списке)';

-- Заполняем verification_code для существующих отчётов (64 hex-символа),
-- используя только встроенные функции (по образцу public_id в миграции 006).
UPDATE reports
SET verification_code =
    md5(random()::text || id::text || clock_timestamp()::text)
    || md5(random()::text || id::text || clock_timestamp()::text)
WHERE verification_code IS NULL;

COMMIT;