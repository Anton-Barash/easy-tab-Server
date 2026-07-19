// ============================================================
// Reports Service — бизнес-логика работы с отчётами
//
// Для web-клиента отчёты хранятся на сервере:
//   - JSON отчёта → в KS3 (как файл)
//   - метаданные → в таблице reports (PostgreSQL)
//
// Это позволяет web-версии сохранять и загружать отчёты
// без локальной файловой системы (path_provider не работает на web).
// ============================================================

const db = require('../services/databaseService');
const ks3 = require('./ks3Storage');
const { generateUuid, sanitizeFilename, buildStorageKey } = require('../utils/fileUtils');
const logger = require('../utils/logger');
const { generateReportHtml } = require('./htmlGenerator');

/**
 * Сохранить отчёт (создать новый или обновить существующий).
 *
 * Логика:
 *   1. Если есть reportId — обновляем существующий отчёт
 *   2. Если нет — создаём новый:
 *      a. Генерируем UUID для папки KS3: reports/{UUID}/
 *      b. Загружаем JSON в KS3: reports/{UUID}/report.json
 *      c. Создаём запись в таблице reports (с ks3_folder)
 *
 * @param {object} params
 * @param {number} params.userId - ID пользователя (из JWT)
 * @param {string} params.title - название отчёта
 * @param {object} params.reportData - JSON-объект отчёта
 * @param {string|null} [params.reportId] - ID существующего отчёта (для обновления)
 * @returns {Promise<object>} { id, title, ks3Folder, createdAt }
 */
async function saveReport({ userId, title, reportData, reportId }) {
  // Сериализуем отчёт в JSON
  const jsonBuffer = Buffer.from(JSON.stringify(reportData), 'utf-8');

  // Если есть reportId — обновляем существующий
  if (reportId) {
    // Проверяем, что отчёт существует и принадлежит пользователю
    const existing = await db.query(
      'SELECT * FROM reports WHERE id = $1 AND creator_user_id = $2',
      [reportId, userId]
    );

    if (existing.rows.length === 0) {
      const err = new Error('Report not found or access denied');
      err.statusCode = 404;
      throw err;
    }

    const row = existing.rows[0];
    // Используем ks3_folder если есть, иначе file_path
    const ks3Folder = row.ks3_folder || null;
    const fileKey = ks3Folder
      ? `${ks3Folder}report.json`
      : row.file_path;

    // Перезаписываем JSON в KS3
    await ks3.saveFile(fileKey, jsonBuffer, 'application/json');

    // Обновляем заголовок (на случай если изменился)
    await db.query(
      'UPDATE reports SET title = $1 WHERE id = $2',
      [title, reportId]
    );

    logger.info(`saveReport: updated report ${reportId} for user ${userId}`);
    return {
      id: parseInt(reportId, 10),
      title,
      fileKey,
      ks3Folder,
    };
  }

  // Создаём новый отчёт
  const uuid = generateUuid();
  // Папка отчёта в KS3: reports/{UUID}/
  const ks3Folder = `reports/${uuid}/`;
  // JSON лежит в корне папки отчёта
  const fileKey = `${ks3Folder}report.json`;

  // Загружаем JSON в KS3
  await ks3.saveFile(fileKey, jsonBuffer, 'application/json');

  // Создаём запись в БД (с ks3_folder).
  // C-34: если INSERT упадёт — удаляем осиротевший файл из KS3 (компенсация).
  let row;
  try {
    const result = await db.query(
      `INSERT INTO reports (title, file_path, ks3_folder, creator_user_id, access_level)
       VALUES ($1, $2, $3, $4, 'specific')
       RETURNING id, title, created_at`,
      [title, fileKey, ks3Folder, userId]
    );
    row = result.rows[0];
  } catch (insertErr) {
    logger.error(`saveReport: DB insert failed, compensating KS3 delete for ${fileKey}: ${insertErr.message}`);
    try {
      await ks3.deleteFile(fileKey);
    } catch (cleanupErr) {
      logger.error(`saveReport: KS3 compensation delete failed for ${fileKey}: ${cleanupErr.message}`);
    }
    throw insertErr;
  }

  logger.info(`saveReport: created report ${row.id} for user ${userId}, folder=${ks3Folder}`);

  return {
    id: row.id,
    title: row.title,
    fileKey,
    ks3Folder,
    createdAt: row.created_at,
  };
}

/**
 * Получить список отчётов пользователя.
 *
 * Возвращает метаданные (без содержимого JSON).
 *
 * @param {number} userId - ID пользователя
 * @returns {Promise<Array<{id, title, createdAt}>>}
 */
async function listReports(userId) {
  const result = await db.query(
    `SELECT id, title, created_at
     FROM reports
     WHERE creator_user_id = $1
     ORDER BY created_at DESC`,
    [userId]
  );

  return result.rows.map((row) => ({
    id: row.id,
    title: row.title,
    createdAt: row.created_at,
  }));
}

/**
 * Получить полный JSON отчёта по ID.
 *
 * Проверяет, что отчёт принадлежит пользователю (или есть права).
 * Затем скачивает JSON из KS3.
 *
 * @param {number} reportId - ID отчёта
 * @param {number} userId - ID пользователя
 * @returns {Promise<{id, title, reportData}>}
 * @throws {Error} 404 если не найден или нет прав
 */
async function getReport(reportId, userId) {
  // Проверяем доступ
  const meta = await db.query(
    'SELECT * FROM reports WHERE id = $1 AND creator_user_id = $2',
    [reportId, userId]
  );

  if (meta.rows.length === 0) {
    const err = new Error('Report not found or access denied');
    err.statusCode = 404;
    throw err;
  }

  const row = meta.rows[0];
  const fileKey = row.file_path;
  const ks3Folder = row.ks3_folder || null;

  // Скачиваем JSON из KS3
  const fileData = await ks3.getFile(fileKey);
  const jsonString = fileData.data.toString('utf-8');
  const reportData = JSON.parse(jsonString);

  return {
    id: row.id,
    title: row.title,
    ks3Folder,
    reportData,
  };
}

/**
 * Удалить отчёт.
 *
 * C-34: Сначала удаляем запись из БД (транзакционно), потом — файлы из KS3.
 * Если KS3-удаление упадёт, останутся «осиротевшие» файлы (логируем warning,
 * это лучше, чем осиротевшая запись в БД, указывающая на удалённые файлы).
 *
 * Только владелец может удалить.
 *
 * @param {number} reportId - ID отчёта
 * @param {number} userId - ID пользователя
 * @returns {Promise<boolean>}
 */
async function deleteReport(reportId, userId) {
  // Проверяем владение и сразу получаем список файлов для последующей
  // очистки KS3 (до удаления из БД, пока CASCADE не сработал).
  const meta = await db.query(
    'SELECT * FROM reports WHERE id = $1 AND creator_user_id = $2',
    [reportId, userId]
  );

  if (meta.rows.length === 0) {
    const err = new Error('Report not found or access denied');
    err.statusCode = 404;
    throw err;
  }

  const row = meta.rows[0];
  const ks3Folder = row.ks3_folder;
  const fileKey = row.file_path;

  // 1. Получаем список всех файлов отчёта (чтобы удалить из KS3)
  const filesResult = await db.query(
    'SELECT storage_key FROM files WHERE report_id = $1',
    [reportId]
  );
  const ks3Keys = filesResult.rows.map((f) => f.storage_key);
  // JSON отчёта тоже нужно удалить (если не был в списке files)
  if (fileKey && !ks3Keys.includes(fileKey)) {
    ks3Keys.push(fileKey);
  }

  // 2. Удаляем запись из БД (CASCADE удалит files и file_permissions).
  //    C-34: БД-удаление выполняем ДО KS3-удаления — если БД упадёт,
  //    файлы останутся на месте (нет data loss).
  await db.query('DELETE FROM reports WHERE id = $1', [reportId]);

  // 3. Удаляем файлы из KS3 (best-effort). Осиротевшие файлы при неудаче
  //    логируются, но не ломают операцию — БД уже консистентна.
  let removedCount = 0;
  for (const key of ks3Keys) {
    try {
      await ks3.deleteFile(key);
      removedCount++;
    } catch (err) {
      logger.warn(`deleteReport: failed to delete KS3 file ${key}: ${err.message}`);
    }
  }

  logger.info(
    `deleteReport: deleted report ${reportId} by user ${userId}, ` +
    `${removedCount}/${ks3Keys.length} files removed from KS3`
  );
  return true;
}

/**
 * Получить отчёт для просмотра (с проверкой доступа).
 *
 * Если отчёт публичный - доступен всем.
 * Если приватный - только владельцу.
 *
 * @param {number} reportId - ID отчёта
 * @param {number|null} userId - ID пользователя (null для анонимов)
 * @returns {Promise<{id, title, ks3Folder, isPublic, creatorUserId}>}
 */
async function getReportForView(reportId, userId) {
  const result = await db.query(
    'SELECT id, title, ks3_folder, is_public, creator_user_id FROM reports WHERE id = $1',
    [reportId]
  );

  if (result.rows.length === 0) {
    const err = new Error('Report not found');
    err.statusCode = 404;
    throw err;
  }

  const report = result.rows[0];

  // Проверка доступа
  if (!report.is_public && (!userId || userId !== report.creator_user_id)) {
    const err = new Error('Access denied');
    err.statusCode = 403;
    throw err;
  }

  return {
    id: report.id,
    title: report.title,
    ks3Folder: report.ks3_folder,
    isPublic: report.is_public,
    creatorUserId: report.creator_user_id,
  };
}

/**
 * Получить HTML отчёта.
 *
 * Скачивает report.json из KS3 и генерирует HTML на сервере
 * (без загрузки готового HTML с клиента).
 *
 * Пути к медиа сразу генерируются как proxy-пути с токеном:
 *   /view/report/:id/files/photos/f1.jpg?token=xxx
 * чтобы браузер запрашивал файлы через сервер (KS3-ключи скрыты).
 *
 * @param {string} ks3Folder - папка отчёта в KS3
 * @param {number} reportId - ID отчёта (для proxy-путей)
 * @param {string|null} token - JWT-токен (добавляется в URL для приватных отчётов)
 * @param {string} [baseUrl] - базовый URL сервера для абсолютных URL к фото
 * @returns {Promise<string>} HTML-контент
 */
async function getReportHtml(ks3Folder, reportId, token, baseUrl) {
  const jsonKey = `${ks3Folder}report.json`;
  const fileData = await ks3.getFile(jsonKey);
  const jsonString = fileData.data.toString('utf-8');
  let reportData;
  try {
    reportData = JSON.parse(jsonString);
  } catch (e) {
    const err = new Error('Invalid report JSON: ' + e.message);
    err.statusCode = 500;
    throw err;
  }
  logger.info(`getReportHtml: generated HTML from JSON for report ${reportId}`);
  return generateReportHtml(reportData, reportId, token, baseUrl);
}

/**
 * Получить файл из KS3 для проксирования.
 *
 * @param {string} ks3Folder - папка отчёта в KS3
 * @param {string} relativePath - относительный путь файла
 * @returns {Promise<{data: Buffer, contentType: string}>}
 */
async function getReportFile(ks3Folder, relativePath) {
  const fileKey = `${ks3Folder}${relativePath}`;
  logger.info(`getReportFile: ks3Folder="${ks3Folder}", relativePath="${relativePath}", fileKey="${fileKey}"`);
  let fileData;
  try {
    fileData = await ks3.getFile(fileKey);
  } catch (err) {
    logger.error(`getReportFile: KS3 error for key "${fileKey}": ${err && err.message ? err.message : JSON.stringify(err)}`);
    const e = new Error('File not found in KS3');
    e.statusCode = 404;
    throw e;
  }

  // Определяем MIME-тип по расширению
  const ext = relativePath.split('.').pop().toLowerCase();
  const mimeTypes = {
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    png: 'image/png',
    gif: 'image/gif',
    webp: 'image/webp',
    mp4: 'video/mp4',
    webm: 'video/webm',
    html: 'text/html',
    css: 'text/css',
    js: 'application/javascript',
  };

  const contentType = mimeTypes[ext] || 'application/octet-stream';

  return {
    data: fileData.data,
    contentType,
  };
}

async function getReportFileByKey(storageKey) {
  try {
    const fileData = await ks3.getFile(storageKey);
    if (!fileData) {
      return null;
    }

    const ext = storageKey.split('.').pop().toLowerCase();
    const mimeTypes = {
      jpg: 'image/jpeg',
      jpeg: 'image/jpeg',
      png: 'image/png',
      gif: 'image/gif',
      webp: 'image/webp',
      bmp: 'image/bmp',
      mp4: 'video/mp4',
      webm: 'video/webm',
      mov: 'video/quicktime',
      avi: 'video/x-msvideo',
      json: 'application/json',
      html: 'text/html',
      css: 'text/css',
      js: 'application/javascript',
    };

    const contentType = mimeTypes[ext] || 'application/octet-stream';

    return {
      data: fileData.data,
      contentType,
    };
  } catch (error) {
    logger.warn(`getReportFileByKey: failed to get ${storageKey}: ${error.message}`);
    return null;
  }
}

async function saveReportFile(storageKey, data, contentType) {
  try {
    await ks3.saveFile(storageKey, data, contentType);
    logger.debug(`saveReportFile: saved ${storageKey}`);
    return true;
  } catch (error) {
    logger.error(`saveReportFile: failed to save ${storageKey}: ${error.message}`);
    throw error;
  }
}

module.exports = {
  saveReport,
  listReports,
  getReport,
  deleteReport,
  getReportForView,
  getReportHtml,
  getReportFile,
  getReportFileByKey,
  saveReportFile,
};
