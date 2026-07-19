// ============================================================
// Маршруты для работы с отчётами (/reports)
//
// Все эндпоинты требуют аутентификации (requireAuth).
//
// Используются web-версией приложения для сохранения/загрузки
// отчётов на сервере (т.к. path_provider не работает на web).
//
// Эндпоинты:
//   POST   /reports          — сохранить отчёт (создать/обновить)
//   GET    /reports          — список отчётов пользователя
//   GET    /reports/:id      — получить JSON отчёта
//   DELETE /reports/:id      — удалить отчёт
//   GET    /reports/:id/html — получить HTML отчёта (генерируется сервером из JSON в KS3)
//
// HTML генерируется сервером из report.json при запросе /reports/:id/html.
// Flutter отображает HTML в iframe (srcdoc), оставаясь на localhost:4000.
// Медиа загружаются через /view/report/:id/files/* с авторизацией через cookies.
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

  // Удалить отчёт
  fastify.delete('/:id', { preHandler: requireAuth }, reportsController.deleteReport);

  // Получить HTML отчёта (для отображения внутри Flutter через iframe srcdoc).
  // Возвращает JSON { success, html }. Сервер сам генерирует HTML из JSON в KS3.
  fastify.get('/:id/html', { preHandler: requireAuth }, reportsController.getReportHtml);
}

module.exports = reportsRoutes;
