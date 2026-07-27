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
//
// HTML генерируется сервером из report_data (JSONB в БД) при запросе /reports/:publicId/html.
// Flutter отображает HTML в iframe (srcdoc), оставаясь на localhost:4000.
// Медиа в HTML используют подписанные presigned URL из KS3.
// ============================================================

const { requireAuth } = require('../middleware/authMiddleware');
const reportsController = require('../controllers/reportsController');

async function reportsRoutes(fastify) {
  // Сохранить отчёт (создать новый или обновить)
  // Body: { title, reportData, reportId? }
  fastify.post('/', { preHandler: requireAuth }, reportsController.saveReport);

  // Список отчётов пользователя
  fastify.get('/', { preHandler: requireAuth }, reportsController.listReports);

  // Получить отчёт по ID
  fastify.get('/:id', { preHandler: requireAuth }, reportsController.getReport);

  // Получить HTML отчёта по публичному идентификатору (для Flutter iframe).
  fastify.get('/:publicId/html', { preHandler: requireAuth }, reportsController.getReportHtml);
}

module.exports = reportsRoutes;
