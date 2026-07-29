// ============================================================
// File Service — бизнес-логика работы с файлами
//
// Связующее звено между контроллерами, БД и KS3.
// Реализует логику из спецификации files.txt:
//   - загрузка файла (UUID, очистка имени, KS3, запись в БД, право owner)
//   - получение метаданных
//   - генерация подписанного URL (с проверкой прав)
//   - передача прав (share)
//   - отзыв прав
//   - удаление файла (БД + KS3)
//   - наследование прав по parent_id (опционально)
// ============================================================

const db = require('../services/databaseService');
const ks3 = require('./ks3Storage');
const thumbnailService = require('./thumbnailService');
const {
  generateUuid,
  sanitizeFilename,
  sanitizeRelativePath,
  getMimeType,
  isInlineFile,
  buildStorageKey,
} = require('../utils/fileUtils');
const logger = require('../utils/logger');

// ------------------------------------------------------------
// Вспомогательные функции
// ------------------------------------------------------------

/**
 * Проверить, существует ли пользователь с указанным ID.
 * P3-49: используется в grantPermission/revokePermission, чтобы не передавать
 * права несуществующим пользователям (иначе ON CONFLICT создаст запись,
 * а FK user_id...REFERENCES users(id) сработает только при INSERT,
 * оставляя ревоку в неопределённом состоянии).
 *
 * @param {number} userId - ID пользователя
 * @returns {Promise<boolean>}
 */
async function userExists(userId) {
  const result = await db.query('SELECT 1 FROM users WHERE id = $1', [userId]);
  return result.rows.length > 0;
}

// ------------------------------------------------------------
// Загрузка файла (files.txt п.1)
// ------------------------------------------------------------

/**
 * Загрузить файл в KS3 и создать запись в БД.
 *
 * Шаги:
 *   1. Если есть reportId — загружаем ks3_folder из БД (с проверкой владения),
 *      sanitizedRelativePath валидируется сервером.
 *   2. Генерируем UUID
 *   3. Очищаем имя файла
 *   4. Формируем ключ: files/{UUID}/{name} или reports/{reportUuid}/{relativePath}
 *   5. Определяем MIME-тип
 *   6. Загружаем в KS3
 *   7. Создаём запись в таблице files (с привязкой к отчёту, если есть)
 *   8. Добавляем право owner для текущего пользователя
 *
 * БЕЗОПАСНОСТЬ (H-10):
 *   - ks3Folder больше НЕ принимается от клиента — вычисляется из БД по reportId.
 *   - relativePath проходит жёсткую валидацию (sanitizeRelativePath):
 *     запрет "..", ведущих "/", NUL, управляющих символов.
 *
 * @param {object} params
 * @param {number} params.userId - ID пользователя (из JWT)
 * @param {string} params.originalName - оригинальное имя файла
 * @param {Buffer} params.body - содержимое файла
 * @param {string} [params.relativePath] - относительный путь в папке отчёта
 * @param {string|null} [params.parentId] - UUID папки-родителя
 * @param {number|null} [params.reportId] - ID отчёта (для привязки файла к отчёту)
 * @returns {Promise<object>} запись о файле
 */
async function uploadFile({ userId, originalName, body, relativePath, parentId, reportId }) {
  // 0. Если есть reportId — проверяем владение и загружаем ks3_folder из БД
  let ks3Folder = null;
  let safeRelativePath = null;

  if (reportId) {
    const reportResult = await db.query(
      'SELECT ks3_folder FROM reports WHERE id = $1 AND creator_user_id = $2',
      [reportId, userId]
    );

    if (reportResult.rows.length === 0) {
      const err = new Error('Report not found or access denied');
      err.statusCode = 403;
      throw err;
    }

    ks3Folder = reportResult.rows[0].ks3_folder || null;

    // Если у отчёта нет ks3_folder (старый отчёт) — нельзя привязывать файлы
    // к конкретному пути, используем стандартный ключ files/{uuid}/
    if (ks3Folder) {
      // Валидируем relativePath сервером — НЕ доверяем клиенту
      safeRelativePath = relativePath ? sanitizeRelativePath(relativePath) : null;
      if (relativePath && !safeRelativePath) {
        const err = new Error('Invalid relativePath: path traversal detected');
        err.statusCode = 400;
        throw err;
      }
    }
  }

  // 1. UUID файла
  const uuid = generateUuid();

  // 2. Очищаем имя (безопасный ключ для KS3)
  const safeName = sanitizeFilename(originalName);

  // 3. Ключ объекта в KS3:
  //    - Если есть ks3Folder (файл отчёта): reports/{reportUuid}/{relativePath}
  //    - Иначе: files/{UUID}/{name}
  let storageKey;
  let relPath;
  if (ks3Folder && safeRelativePath) {
    // Файл внутри папки отчёта с валидным относительным путём
    storageKey = `${ks3Folder}${safeRelativePath}`;
    relPath = safeRelativePath;
  } else if (ks3Folder && !relativePath) {
    // Файл в корне папки отчёта — используем sanitized filename
    storageKey = `${ks3Folder}${safeName}`;
    relPath = safeName;
  } else {
    // Самостоятельный файл (без отчёта или старый отчёт без ks3_folder)
    storageKey = buildStorageKey(uuid, originalName);
    relPath = safeName;
  }

  // 4. MIME-тип по расширению
  const mimeType = getMimeType(originalName);

  // 5. Нужно ли открывать в браузере (inline) — для HTML/фото/видео (SVG исключён — H-24)
  const inline = isInlineFile(originalName, mimeType);

  // 6. Загружаем в KS3
  logger.info(
    `uploadFile: user=${userId}, name=${originalName}, size=${body.length}, mime=${mimeType}, inline=${inline}, reportId=${reportId || 'null'}`
  );
  await ks3.saveFile(storageKey, body, mimeType);

  // 7. Создаём запись в таблице files + owner-право в одной транзакции (P0-51).
  // Оба INSERT должны быть атомарны — иначе файл в KS3 без прав или наоборот.
  let fileRecord;
  const dbClient = await db.pool.connect();
  try {
    await dbClient.query('BEGIN');
    const result = await dbClient.query(
      `INSERT INTO files
         (id, owner_id, storage_key, original_name, size, mime_type, relative_path, parent_id, is_inline, report_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       RETURNING *`,
      [
        uuid,
        userId,
        storageKey,
        originalName,
        body.length,
        mimeType,
        relPath,
        parentId || null,
        inline,
        reportId || null,
      ]
    );
    fileRecord = result.rows[0];

    // 8. Добавляем право owner для загрузившего пользователя
    await dbClient.query(
      `INSERT INTO file_permissions (file_id, user_id, permission, granted_by)
       VALUES ($1, $2, 'owner', $2)`,
      [uuid, userId]
    );

    await dbClient.query('COMMIT');
    logger.info(`uploadFile: created file ${uuid} for user ${userId}, reportId=${reportId || 'null'}`);
  } catch (dbErr) {
    await dbClient.query('ROLLBACK');
    dbClient.release();
    // Компенсация: удаляем объект из KS3, если БД-операция упала (H-17 — orphan-объект)
    try {
      await ks3.deleteFile(storageKey);
      logger.warn(`uploadFile: DB insert failed, KS3 object ${storageKey} deleted (compensation)`);
    } catch (ks3Err) {
      logger.error(`uploadFile: KS3 compensation delete failed for ${storageKey}: ${ks3Err.message}`);
    }
    throw dbErr;
  }
  dbClient.release();

  // 8. Генерируем и сохраняем миниатюру для изображений ТОЛЬКО после успешной
  // записи в БД. Если загрузка/сохранение упало раньше — лишних миниатюр в KS3 не будет.
  if (thumbnailService.isImageFile(mimeType)) {
    try {
      const thumbnailBuffer = await thumbnailService.generateThumbnail(body);
      const thumbnailKey = thumbnailService.getThumbnailStorageKey(storageKey);
      await ks3.saveFile(thumbnailKey, thumbnailBuffer, 'image/jpeg');
      logger.info(`uploadFile: thumbnail saved for ${storageKey} as ${thumbnailKey}`);
    } catch (thumbErr) {
      logger.warn(`uploadFile: failed to generate/save thumbnail for ${storageKey}: ${thumbErr.message}`);
    }
  }

  return fileRecord;
}

// ------------------------------------------------------------
// Список файлов отчёта
// ------------------------------------------------------------

/**
 * Получить все файлы, привязанные к отчёту.
 *
 * @param {number} reportId - ID отчёта
 * @param {number} userId - ID пользователя (для проверки прав)
 * @returns {Promise<Array>} список файлов
 * @throws {Error} 403 если нет прав на отчёт
 */
async function listFilesByReport(reportId, userId) {
  // Проверяем, что пользователь имеет доступ к отчёту
  const reportResult = await db.query(
    'SELECT id FROM reports WHERE id = $1 AND creator_user_id = $2',
    [reportId, userId]
  );

  if (reportResult.rows.length === 0) {
    const err = new Error('Report not found or access denied');
    err.statusCode = 403;
    throw err;
  }

  // Возвращаем все файлы отчёта
  const result = await db.query(
    `SELECT * FROM files WHERE report_id = $1 ORDER BY created_at ASC`,
    [reportId]
  );
  return result.rows;
}

// ------------------------------------------------------------
// Подписанные URL для всех файлов отчёта
// ------------------------------------------------------------

/**
 * Получить подписанные URL для всех файлов отчёта.
 *
 * Возвращает объект { relativePath: presignedUrl } для всех файлов.
 * Используется для генерации HTML с рабочими ссылками на фото/видео.
 *
 * @param {number} reportId - ID отчёта
 * @param {number} userId - ID пользователя (для проверки прав)
 * @param {number} [expires=3600] - время жизни URL в секундах
 * @returns {Promise<Object>} { 'photos/f1_1_001.jpg': 'https://...', ... }
 */
async function getReportFileUrls(reportId, userId, expires = 3600) {
  // Получаем все файлы отчёта
  const files = await listFilesByReport(reportId, userId);

  const urls = {};
  for (const file of files) {
    try {
      const url = await ks3.getPresignedUrl(file.storage_key, expires);
      urls[file.relative_path] = url;
    } catch (err) {
      logger.warn(`getReportFileUrls: failed to get URL for ${file.id}: ${err.message}`);
      // Пропускаем файлы с ошибками
    }
  }

  return urls;
}

// ------------------------------------------------------------
// Получение метаданных файла (files.txt п.2)
// ------------------------------------------------------------

/**
 * Получить метаданные файла по UUID (без содержимого).
 * Метаданные не чувствительны, права не проверяются.
 *
 * @param {string} fileId - UUID файла
 * @returns {Promise<object|null>} запись или null, если не найден
 */
async function getFileById(fileId) {
  const result = await db.query('SELECT * FROM files WHERE id = $1', [fileId]);
  return result.rows[0] || null;
}

// ------------------------------------------------------------
// Проверка прав (files.txt п.3, п.4)
// ------------------------------------------------------------

/**
 * Проверить, есть ли у пользователя указанное право на файл.
 *
 * Поддерживаемые права:
 *   owner  — полный доступ (только создатель)
 *   read   — чтение/скачивание
 *   write  — изменение
 *   share  — передача прав другим
 *
 * Если у пользователя есть право owner, он имеет все права.
 * Если есть share — может передавать read/write/share.
 *
 * @param {string} fileId - UUID файла
 * @param {number} userId - ID пользователя
 * @param {string} permission - требуемое право: 'read' | 'write' | 'share' | 'owner'
 * @returns {Promise<boolean>} true, если право есть
 */
async function hasPermission(fileId, userId, permission) {
  // Владелец имеет все права
  const result = await db.query(
    `SELECT 1 FROM file_permissions
     WHERE file_id = $1 AND user_id = $2
       AND (permission = 'owner' OR permission = $3)
     LIMIT 1`,
    [fileId, userId, permission]
  );
  return result.rows.length > 0;
}

/**
 * Проверить, является ли пользователь владельцем файла.
 * @param {string} fileId - UUID файла
 * @param {number} userId - ID пользователя
 * @returns {Promise<boolean>}
 */
async function isOwner(fileId, userId) {
  const result = await db.query(
    `SELECT 1 FROM files WHERE id = $1 AND owner_id = $2`,
    [fileId, userId]
  );
  return result.rows.length > 0;
}

// ------------------------------------------------------------
// Скачивание / подписанный URL (files.txt п.3)
// ------------------------------------------------------------

/**
 * Сгенерировать подписанный URL для скачивания/просмотра файла.
 *
 * Перед генерацией URL проверяется, есть ли у пользователя
 * право read (или write/owner, которые включают read).
 *
 * @param {string} fileId - UUID файла
 * @param {number} userId - ID пользователя
 * @param {number} [expires=3600] - время жизни URL в секундах
 * @returns {Promise<{url: string, file: object}>}
 * @throws {Error} если файл не найден (404) или нет прав (403)
 */
async function getDownloadUrl(fileId, userId, expires = 3600) {
  const file = await getFileById(fileId);
  if (!file) {
    const err = new Error('File not found');
    err.statusCode = 404;
    throw err;
  }

  // Проверяем право read (owner/write автоматически дают read)
  const canRead =
    (await hasPermission(fileId, userId, 'read')) ||
    (await hasPermission(fileId, userId, 'write')) ||
    (await isOwner(fileId, userId));

  if (!canRead) {
    const err = new Error('Forbidden: no read permission');
    err.statusCode = 403;
    throw err;
  }

  const url = await ks3.getPresignedUrl(file.storage_key, expires);
  return { url, file };
}

// ------------------------------------------------------------
// Передача прав (files.txt п.4)
// ------------------------------------------------------------

/**
 * Выдать право пользователю на файл.
 *
 * Текущий пользователь должен иметь право share или быть владельцем.
 * Право owner передать нельзя — только владелец файла остаётся владельцем.
 *
 * @param {object} params
 * @param {string} params.fileId - UUID файла
 * @param {number} params.fromUserId - кто выдаёт (из JWT)
 * @param {number} params.toUserId - кому выдать
 * @param {string} params.permission - тип права: 'read' | 'write' | 'share'
 * @returns {Promise<object>} созданная запись права
 * @throws {Error} 403 если нет прав на share, 400 если пытаемся передать owner
 */
async function grantPermission({ fileId, fromUserId, toUserId, permission }) {
  // owner передавать нельзя
  if (permission === 'owner') {
    const err = new Error('Cannot transfer owner permission');
    err.statusCode = 400;
    throw err;
  }

  // P3-49: проверяем существование целевого пользователя — иначе выдаём
  // осмысленный 404 вместо FK-ошибки базы данных.
  if (!(await userExists(toUserId))) {
    const err = new Error('Target user not found');
    err.statusCode = 404;
    throw err;
  }

  // Проверяем, может ли текущий пользователь раздавать права
  const canShare =
    (await hasPermission(fileId, fromUserId, 'share')) ||
    (await isOwner(fileId, fromUserId));

  if (!canShare) {
    const err = new Error('Forbidden: no share permission');
    err.statusCode = 403;
    throw err;
  }

  // Вставляем запись (или обновляем, если уже есть)
  const result = await db.query(
    `INSERT INTO file_permissions (file_id, user_id, permission, granted_by)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (file_id, user_id, permission)
     DO UPDATE SET granted_by = EXCLUDED.granted_by
     RETURNING *`,
    [fileId, toUserId, permission, fromUserId]
  );

  logger.info(`grantPermission: file=${fileId}, to=${toUserId}, perm=${permission}`);
  return result.rows[0];
}

// ------------------------------------------------------------
// Отзыв прав (files.txt п.5)
// ------------------------------------------------------------

/**
 * Отозвать право у пользователя.
 * Владелец не может потерять право owner.
 *
 * @param {object} params
 * @param {string} params.fileId - UUID файла
 * @param {number} params.fromUserId - кто отзывает (из JWT)
 * @param {number} params.targetUserId - у кого отзывается
 * @param {string} [params.permission] - конкретное право (если не указано, отзываются все)
 * @returns {Promise<number>} количество удалённых записей
 */
async function revokePermission({ fileId, fromUserId, targetUserId, permission }) {
  // P3-49: проверяем существование целевого пользователя — иначе выдаём
  // осмысленный 404 вместо молчаливого "removed: 0" (что скрывает баги клиента).
  if (!(await userExists(targetUserId))) {
    const err = new Error('Target user not found');
    err.statusCode = 404;
    throw err;
  }

  // Проверяем права отзывающего
  const canShare =
    (await hasPermission(fileId, fromUserId, 'share')) ||
    (await isOwner(fileId, fromUserId));

  if (!canShare) {
    const err = new Error('Forbidden: no share permission');
    err.statusCode = 403;
    throw err;
  }

  // Нельзя отозвать owner
  if (permission === 'owner') {
    const err = new Error('Cannot revoke owner permission');
    err.statusCode = 400;
    throw err;
  }

  // Удаляем запись(и) прав
  let query, params;
  if (permission) {
    query = `DELETE FROM file_permissions
             WHERE file_id = $1 AND user_id = $2 AND permission = $3
             AND permission != 'owner'`;
    params = [fileId, targetUserId, permission];
  } else {
    query = `DELETE FROM file_permissions
             WHERE file_id = $1 AND user_id = $2
             AND permission != 'owner'`;
    params = [fileId, targetUserId];
  }

  const result = await db.query(query, params);
  logger.info(
    `revokePermission: file=${fileId}, from=${targetUserId}, perm=${permission || 'all'}, removed=${result.rowCount}`
  );
  return result.rowCount;
}

// ------------------------------------------------------------
// Удаление файла (files.txt п.6)
// ------------------------------------------------------------

/**
 * Удалить файл.
 *
 * Только владелец может удалить файл.
 * Шаги:
 *   1. Проверяем, что пользователь — владелец
 *   2. Удаляем все права из file_permissions
 *   3. Удаляем запись из files
 *   4. Удаляем объект из KS3
 *
 * @param {string} fileId - UUID файла
 * @param {number} userId - ID пользователя (из JWT)
 * @returns {Promise<boolean>} true при успехе
 * @throws {Error} 404 если файл не найден, 403 если не владелец
 */
async function deleteFile(fileId, userId) {
  const file = await getFileById(fileId);
  if (!file) {
    const err = new Error('File not found');
    err.statusCode = 404;
    throw err;
  }

  if (file.owner_id !== userId) {
    const err = new Error('Forbidden: only owner can delete');
    err.statusCode = 403;
    throw err;
  }

  // 1. Удаляем права (CASCADE должен сделать это автоматически, но для надёжности)
  await db.query('DELETE FROM file_permissions WHERE file_id = $1', [fileId]);

  // 2. Удаляем запись из files
  await db.query('DELETE FROM files WHERE id = $1', [fileId]);

  // 3. Удаляем объект из KS3
  await ks3.deleteFile(file.storage_key);

  logger.info(`deleteFile: ${fileId} by user ${userId}`);
  return true;
}

// ------------------------------------------------------------
// Список файлов пользователя
// ------------------------------------------------------------

/**
 * Получить список файлов, доступных пользователю.
 * Включает файлы, которыми он владеет, и файлы с правами read/write/share.
 *
 * @param {number} userId - ID пользователя
 * @returns {Promise<Array>}
 */
async function listUserFiles(userId) {
  // P3-49: Запрашиваем только нужные колонки (не SELECT *).
  // storage_key не возвращается клиенту — снижает риск утечки путей KS3.
  // Список полей синхронизирован с filesController.listMyFiles.
  const result = await db.query(
    `SELECT DISTINCT
       f.id, f.original_name, f.size, f.mime_type,
       f.relative_path, f.is_inline, f.owner_id, f.created_at
     FROM files f
     LEFT JOIN file_permissions fp ON fp.file_id = f.id AND fp.user_id = $1
     WHERE f.owner_id = $1 OR fp.user_id = $1
     ORDER BY f.created_at DESC`,
    [userId]
  );
  return result.rows;
}

module.exports = {
  uploadFile,
  getFileById,
  hasPermission,
  isOwner,
  getDownloadUrl,
  grantPermission,
  revokePermission,
  deleteFile,
  listUserFiles,
  listFilesByReport,
  getReportFileUrls,
};
