// ============================================================
// Маршруты для работы с файлами (/files)
//
// Все эндпоинты (кроме KS3-тестов) требуют аутентификации
// (middleware requireAuth).
//
// Эндпоинты по спецификации files.txt:
//   POST   /files/upload              — загрузить файл
//   GET    /files                     — список файлов пользователя
//   GET    /files/:id                 — метаданные файла
//   GET    /files/:id/download        — подписанный URL для скачивания
//   POST   /files/:id/permissions     — выдать право
//   DELETE /files/:id/permissions/:uid — отозвать право
//   DELETE /files/:id                 — удалить файл
//
// Тестовые эндпоинты (без аутентификации):
//   GET    /files/ks3/check           — проверить доступность бакета
//   POST   /files/ks3/presigned-url   — тестовая генерация URL
// ============================================================

const { requireAuth } = require('../middleware/authMiddleware');
const filesController = require('../controllers/filesController');
const ks3Storage = require('../services/ks3Storage');

async function filesRoutes(fastify) {
  // --------------------------------------------------------
  // Основные эндпоинты (требуют аутентификацию)
  // --------------------------------------------------------

  // Загрузка файла (multipart/form-data)
  // Body: file + relativePath (опционально) + parentId (опционально)
  fastify.post('/upload', { preHandler: requireAuth }, filesController.uploadFile);

  // Список всех файлов пользователя (владелец + выданные права)
  fastify.get('/', { preHandler: requireAuth }, filesController.listMyFiles);

  // Список файлов отчёта по ID отчёта
  // Возвращает все файлы, привязанные к отчёту
  fastify.get(
    '/by-report/:reportId',
    { preHandler: requireAuth },
    filesController.listFilesByReport
  );

  // Подписанные URL для всех файлов отчёта
  // Используется для генерации HTML с рабочими ссылками
  fastify.get(
    '/by-report/:reportId/urls',
    { preHandler: requireAuth },
    filesController.getReportFileUrls
  );

  // Метаданные файла по UUID
  fastify.get('/:id', { preHandler: requireAuth }, filesController.getFile);

  // Подписанный URL для скачивания/просмотра файла
  // Query: ?expires=3600 (время жизни URL в секундах)
  fastify.get(
    '/:id/download',
    { preHandler: requireAuth },
    filesController.downloadFile
  );

  // Выдать право доступа другому пользователю
  // Body: { toUserId: number, permission: 'read'|'write'|'share' }
  fastify.post(
    '/:id/permissions',
    { preHandler: requireAuth },
    filesController.grantPermission
  );

  // Отозвать право у пользователя
  // Query: ?permission=read (опционально, для конкретного права)
  fastify.delete(
    '/:id/permissions/:userId',
    { preHandler: requireAuth },
    filesController.revokePermission
  );

  // Удалить файл (только владелец)
  fastify.delete('/:id', { preHandler: requireAuth }, filesController.deleteFile);

  // --------------------------------------------------------
  // Тестовые эндпоинты для KS3 (без аутентификации)
  // --------------------------------------------------------

  // Проверка доступности бакета KS3
  fastify.get('/ks3/check', async (request, reply) => {
    try {
      const isAccessible = await ks3Storage.checkBucket();
      return reply.send({
        success: isAccessible,
        bucket: ks3Storage.KS3_CONFIG.bucket,
        region: ks3Storage.KS3_CONFIG.region,
        message: isAccessible
          ? 'KS3 bucket is accessible'
          : 'KS3 bucket not accessible',
      });
    } catch (error) {
      return reply.status(500).send({ error: error.message });
    }
  });

  // Тестовая генерация подписанного URL
  // Body: { key: string, expires?: number }
  fastify.post('/ks3/presigned-url', async (request, reply) => {
    try {
      const { key, expires } = request.body;
      if (!key) {
        return reply.status(400).send({ error: 'Key is required' });
      }
      const url = await ks3Storage.getPresignedUrl(key, expires || 3600);
      return reply.send({
        success: true,
        url,
        key,
        expires: expires || 3600,
      });
    } catch (error) {
      return reply.status(500).send({ error: error.message });
    }
  });
}

module.exports = filesRoutes;
