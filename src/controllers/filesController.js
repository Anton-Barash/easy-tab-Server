// ============================================================
// Files Controller — обработчики HTTP-запросов к /files
//
// Каждый обработчик:
//   1. Извлекает данные из запроса (body, params, query)
//   2. Вызывает соответствующий метод fileService
//   3. Возвращает результат клиенту
//
// Аутентификация: все эндпоинты требуют Bearer-токен.
// ID пользователя берётся из request.user (устанавливается middleware requireAuth).
// ============================================================

const fileService = require('../services/fileService');

// ------------------------------------------------------------
// POST /files/upload
// Загрузка файла (multipart/form-data)
// files.txt п.1
// ------------------------------------------------------------

/**
 * Загрузить файл на сервер.
 *
 * Ожидает multipart-форму с полями:
 *   - file: содержимое файла (обязательно)
 *   - relativePath: относительный путь в папке отчёта (опционально)
 *   - parentId: UUID папки-родителя (опционально)
 *   - reportId: ID отчёта для привязки файла (опционально)
 *
 * БЕЗОПАСНОСТЬ (H-10): поле ks3Folder больше НЕ принимается от клиента —
 * путь к папке отчёта в KS3 вычисляется сервером из БД по reportId.
 * relativePath валидируется сервером (sanitizeRelativePath).
 *
 * Если передан reportId — файл сохраняется в папку отчёта (reports/{uuid}/)
 * и привязывается к отчёту в БД.
 *
 * Возвращает: { success, file: { id, ... } }
 */
async function uploadFile(request, reply) {
  // Получаем файл из multipart-формы
  const data = await request.file();
  if (!data) {
    return reply.status(400).send({ success: false, error: 'No file provided' });
  }

  // Читаем содержимое файла в Buffer
  const buffer = await data.toBuffer();

  // Получаем дополнительные поля из формы
  // ВНИМАНИЕ: ks3Folder намеренно НЕ читаем из формы (H-10)
  const fields = data.fields;
  const relativePath = fields.relativePath?.value || null;
  const parentId = fields.parentId?.value || null;
  const reportId = fields.reportId?.value || null;

  try {
    // Загружаем через сервис
    const file = await fileService.uploadFile({
      userId: request.user.userId,
      originalName: data.filename,
      body: buffer,
      relativePath,
      parentId,
      reportId: reportId ? parseInt(reportId, 10) : null,
    });

    return reply.status(201).send({
      success: true,
      file: {
        id: file.id,
        originalName: file.original_name,
        size: file.size,
        mimeType: file.mime_type,
        relativePath: file.relative_path,
        isInline: file.is_inline,
        reportId: file.report_id,
        createdAt: file.created_at,
      },
    });
  } catch (error) {
    const status = error.statusCode || 500;
    return reply.status(status).send({
      success: false,
      // Не раскрываем детали внутренних ошибок (M-27)
      error: status >= 500 ? 'File upload failed' : error.message,
    });
  }
}

// ------------------------------------------------------------
// GET /files/by-report/:reportId
// Список файлов отчёта
// ------------------------------------------------------------

/**
 * Получить все файлы, привязанные к отчёту.
 *
 * Возвращает: { success, files: [...] }
 */
async function listFilesByReport(request, reply) {
  const { reportId } = request.params;
  const rid = parseInt(reportId, 10);

  // M-28: проверка NaN
  if (isNaN(rid) || rid < 1) {
    return reply.status(400).send({ success: false, error: 'Invalid report id' });
  }

  try {
    const files = await fileService.listFilesByReport(rid, request.user.userId);

    return reply.send({
      success: true,
      files: files.map((f) => ({
        id: f.id,
        originalName: f.original_name,
        size: f.size,
        mimeType: f.mime_type,
        relativePath: f.relative_path,
        isInline: f.is_inline,
        createdAt: f.created_at,
      })),
    });
  } catch (error) {
    const status = error.statusCode || 500;
    return reply.status(status).send({
      success: false,
      error: status >= 500 ? 'Failed to list files' : error.message,
    });
  }
}

// ------------------------------------------------------------
// GET /files/by-report/:reportId/urls
// Подписанные URL для всех файлов отчёта
// ------------------------------------------------------------

/**
 * Получить подписанные URL для всех файлов отчёта.
 *
 * Используется для генерации HTML с рабочими ссылками.
 *
 * Возвращает: { success, urls: { 'photos/f1_1_001.jpg': 'https://...', ... } }
 */
async function getReportFileUrls(request, reply) {
  const { reportId } = request.params;
  const rid = parseInt(reportId, 10);

  // M-28: проверка NaN
  if (isNaN(rid) || rid < 1) {
    return reply.status(400).send({ success: false, error: 'Invalid report id' });
  }

  // Клампим expires в безопасный диапазон 60..3600 секунд
  const expires = Math.min(Math.max(parseInt(request.query.expires, 10) || 3600, 60), 3600);

  try {
    const urls = await fileService.getReportFileUrls(rid, request.user.userId, expires);

    return reply.send({
      success: true,
      urls,
      expires,
    });
  } catch (error) {
    const status = error.statusCode || 500;
    return reply.status(status).send({
      success: false,
      error: status >= 500 ? 'Failed to get file URLs' : error.message,
    });
  }
}

// ------------------------------------------------------------
// GET /files/:id
// Получить метаданные файла (files.txt п.2)
// ------------------------------------------------------------

/**
 * Получить информацию о файле по UUID.
 * Метаданные публичны (права не проверяются).
 *
 * Возвращает: { success, file: { id, originalName, size, ... } }
 */
async function getFile(request, reply) {
  const { id } = request.params;
  const file = await fileService.getFileById(id);

  if (!file) {
    return reply.status(404).send({ success: false, error: 'File not found' });
  }

  return reply.send({
    success: true,
    file: {
      id: file.id,
      originalName: file.original_name,
      size: file.size,
      mimeType: file.mime_type,
      relativePath: file.relative_path,
      isInline: file.is_inline,
      parentId: file.parent_id,
      ownerId: file.owner_id,
      createdAt: file.created_at,
    },
  });
}

// ------------------------------------------------------------
// GET /files/:id/download
// Получить подписанный URL для скачивания/просмотра (files.txt п.3)
// ------------------------------------------------------------

/**
 * Сгенерировать подписанный URL для доступа к файлу.
 *
 * Проверяет право read у текущего пользователя.
 * URL действителен ограниченное время (по умолчанию 1 час).
 *
 * Query: ?expires=3600 (опционально, в секундах)
 *
 * Возвращает: { success, url, file, expires }
 */
async function downloadFile(request, reply) {
  const { id } = request.params;
  // Клампим expires в безопасный диапазон 60..3600 секунд
  const expires = Math.min(Math.max(parseInt(request.query.expires, 10) || 3600, 60), 3600);

  try {
    const { url, file } = await fileService.getDownloadUrl(
      id,
      request.user.userId,
      expires
    );

    return reply.send({
      success: true,
      url,
      expires,
      file: {
        id: file.id,
        originalName: file.original_name,
        mimeType: file.mime_type,
        isInline: file.is_inline,
      },
    });
  } catch (error) {
    const status = error.statusCode || 500;
    return reply.status(status).send({
      success: false,
      error: status >= 500 ? 'Failed to get download URL' : error.message,
    });
  }
}

// ------------------------------------------------------------
// POST /files/:id/permissions
// Передать право доступа (files.txt п.4)
// ------------------------------------------------------------

/**
 * Выдать право пользователю на файл.
 *
 * Body: { toUserId: number, permission: 'read'|'write'|'share' }
 *
 * Возвращает: { success, permission: { ... } }
 */
async function grantPermission(request, reply) {
  const { id } = request.params;
  const { toUserId: rawToUserId, permission } = request.body;

  // M-28: парсим toUserId как int с проверкой NaN
  const toUserId = parseInt(rawToUserId, 10);
  if (isNaN(toUserId) || toUserId < 1) {
    return reply
      .status(400)
      .send({ success: false, error: 'Invalid toUserId' });
  }

  if (!permission) {
    return reply
      .status(400)
      .send({ success: false, error: 'permission is required' });
  }

  const validPerms = ['read', 'write', 'share'];
  if (!validPerms.includes(permission)) {
    return reply
      .status(400)
      .send({ success: false, error: 'Invalid permission type' });
  }

  // L-32: запрет самовыдачи прав
  if (toUserId === request.user.userId) {
    return reply
      .status(400)
      .send({ success: false, error: 'Cannot grant permission to yourself' });
  }

  try {
    const perm = await fileService.grantPermission({
      fileId: id,
      fromUserId: request.user.userId,
      toUserId,
      permission,
    });

    return reply.status(201).send({ success: true, permission: perm });
  } catch (error) {
    const status = error.statusCode || 500;
    return reply.status(status).send({
      success: false,
      error: status >= 500 ? 'Failed to grant permission' : error.message,
    });
  }
}

// ------------------------------------------------------------
// DELETE /files/:id/permissions/:userId
// Отозвать право (files.txt п.5)
// ------------------------------------------------------------

/**
 * Отозвать все права у пользователя на файл.
 *
 * Query: ?permission=read (опционально, для отзыва конкретного права)
 *
 * Возвращает: { success, removed: number }
 */
async function revokePermission(request, reply) {
  const { id, userId } = request.params;
  const targetUserId = parseInt(userId, 10);

  // M-28: проверка NaN
  if (isNaN(targetUserId) || targetUserId < 1) {
    return reply.status(400).send({ success: false, error: 'Invalid user id' });
  }

  const permission = request.query.permission || null;

  try {
    const removed = await fileService.revokePermission({
      fileId: id,
      fromUserId: request.user.userId,
      targetUserId,
      permission,
    });

    return reply.send({ success: true, removed });
  } catch (error) {
    const status = error.statusCode || 500;
    return reply.status(status).send({
      success: false,
      error: status >= 500 ? 'Failed to revoke permission' : error.message,
    });
  }
}

// ------------------------------------------------------------
// DELETE /files/:id
// Удалить файл (files.txt п.6)
// ------------------------------------------------------------

/**
 * Удалить файл.
 * Только владелец может удалить файл.
 *
 * Возвращает: { success: true }
 */
async function deleteFile(request, reply) {
  const { id } = request.params;

  try {
    await fileService.deleteFile(id, request.user.userId);
    return reply.send({ success: true });
  } catch (error) {
    const status = error.statusCode || 500;
    return reply.status(status).send({
      success: false,
      error: status >= 500 ? 'Failed to delete file' : error.message,
    });
  }
}

// ------------------------------------------------------------
// GET /files
// Список файлов пользователя
// ------------------------------------------------------------

/**
 * Получить список файлов, доступных текущему пользователю
 * (владелец + выданные права).
 *
 * Возвращает: { success, files: [...] }
 */
async function listMyFiles(request, reply) {
  const files = await fileService.listUserFiles(request.user.userId);

  return reply.send({
    success: true,
    files: files.map((f) => ({
      id: f.id,
      originalName: f.original_name,
      size: f.size,
      mimeType: f.mime_type,
      relativePath: f.relative_path,
      isInline: f.is_inline,
      ownerId: f.owner_id,
      createdAt: f.created_at,
    })),
  });
}

// ------------------------------------------------------------
// GET /files/:id/presign
// Получить подписанный URL для файла, открытого по share-ссылке
// ------------------------------------------------------------

/**
 * Сгенерировать presigned URL для файла через share-ссылку.
 *
 * Query: ?share_token=abc (обязательно), ?expires=300 (опционально)
 *
 * Возвращает: { success, url, expires, file: { id, originalName, mimeType } }
 */
async function presignFileForShare(request, reply) {
  const { id } = request.params;
  const { share_token: shareToken } = request.query || {};

  if (!shareToken) {
    return reply.status(400).send({ success: false, error: 'share_token is required' });
  }

  const expires = Math.min(Math.max(parseInt(request.query.expires, 10) || 300, 60), 3600);

  try {
    const { url, file } = await fileService.presignFileForShare(id, shareToken, expires);

    return reply.send({
      success: true,
      url,
      expires,
      file: {
        id: file.id,
        originalName: file.original_name,
        mimeType: file.mime_type,
        isInline: file.is_inline,
      },
    });
  } catch (error) {
    const status = error.statusCode || 500;
    return reply.status(status).send({
      success: false,
      error: status >= 500 ? 'Failed to generate file URL' : error.message,
    });
  }
}

// ------------------------------------------------------------
// POST /files/presign-upload
// Получить presigned PUT URL для прямой загрузки в KS3
// ------------------------------------------------------------

/**
 * Подготовить presigned URL для прямой загрузки файла из браузера в KS3.
 *
 * Ожидает JSON: { fileName, relativePath?, reportId? }
 * Возвращает: { success, uploadUrl, fileId, storageKey, mimeType, relPath }
 */
async function presignUpload(request, reply) {
  const { fileName, relativePath, reportId } = request.body || {};

  if (!fileName) {
    return reply.status(400).send({ success: false, error: 'fileName is required' });
  }

  try {
    const result = await fileService.presignUpload({
      userId: request.user.userId,
      originalName: fileName,
      relativePath: relativePath || null,
      reportId: reportId ? parseInt(reportId, 10) : null,
    });

    return reply.send({
      success: true,
      uploadUrl: result.uploadUrl,
      fileId: result.fileId,
      storageKey: result.storageKey,
      mimeType: result.mimeType,
      relPath: result.relPath,
    });
  } catch (error) {
    const status = error.statusCode || 500;
    return reply.status(status).send({
      success: false,
      error: status >= 500 ? 'Failed to generate upload URL' : error.message,
    });
  }
}

// ------------------------------------------------------------
// POST /files/presign-upload-share
// Presigned PUT URL для загрузки через share-ссылку
// ------------------------------------------------------------

/**
 * Подготовить presigned URL для загрузки файла через share-ссылку.
 *
 * Body: { fileName, relativePath?, shareToken, reportId? }
 */
async function presignUploadForShare(request, reply) {
  const { fileName, relativePath, shareToken, reportId } = request.body || {};

  if (!fileName) {
    return reply.status(400).send({ success: false, error: 'fileName is required' });
  }
  if (!shareToken) {
    return reply.status(400).send({ success: false, error: 'shareToken is required' });
  }

  try {
    const result = await fileService.presignUploadForShare({
      shareToken,
      originalName: fileName,
      relativePath: relativePath || null,
      reportId: reportId ? parseInt(reportId, 10) : null,
    });

    return reply.send({
      success: true,
      uploadUrl: result.uploadUrl,
      fileId: result.fileId,
      storageKey: result.storageKey,
      mimeType: result.mimeType,
      relPath: result.relPath,
      reportId: result.reportId,
    });
  } catch (error) {
    const status = error.statusCode || 500;
    return reply.status(status).send({
      success: false,
      error: status >= 500 ? 'Failed to generate upload URL' : error.message,
    });
  }
}

// ------------------------------------------------------------
// POST /files/confirm-upload
// Подтвердить прямую загрузку файла — создать запись в БД
// ------------------------------------------------------------

/**
 * Подтвердить загрузку файла в KS3 и создать запись в БД.
 *
 * Ожидает JSON: { fileId, storageKey, fileName, size, mimeType, relPath, reportId?, parentId? }
 * Возвращает: { success, file: { id, ... } }
 */
async function confirmUpload(request, reply) {
  const body = request.body || {};
  const { fileId, storageKey, fileName, size, mimeType, relPath, reportId, parentId } = body;

  // Диагностика: логируем что пришло
  const logger = require('../utils/logger');
  logger.info(`confirmUpload: body=${JSON.stringify(body).substring(0, 500)}`);

  if (!fileId || !storageKey || !fileName || !size) {
    const missing = [
      !fileId ? 'fileId' : null,
      !storageKey ? 'storageKey' : null,
      !fileName ? 'fileName' : null,
      !size ? 'size' : null,
    ].filter(Boolean);
    logger.warn(`confirmUpload: missing fields: ${missing.join(', ')}`);
    return reply.status(400).send({ success: false, error: `Missing: ${missing.join(', ')}` });
  }

  try {
    const file = await fileService.confirmUpload({
      userId: request.user.userId,
      fileId,
      storageKey,
      originalName: fileName,
      size: parseInt(size, 10),
      mimeType,
      relPath,
      reportId: reportId ? parseInt(reportId, 10) : null,
      parentId: parentId || null,
    });

    return reply.status(201).send({
      success: true,
      file: {
        id: file.id,
        originalName: file.original_name,
        size: file.size,
        mimeType: file.mime_type,
        relativePath: file.relative_path,
        isInline: file.is_inline,
        reportId: file.report_id,
        createdAt: file.created_at,
      },
    });
  } catch (error) {
    const status = error.statusCode || 500;
    return reply.status(status).send({
      success: false,
      error: status >= 500 ? 'Failed to confirm upload' : error.message,
    });
  }
}

// ------------------------------------------------------------
// POST /files/confirm-upload-share
// Подтвердить загрузку через share-ссылку
// ------------------------------------------------------------

/**
 * Подтвердить загрузку файла через share-ссылку.
 *
 * Body: { fileId, storageKey, fileName, size, mimeType, relPath, shareToken, parentId? }
 */
async function confirmUploadForShare(request, reply) {
  const body = request.body || {};
  const { fileId, storageKey, fileName, size, mimeType, relPath, shareToken, parentId } = body;

  if (!fileId || !storageKey || !fileName || !size || !shareToken) {
    const missing = [
      !fileId ? 'fileId' : null,
      !storageKey ? 'storageKey' : null,
      !fileName ? 'fileName' : null,
      !size ? 'size' : null,
      !shareToken ? 'shareToken' : null,
    ].filter(Boolean);
    return reply.status(400).send({ success: false, error: `Missing: ${missing.join(', ')}` });
  }

  try {
    const file = await fileService.confirmUploadForShare({
      shareToken,
      fileId,
      storageKey,
      originalName: fileName,
      size: parseInt(size, 10),
      mimeType,
      relPath,
      parentId: parentId || null,
    });

    return reply.status(201).send({
      success: true,
      file: {
        id: file.id,
        originalName: file.original_name,
        size: file.size,
        mimeType: file.mime_type,
        relativePath: file.relative_path,
        isInline: file.is_inline,
        reportId: file.report_id,
        createdAt: file.created_at,
      },
    });
  } catch (error) {
    const status = error.statusCode || 500;
    return reply.status(status).send({
      success: false,
      error: status >= 500 ? 'Failed to confirm upload' : error.message,
    });
  }
}

module.exports = {
  uploadFile,
  presignUpload,
  confirmUpload,
  presignUploadForShare,
  confirmUploadForShare,
  getFile,
  downloadFile,
  presignFileForShare,
  grantPermission,
  revokePermission,
  deleteFile,
  listMyFiles,
  listFilesByReport,
  getReportFileUrls,
};
