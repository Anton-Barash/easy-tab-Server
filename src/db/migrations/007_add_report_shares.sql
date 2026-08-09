-- ============================================================
-- Migration: 007_add_report_shares
-- Description: Добавляет временные share-ссылки для отчётов
--              и логи доступа по ним.
-- Date: 2026-08-02
-- ============================================================

BEGIN;

-- ------------------------------------------------------------
-- Таблица report_shares
-- Временные публичные ссылки на отчёты.
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS report_shares (
    id BIGSERIAL PRIMARY KEY,

    -- Отчёт, к которому открывается доступ
    report_id BIGINT NOT NULL REFERENCES reports(id) ON DELETE CASCADE,

    -- Уникальный токен ссылки (UUID без дефисов или nanoid)
    token TEXT NOT NULL UNIQUE,

    -- Срок действия ссылки
    expires_at TIMESTAMPTZ NOT NULL,

    -- Активна ли ссылка (можно отключить досрочно)
    is_active BOOLEAN NOT NULL DEFAULT true,

    -- Права: edit — редактирование, view — только просмотр
    permissions TEXT NOT NULL DEFAULT 'edit'
        CHECK (permissions IN ('edit', 'view')),

    -- Кто создал ссылку
    created_by BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,

    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_report_shares_token
    ON report_shares(token);

CREATE INDEX IF NOT EXISTS idx_report_shares_report
    ON report_shares(report_id);

-- ------------------------------------------------------------
-- Таблица report_share_logs
-- Логи открытия share-ссылок.
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS report_share_logs (
    id BIGSERIAL PRIMARY KEY,

    -- Ссылка, по которой перешли
    share_id BIGINT NOT NULL REFERENCES report_shares(id) ON DELETE CASCADE,

    -- Метаданные запроса
    ip INET,
    user_agent TEXT,

    -- Авторизованный пользователь (если есть)
    user_id BIGINT REFERENCES users(id) ON DELETE SET NULL,

    -- Анонимный идентификатор из localStorage (для неавторизованных)
    anonymous_id TEXT,

    -- Действие: welcome_open, edit_open, html_open, zip_download, save
    action TEXT NOT NULL,

    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_report_share_logs_share
    ON report_share_logs(share_id);

CREATE INDEX IF NOT EXISTS idx_report_share_logs_created_at
    ON report_share_logs(created_at);

COMMENT ON TABLE report_shares IS 'Временные публичные share-ссылки на отчёты';
COMMENT ON TABLE report_share_logs IS 'Логи доступа по share-ссылкам';

COMMIT;
