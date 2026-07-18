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

module.exports = {
  saveReport,
  listReports,
  getReport,
  deleteReport,
};
