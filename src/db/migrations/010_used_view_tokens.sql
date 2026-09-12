-- ============================================================
-- Migration: 010_used_view_tokens
-- Description: Таблица одноразовых view-токенов (обмен короткого
--              токена на HttpOnly cookie). Хранится в БД, а не в памяти
--              процесса, чтобы одноразовость работала и в кластер-режиме
--              (несколько воркеров делят одну БД).
-- Date: 2026-09-12
-- ============================================================

BEGIN;

CREATE TABLE IF NOT EXISTS used_view_tokens (
    token_hash VARCHAR(64) PRIMARY KEY,
    expires_at BIGINT NOT NULL,
    created_at  BIGINT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_used_view_tokens_expires
    ON used_view_tokens (expires_at);

COMMIT;