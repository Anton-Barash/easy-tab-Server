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
 * @param {string} filename - имя файла
 * @param {string} [mimeType] - MIME-тип (если известен)
 * @returns {boolean} true, если файл нужно открыть в браузере
 */
function isInlineFile(filename, mimeType) {
  const mime = mimeType || getMimeType(filename);
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
  sanitizeFilename,
  getMimeType,
  isInlineFile,
  buildStorageKey,
  MIME_TYPES,
};
