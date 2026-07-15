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
 *   - ks3Folder: папка отчёта в KS3 (опционально, например "reports/uuid/")
 *
 * Если передан reportId + ks3Folder — файл сохраняется в папку отчёта
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
  const fields = data.fields;
  const relativePath = fields.relativePath?.value || null;
  const parentId = fields.parentId?.value || null;
  const reportId = fields.reportId?.value || null;
  const ks3Folder = fields.ks3Folder?.value || null;

  // Загружаем через сервис
  const file = await fileService.uploadFile({
    userId: request.user.userId,
    originalName: data.filename,
    body: buffer,
    relativePath,
    parentId,
    reportId: reportId ? parseInt(reportId, 10) : null,
    ks3Folder,
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

  try {
    const files = await fileService.listFilesByReport(
      parseInt(reportId, 10),
      request.user.userId
    );

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
      error: error.message,
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
  const expires = parseInt(request.query.expires, 10) || 3600;

  try {
    const urls = await fileService.getReportFileUrls(
      parseInt(reportId, 10),
      request.user.userId,
      expires
    );

    return reply.send({
      success: true,
      urls,
      expires,
    });
  } catch (error) {
    const status = error.statusCode || 500;
    return reply.status(status).send({
      success: false,
      error: error.message,
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
  const expires = parseInt(request.query.expires, 10) || 3600;

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
      error: error.message,
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
  const { toUserId, permission } = request.body;

  // Валидация
  if (!toUserId || !permission) {
    return reply
      .status(400)
      .send({ success: false, error: 'toUserId and permission are required' });
  }

  const validPerms = ['read', 'write', 'share'];
  if (!validPerms.includes(permission)) {
    return reply
      .status(400)
      .send({ success: false, error: 'Invalid permission type' });
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
      error: error.message,
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
  const permission = request.query.permission || null;

  try {
    const removed = await fileService.revokePermission({
      fileId: id,
      fromUserId: request.user.userId,
      targetUserId: parseInt(userId, 10),
      permission,
    });

    return reply.send({ success: true, removed });
  } catch (error) {
    const status = error.statusCode || 500;
    return reply.status(status).send({
      success: false,
      error: error.message,
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
      error: error.message,
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

module.exports = {
  uploadFile,
  getFile,
  downloadFile,
  grantPermission,
  revokePermission,
  deleteFile,
  listMyFiles,
  listFilesByReport,
  getReportFileUrls,
};
