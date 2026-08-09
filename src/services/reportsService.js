// ============================================================
// Reports Service — бизнес-логика работы с отчётами
//
// Для web-клиента отчёты хранятся на сервере:
//   - JSON отчёта → в таблице reports (PostgreSQL, column report_data JSONB)
//   - KS3-копия JSON → бекап (reports/{UUID}/report.json)
//   - метаданные → в таблице reports (PostgreSQL)
//
// Это позволяет web-версии сохранять и загружать отчёты
// без локальной файловой системы (path_provider не работает на web).
// ============================================================

const db = require('../services/databaseService');
const ks3 = require('./s3Storage');
const thumbnailService = require('./thumbnailService');
const { generateUuid, generatePublicId, sanitizeFilename, buildStorageKey, getReportMimeType } = require('../utils/fileUtils');
const logger = require('../utils/logger');
const { generateReportHtml } = require('./htmlGenerator');

/**
 * MIME-типы для файлов отчёта определяются централизованно в fileUtils.js
 * через getReportMimeType() — здесь дублирующая карта не нужна.
 */

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

    // Перезаписываем JSON в KS3 (бекап)
    await ks3.saveFile(fileKey, jsonBuffer, 'application/json');

    // Обновляем заголовок и JSON-данные в БД
    await db.query(
      'UPDATE reports SET title = $1, report_data = $2::jsonb WHERE id = $3',
      [title, reportData, reportId]
    );

    logger.info(`saveReport: updated report ${reportId} for user ${userId}`);
    return {
      id: parseInt(reportId, 10),
      publicId: row.public_id,
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
  // Короткий публичный идентификатор для URL просмотра
  const publicId = generatePublicId();

  // Загружаем JSON в KS3 (бекап)
  await ks3.saveFile(fileKey, jsonBuffer, 'application/json');

  // Создаём запись в БД (с ks3_folder, report_data и public_id).
  // C-34: если INSERT упадёт — удаляем осиротевший файл из KS3 (компенсация).
  let row;
  try {
    const result = await db.query(
      `INSERT INTO reports (title, file_path, ks3_folder, creator_user_id, access_level, report_data, public_id)
       VALUES ($1, $2, $3, $4, 'specific', $5::jsonb, $6)
       RETURNING id, title, created_at, public_id`,
      [title, fileKey, ks3Folder, userId, reportData, publicId]
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

  logger.info(`saveReport: created report ${row.id} (${row.public_id}) for user ${userId}, folder=${ks3Folder}`);

  return {
    id: row.id,
    publicId: row.public_id,
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
    `SELECT id, title, created_at, public_id
     FROM reports
     WHERE creator_user_id = $1
     ORDER BY created_at DESC`,
    [userId]
  );

  return result.rows.map((row) => ({
    id: row.id,
    publicId: row.public_id,
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
    'SELECT id, title, file_path, ks3_folder, report_data, public_id FROM reports WHERE id = $1 AND creator_user_id = $2',
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

  // Читаем JSON из БД; если нет — fallback на KS3 (старые отчёты).
  let reportData = row.report_data;
  if (!reportData) {
    logger.info(`getReport: report ${reportId} has no report_data, falling back to KS3`);
    const fileData = await ks3.getFile(fileKey);
    const jsonString = fileData.data.toString('utf-8');
    reportData = JSON.parse(jsonString);
  }

  return {
    id: row.id,
    publicId: row.public_id,
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
async function getReportForView(reportId, userId, options = {}) {
  const { skipAccessCheck = false } = options;
  const result = await db.query(
    'SELECT id, title, ks3_folder, is_public, creator_user_id, report_data, public_id FROM reports WHERE id = $1',
    [reportId]
  );

  if (result.rows.length === 0) {
    const err = new Error('Report not found');
    err.statusCode = 404;
    throw err;
  }

  return _mapReportForView(result.rows[0], userId, skipAccessCheck);
}

/**
 * Получить отчёт для просмотра по публичному идентификатору.
 */
async function getReportForViewByPublicId(publicId, userId, options = {}) {
  const { skipAccessCheck = false } = options;
  const result = await db.query(
    'SELECT id, title, ks3_folder, is_public, creator_user_id, report_data, public_id FROM reports WHERE public_id = $1',
    [publicId]
  );

  if (result.rows.length === 0) {
    const err = new Error('Report not found');
    err.statusCode = 404;
    throw err;
  }

  return _mapReportForView(result.rows[0], userId, skipAccessCheck);
}

function _mapReportForView(report, userId, skipAccessCheck = false) {
  // Проверка доступа (пропускается для share-ссылок, где доступ проверен через токен)
  if (!skipAccessCheck && !report.is_public && (!userId || userId !== report.creator_user_id)) {
    const err = new Error('Access denied');
    err.statusCode = 403;
    throw err;
  }

  return {
    id: report.id,
    publicId: report.public_id,
    title: report.title,
    ks3Folder: report.ks3_folder,
    isPublic: report.is_public,
    creatorUserId: report.creator_user_id,
    reportData: report.report_data,
  };
}

/**
 * Получить HTML отчёта.
 *
 * Читает JSON-данные из БД (или fallback на KS3 для старых отчётов),
 * генерирует presigned URL для медиа и строит HTML на сервере.
 *
 * @param {object} report - объект отчёта из getReportForView / getReport
 * @param {string|null} token - JWT-токен (для fallback proxy-ссылок)
 * @param {string} [baseUrl] - базовый URL сервера (устарело, сохранено для совместимости)
 * @returns {Promise<string>} HTML-контент
 */
async function getReportHtml(report, token, baseUrl, shareToken = null) {
  let reportData = report.reportData;

  // Fallback на KS3 для старых отчётов без report_data.
  if (!reportData && report.ks3Folder) {
    logger.info(`getReportHtml: report ${report.id} has no report_data, falling back to KS3`);
    const jsonKey = `${report.ks3Folder}report.json`;
    const fileData = await ks3.getFile(jsonKey);
    const jsonString = fileData.data.toString('utf-8');
    try {
      reportData = JSON.parse(jsonString);
    } catch (e) {
      const err = new Error('Invalid report JSON: ' + e.message);
      err.statusCode = 500;
      throw err;
    }
  }

  if (!reportData) {
    const err = new Error('Report data not found');
    err.statusCode = 404;
    throw err;
  }

  const mediaUrls = await getReportMediaUrls(report.id, 3600);
  logger.info(`getReportHtml: generated HTML from DB JSON for report ${report.id}`);
  return generateReportHtml(reportData, report.publicId, token, baseUrl, mediaUrls, report.ks3Folder, null, shareToken);
}

/**
 * Сгенерировать presigned URL для всех медиафайлов отчёта.
 *
 * Доступ к отчёту должен быть проверен вызывающей стороной ДО вызова.
 *
 * @param {number} reportId - ID отчёта
 * @param {number} [expires=3600] - время жизни URL в секундах
 * @returns {Promise<Object>} { 'photos/f1.jpg': { full, thumb }, ... }
 */
async function getReportMediaUrls(reportId, expires = 3600) {
  const filesResult = await db.query(
    `SELECT storage_key, relative_path, mime_type
     FROM files
     WHERE report_id = $1`,
    [reportId]
  );

  const urls = {};
  for (const file of filesResult.rows) {
    try {
      const full = await ks3.getPresignedUrl(file.storage_key, expires);
      let thumb = full;
      if (file.mime_type && file.mime_type.startsWith('image/')) {
        const thumbKey = thumbnailService.getThumbnailStorageKey(file.storage_key);
        thumb = await ks3.getPresignedUrl(thumbKey, expires);
      }
      urls[file.relative_path] = { full, thumb };
    } catch (err) {
      logger.warn(`getReportMediaUrls: failed to generate URL for ${file.storage_key}: ${err.message}`);
    }
  }

  return urls;
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

  const contentType = getReportMimeType(relativePath);

  return {
    data: fileData.data,
    contentType,
  };
}

/**
 * Получить поток файла из KS3 для проксирования с поддержкой Range.
 *
 * @param {string} ks3Folder - папка отчёта в KS3
 * @param {string} relativePath - относительный путь файла
 * @param {string|null} range - HTTP Range header
 * @returns {Promise<{stream: Readable, status: number, headers: object}>}
 */
async function getReportFileStream(ks3Folder, relativePath, range = null) {
  const fileKey = `${ks3Folder}${relativePath}`;
  logger.info(`getReportFileStream: ks3Folder="${ks3Folder}", relativePath="${relativePath}", range="${range || 'none'}"`);
  return ks3.getFileStream(fileKey, range);
}

async function getReportFileByKey(storageKey) {
  try {
    const fileData = await ks3.getFile(storageKey);
    if (!fileData) {
      return null;
    }

    const contentType = getReportMimeType(storageKey);

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
  getReportForViewByPublicId,
  getReportHtml,
  getReportMediaUrls,
  getReportFile,
  getReportFileStream,
  getReportFileByKey,
  saveReportFile,
};
