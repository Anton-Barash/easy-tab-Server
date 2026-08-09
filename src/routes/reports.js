// ============================================================
// Маршруты для работы с отчётами (/reports)
//
// Все эндпоинты требуют аутентификации (requireAuth).
//
// Используются web-версией приложения для сохранения/загрузки
// отчётов на сервере (т.к. path_provider не работает на web).
//
// Эндпоинты:
//   POST   /reports                — сохранить отчёт (создать/обновить)
//   GET    /reports                — список отчётов пользователя
//   GET    /reports/:id            — получить JSON отчёта
//   DELETE /reports/:id            — удалить отчёт
//   GET    /reports/:publicId/html — получить HTML отчёта (генерируется сервером из JSON)
//   GET    /reports/:publicId/zip  — скачать ZIP-архив отчёта
//
// HTML генерируется сервером из report_data (JSONB в БД) при запросе /reports/:publicId/html.
// Flutter отображает HTML в iframe (srcdoc), оставаясь на localhost:4000.
// Медиа в HTML используют подписанные presigned URL из KS3.
// ============================================================

const { requireAuth, optionalAuth } = require('../middleware/authMiddleware');
const reportsController = require('../controllers/reportsController');
const shareController = require('../controllers/shareController');

async function reportsRoutes(fastify) {
  // Сохранить отчёт (создать новый или обновить)
  // Body: { title, reportData, reportId? }
  fastify.post('/', { preHandler: requireAuth }, reportsController.saveReport);

  // Список отчётов пользователя
  fastify.get('/', { preHandler: requireAuth }, reportsController.listReports);

  // Получить отчёт по ID
  fastify.get('/:id', { preHandler: requireAuth }, reportsController.getReport);

  // Удалить отчёт по ID
  fastify.delete('/:id', { preHandler: requireAuth }, reportsController.deleteReport);

  // Получить HTML отчёта по публичному идентификатору (для Flutter iframe).
  fastify.get('/:publicId/html', { preHandler: requireAuth }, reportsController.getReportHtml);

  // Скачать ZIP-архив отчёта (JSON + HTML + медиа).
  fastify.get('/:publicId/zip', { preHandler: requireAuth }, reportsController.downloadReportZip);

  // ------------------------------------------------------------
  // Share-ссылки
  // ------------------------------------------------------------

  // Создать share-ссылку на отчёт
  // Body: { expiresAt?, permissions? }
  fastify.post('/:id/shares', { preHandler: requireAuth }, shareController.createShare);

  // Список share-ссылок отчёта
  fastify.get('/:id/shares', { preHandler: requireAuth }, shareController.listShares);

  // Отозвать share-ссылку
  fastify.delete('/shares/:token', { preHandler: requireAuth }, shareController.revokeShare);

  // Мета-информация share-ссылки (welcome-экран)
  fastify.get('/shares/:token', { preHandler: optionalAuth }, shareController.getShareInfo);

  // Сохранить отчёт, открытый по share-ссылке
  fastify.post('/shares/:token/save', { preHandler: optionalAuth }, shareController.saveSharedReport);

  // HTML для просмотра по share-ссылке
  fastify.get('/shares/:token/html', { preHandler: optionalAuth }, shareController.getSharedReportHtml);

  // ZIP для офлайн-работы по share-ссылке
  fastify.get('/shares/:token/zip', { preHandler: optionalAuth }, shareController.downloadSharedReportZip);
}

module.exports = reportsRoutes;
