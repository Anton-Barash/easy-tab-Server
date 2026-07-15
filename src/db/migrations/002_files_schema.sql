-- ============================================================
-- Таблицы для файлового хранилища (KS3)
-- Реализует спецификацию из files.txt:
--   - files: метаданные загруженных файлов
--   - file_permissions: права доступа пользователей к файлам
-- ============================================================

BEGIN;

-- ------------------------------------------------------------
-- Таблица files
-- Хранит метаданные каждого загруженного файла.
-- ID — это UUID (генерируется приложением/сервером),
-- используется как часть ключа в KS3: files/{UUID}/{name}
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS files (
    -- Уникальный идентификатор файла (UUID v4)
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    -- Владелец файла (пользователь, который загрузил)
    owner_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,

    -- Ключ объекта в KS3, например: files/abc-123/report.html
    storage_key TEXT NOT NULL,

    -- Оригинальное имя файла (как его назвал клиент)
    original_name TEXT NOT NULL,

    -- Размер файла в байтах
    size BIGINT NOT NULL DEFAULT 0,

    -- MIME-тип файла (text/html, image/jpeg, application/json, ...)
    mime_type TEXT NOT NULL DEFAULT 'application/octet-stream',

    -- Относительный путь внутри "папки" отчёта
    -- (например: report.html, media/photo1.jpg)
    relative_path TEXT NOT NULL,

    -- Опциональная группа/папка отчёта (UUID папки или NULL)
    -- Используется для наследования прав (см. files.txt п.7)
    parent_id UUID REFERENCES files(id) ON DELETE CASCADE,

    -- Флаг: нужно ли открывать файл в браузере, а не скачивать
    -- (true для HTML-файлов отчёта)
    is_inline BOOLEAN NOT NULL DEFAULT false,

    -- Дата загрузки
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ------------------------------------------------------------
-- Таблица file_permissions
-- Права пользователей на файлы.
-- Один файл может иметь несколько записей прав для разных юзеров.
-- Типы прав:
--   owner  — полный доступ (только у создателя)
--   read   — чтение/скачивание
--   write  — изменение
--   share  — передача прав другим
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS file_permissions (
    id BIGSERIAL PRIMARY KEY,

    -- Файл, к которому относится право
    file_id UUID NOT NULL REFERENCES files(id) ON DELETE CASCADE,

    -- Пользователь, которому выдано право
    user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,

    -- Тип права: owner | read | write | share
    permission TEXT NOT NULL CHECK (permission IN ('owner', 'read', 'write', 'share')),

    -- Кто выдал право
    granted_by BIGINT REFERENCES users(id),

    -- Дата выдачи
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),

    -- Одна запись на (файл, пользователь, тип права)
    UNIQUE (file_id, user_id, permission)
);

-- ------------------------------------------------------------
-- Индексы для быстрых запросов
-- ------------------------------------------------------------

-- Поиск файлов по владельцу (список "мои файлы")
CREATE INDEX IF NOT EXISTS idx_files_owner ON files(owner_id);

-- Поиск файлов по родительской папке (дерево)
CREATE INDEX IF NOT EXISTS idx_files_parent ON files(parent_id);

-- Проверка прав: найти все права пользователя на файл
CREATE INDEX IF NOT EXISTS idx_file_permissions_file_user
    ON file_permissions(file_id, user_id);

-- Список всех файлов, доступных пользователю
CREATE INDEX IF NOT EXISTS idx_file_permissions_user
    ON file_permissions(user_id);

-- ------------------------------------------------------------
-- Комментарии
-- ------------------------------------------------------------
COMMENT ON TABLE files IS 'Метаданные файлов в KS3-хранилище';
COMMENT ON TABLE file_permissions IS 'Права пользователей на файлы (read/write/share/owner)';

COMMENT ON COLUMN files.id IS 'UUID файла — часть ключа в KS3';
COMMENT ON COLUMN files.storage_key IS 'Полный ключ объекта в KS3: files/{UUID}/{name}';
COMMENT ON COLUMN files.is_inline IS 'true = открывать в браузере (HTML), false = скачивать';
COMMENT ON COLUMN files.parent_id IS 'UUID папки-родителя для наследования прав (NULL = корень)';

COMMENT ON COLUMN file_permissions.permission IS 'Тип права: owner|read|write|share';

COMMIT;
