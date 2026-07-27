// ============================================================
// Утилиты для работы с файлами
//
// Содержит вспомогательные функции:
//   - генерация UUID v4
//   - очистка имени файла от опасных символов
//   - определение MIME-типа по расширению
//   - определение, нужно ли файл открывать в браузере (inline)
// ============================================================

const crypto = require('crypto');

/**
 * Генерирует UUID v4 (RFC 4122).
 * Использует встроенный модуль crypto — без внешних зависимостей.
 * @returns {string} UUID в формате "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx"
 */
function generateUuid() {
  return crypto.randomUUID();
}

/**
 * Генерирует короткий публичный идентификатор для URL.
 * 10 символов [a-z0-9] — достаточно для ~3.4 триллионов комбинаций,
 * не раскрывает порядковый номер и длину последовательности.
 */
function generatePublicId() {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let result = '';
  const randomBytes = crypto.randomBytes(10);
  for (let i = 0; i < 10; i++) {
    result += chars[randomBytes[i] % chars.length];
  }
  return result;
}

/**
 * Очищает имя файла от опасных символов.
 * Оставляет только: буквы, цифры, точки, дефисы, подчёркивания.
 * Также обрезает до 200 символов, чтобы не было проблем с KS3.
 *
 * Это нужно для безопасного использования имени в ключе объекта KS3
 * и предотвращения path traversal атак.
 *
 * @param {string} filename - оригинальное имя файла
 * @returns {string} очищенное имя (минимум "file", если всё очистилось)
 */
function sanitizeFilename(filename) {
  if (!filename || typeof filename !== 'string') {
    return 'file';
  }

  // Берём только basename (на случай, если прислали с путём)
  const base = filename.split(/[\\/]/).pop() || 'file';

  // Оставляем только безопасные символы: буквы, цифры, точки, дефисы, подчёркивания
  // Unicode-буквы сохраняются через флаг "u" в regex
  const cleaned = base.replace(/[^\p{L}\p{N}._-]/gu, '_');

  // Удаляем точки и подчёркивания в начале (чтобы не было скрытых файлов)
  const trimmed = cleaned.replace(/^[._]+/, '');

  // Ограничиваем длину (200 символов достаточно, KS3 поддерживает до 1024)
  const result = (trimmed || 'file').substring(0, 200);

  return result;
}

/**
 * Санитизирует относительный путь файла внутри папки отчёта.
 *
 * В отличие от sanitizeFilename (который берёт только basename),
 * эта функция сохраняет структуру подкаталогов (например "photos/f1_1_001.jpg"),
 * но жёстко блокирует path traversal:
 *   - запрещает ".." (любая компонента)
 *   - запрещает ведущий "/" (абсолютный путь)
 *   - запрещает ведущие "\" (Windows-абсолютный путь)
 *   - запрещает NUL и управляющие символы
 *   - запрещает компоненты, состоящие только из точек/пробелов
 *
 * @param {string} relativePath - относительный путь (например "photos/f1_1_001.jpg")
 * @returns {string|null} безопасный путь или null, если путь невалиден
 */
function sanitizeRelativePath(relativePath) {
  if (!relativePath || typeof relativePath !== 'string') {
    return null;
  }

  // Запрет NUL и управляющих символов
  if (/[\x00-\x1f\x7f]/.test(relativePath)) {
    return null;
  }

  // Нормализуем обратные слеши в прямые (Windows → Unix)
  let normalized = relativePath.replace(/\\/g, '/');

  // Запрет ведущего слеша (абсолютный путь)
  if (normalized.startsWith('/')) {
    return null;
  }

  // Разбиваем на компоненты и проверяем каждую
  const parts = normalized.split('/');
  const safeParts = [];
  for (const part of parts) {
    // Пустая компонента (двойной слеш) — пропускаем
    if (part === '') continue;

    // Запрет ".." и компонент, состоящих только из точек/пробелов
    if (/^(\.\s*)+$/.test(part)) {
      return null;
    }

    // Компонента не должна содержать опасных символов (оставляем буквы/цифры/._-/)
    const cleaned = part.replace(/[^\p{L}\p{N}._-]/gu, '_');
    if (!cleaned) {
      return null;
    }
    safeParts.push(cleaned);
  }

  if (safeParts.length === 0) {
    return null;
  }

  return safeParts.join('/');
}

/**
 * Карта расширений → MIME-типов.
 * Используется, если KS3-клиент не может определить тип автоматически.
 * Включает основные типы, нужные приложению.
 */
const MIME_TYPES = {
  // Текстовые и веб
  '.html': 'text/html',
  '.htm': 'text/html',
  '.css': 'text/css',
  '.js': 'application/javascript',
  '.json': 'application/json',
  '.txt': 'text/plain',
  '.xml': 'application/xml',
  '.csv': 'text/csv',

  // Изображения
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.bmp': 'image/bmp',

  // Видео
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
  '.avi': 'video/x-msvideo',

  // Аудио
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',

  // Документы
  '.pdf': 'application/pdf',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.xls': 'application/vnd.ms-excel',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.doc': 'application/msword',

  // Архивы
  '.zip': 'application/zip',

  // По умолчанию
  '.default': 'application/octet-stream',
};

/**
 * Определяет MIME-тип по расширению файла.
 * @param {string} filename - имя файла (с расширением)
 * @returns {string} MIME-тип, по умолчанию 'application/octet-stream'
 */
function getMimeType(filename) {
  if (!filename) return MIME_TYPES['.default'];

  // Извлекаем расширение (последняя точка)
  const ext = filename.toLowerCase().match(/\.[^.]+$/);
  if (!ext) return MIME_TYPES['.default'];

  return MIME_TYPES[ext[0]] || MIME_TYPES['.default'];
}

/**
 * Определяет, нужно ли файл открывать в браузере (inline),
 * а не скачивать как вложение.
 *
 * Inline = true для HTML-файлов отчёта: они должны открываться
 * как страница в браузере по подписанной ссылке.
 *
 * БЕЗОПАСНОСТЬ (H-24): image/svg+xml исключён из inline —
 * SVG может содержать <script> и привести к stored XSS
 * в домене бакета. SVG принудительно скачивается.
 *
 * @param {string} filename - имя файла
 * @param {string} [mimeType] - MIME-тип (если известен)
 * @returns {boolean} true, если файл нужно открыть в браузере
 */
function isInlineFile(filename, mimeType) {
  const mime = mimeType || getMimeType(filename);
  // SVG НЕ открываем inline (XSS-риск через <script>)
  if (mime === 'image/svg+xml') {
    return false;
  }
  // Все текстовые и HTML-типы открываем в браузере
  return mime.startsWith('text/html') || mime.startsWith('image/') || mime.startsWith('video/');
}

/**
 * Формирует ключ объекта в KS3 по спецификации files.txt:
 *   files/{UUID}/{очищенное_имя_файла}
 *
 * Этот формат обеспечивает:
 *   - уникальность (UUID уникален)
 *   - отсутствие коллизий имён
 *   - простое администрирование (все файлы в prefix "files/")
 *
 * @param {string} uuid - UUID файла
 * @param {string} filename - оригинальное имя файла
 * @returns {string} ключ объекта, например "files/abc-123/report.html"
 */
function buildStorageKey(uuid, filename) {
  const safeName = sanitizeFilename(filename);
  return `files/${uuid}/${safeName}`;
}

module.exports = {
  generateUuid,
  generatePublicId,
  sanitizeFilename,
  sanitizeRelativePath,
  getMimeType,
  isInlineFile,
  buildStorageKey,
  MIME_TYPES,
};
