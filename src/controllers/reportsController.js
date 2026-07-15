// ============================================================
// Reports Controller — обработчики HTTP-запросов к /reports
//
// Эндпоинты:
//   POST   /reports          — сохранить отчёт (создать/обновить)
//   GET    /reports          — список отчётов пользователя
//   GET    /reports/:id      — получить JSON отчёта
//   DELETE /reports/:id      — удалить отчёт
//
// Все эндпоинты требуют аутентификации (Bearer token).
// ID пользователя берётся из request.user (requireAuth middleware).
// ============================================================

const reportsService = require('../services/reportsService');

/**
 * POST /reports
 * Сохранить отчёт (создать новый или обновить существующий).
 *
 * Body: { title: string, reportData: object, reportId?: number }
 *
 * Если reportId передан — обновляем существующий отчёт.
 * Если не передан — создаём новый.
 *
 * Возвращает: { success, report: { id, title, ... } }
 */
async function saveReport(request, reply) {
  const { title, reportData, reportId } = request.body;

  // Валидация
  if (!title) {
    return reply.status(400).send({ success: false, error: 'Title is required' });
  }
  if (!reportData) {
    return reply.status(400).send({ success: false, error: 'Report data is required' });
  }

  try {
    const report = await reportsService.saveReport({
      userId: request.user.userId,
      title,
      reportData,
      reportId: reportId || null,
    });

    return reply.send({ success: true, report });
  } catch (error) {
    const status = error.statusCode || 500;
    return reply.status(status).send({ success: false, error: error.message });
  }
}

/**
 * GET /reports
 * Получить список всех отчётов текущего пользователя.
 *
 * Возвращает: { success, reports: [{ id, title, createdAt }] }
 */
async function listReports(request, reply) {
  const reports = await reportsService.listReports(request.user.userId);
  return reply.send({ success: true, reports });
}

/**
 * GET /reports/:id
 * Получить полный JSON отчёта по ID.
 *
 * Возвращает: { success, report: { id, title, reportData } }
 */
async function getReport(request, reply) {
  const { id } = request.params;

  try {
    const report = await reportsService.getReport(
      parseInt(id, 10),
      request.user.userId
    );

    return reply.send({ success: true, report });
  } catch (error) {
    const status = error.statusCode || 500;
    return reply.status(status).send({ success: false, error: error.message });
  }
}

/**
 * DELETE /reports/:id
 * Удалить отчёт (только владелец).
 *
 * Возвращает: { success: true }
 */
async function deleteReport(request, reply) {
  const { id } = request.params;

  try {
    await reportsService.deleteReport(parseInt(id, 10), request.user.userId);
    return reply.send({ success: true });
  } catch (error) {
    const status = error.statusCode || 500;
    return reply.status(status).send({ success: false, error: error.message });
  }
}

module.exports = {
  saveReport,
  listReports,
  getReport,
  deleteReport,
};
