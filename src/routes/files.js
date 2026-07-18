// ============================================================
// Маршруты для работы с файлами (/files)
//
// Все эндпоинты требуют аутентификации (middleware requireAuth).
//
// Эндпоинты по спецификации files.txt:
//   POST   /files/upload              — загрузить файл
//   GET    /files                     — список файлов пользователя
//   GET    /files/by-report/:reportId — список файлов отчёта
//   GET    /files/by-report/:reportId/urls — подписанные URL файлов отчёта
//   GET    /files/:id                 — метаданные файла
//   GET    /files/:id/download        — подписанный URL для скачивания
//   POST   /files/:id/permissions     — выдать право
//   DELETE /files/:id/permissions/:uid — отозвать право
//   DELETE /files/:id                 — удалить файл
//
// БЕЗОПАСНОСТЬ: тестовые эндпоинты /files/ks3/* удалены
// (C-05, H-06, H-38) — они позволяли любому генерировать
// подписанные URL для чужих объектов и раскрывали bucket/region.
// ============================================================

const { requireAuth } = require('../middleware/authMiddleware');
const filesController = require('../controllers/filesController');

async function filesRoutes(fastify) {
  // --------------------------------------------------------
  // Основные эндпоинты (требуют аутентификацию)
  // --------------------------------------------------------

  // Загрузка файла (multipart/form-data)
  // Body: file + relativePath (опционально) + reportId (опционально)
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
  // Query: ?expires=3600 (время жизни URL в секундах, клампится 60..3600)
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
}

module.exports = filesRoutes;
