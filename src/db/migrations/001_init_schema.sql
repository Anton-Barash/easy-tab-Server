-- ============================================================
-- Система управления доступом к отчётам
-- Версия: 1.0
-- СУБД: PostgreSQL 12+
-- ============================================================

BEGIN;

-- Таблица пользователей
CREATE TABLE IF NOT EXISTS users (
    id BIGSERIAL PRIMARY KEY,
    username TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    email TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Таблица компаний
CREATE TABLE IF NOT EXISTS companies (
    id BIGSERIAL PRIMARY KEY,
    name TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Связь пользователей с компаниями (many-to-many)
CREATE TABLE IF NOT EXISTS company_members (
    user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    company_id BIGINT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    role TEXT NOT NULL DEFAULT 'member',
    joined_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, company_id)
);

-- Таблица отчётов
CREATE TABLE IF NOT EXISTS reports (
    id BIGSERIAL PRIMARY KEY,
    title TEXT NOT NULL,
    file_path TEXT NOT NULL,
    creator_user_id BIGINT NOT NULL REFERENCES users(id),
    company_id BIGINT REFERENCES companies(id),
    access_level TEXT NOT NULL CHECK (access_level IN ('public', 'company', 'specific')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Индивидуальные права (разрешения и запреты)
CREATE TABLE IF NOT EXISTS report_permissions (
    id BIGSERIAL PRIMARY KEY,
    report_id BIGINT NOT NULL REFERENCES reports(id) ON DELETE CASCADE,
    user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    permission_type TEXT NOT NULL CHECK (permission_type IN ('allow', 'deny')),
    granted_by BIGINT REFERENCES users(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (report_id, user_id)
);

-- Индексы
CREATE INDEX IF NOT EXISTS idx_company_members_user ON company_members(user_id);
CREATE INDEX IF NOT EXISTS idx_company_members_company ON company_members(company_id);
CREATE INDEX IF NOT EXISTS idx_reports_company ON reports(company_id);
CREATE INDEX IF NOT EXISTS idx_reports_creator ON reports(creator_user_id);
CREATE INDEX IF NOT EXISTS idx_reports_access_company ON reports(access_level, company_id);
CREATE INDEX IF NOT EXISTS idx_report_permissions_report_user
    ON report_permissions(report_id, user_id);
CREATE INDEX IF NOT EXISTS idx_report_permissions_user_deny
    ON report_permissions(user_id, permission_type)
    WHERE permission_type = 'deny';

-- Комментарии
COMMENT ON TABLE users IS 'Пользователи системы';
COMMENT ON TABLE companies IS 'Компании';
COMMENT ON TABLE company_members IS 'Сотрудники компаний (роли)';
COMMENT ON TABLE reports IS 'Файлы отчётов с базовой политикой доступа';
COMMENT ON TABLE report_permissions IS 'Явные разрешения и запреты на просмотр отчётов';

COMMIT;
