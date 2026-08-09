// ============================================================
// Reports Controller — обработчики HTTP-запросов к /reports
//
// Эндпоинты:
//   POST   /reports                — сохранить отчёт (создать/обновить)
//   GET    /reports                — список отчётов пользователя
//   GET    /reports/:id            — получить JSON отчёта
//   DELETE /reports/:id            — удалить отчёт
//   GET    /reports/:publicId/html — получить HTML отчёта
//
// Все эндпоинты требуют аутентификации (Bearer token).
// ID пользователя берётся из request.user (requireAuth middleware).
// ============================================================

const reportsService = require('../services/reportsService');
const zipService = require('../services/zipService');

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

  // P3-49: Валидация reportId — должен быть положительным целым, если передан.
  // Без этого можно передать NaN/string/отрицательное число, что приведёт
  // к неожиданному поведению в SQL-запросе.
  let parsedReportId = null;
  if (reportId !== undefined && reportId !== null && reportId !== '') {
    parsedReportId = Number(reportId);
    if (!Number.isInteger(parsedReportId) || parsedReportId < 1) {
      return reply.status(400).send({ success: false, error: 'Invalid reportId' });
    }
  }

  try {
    const report = await reportsService.saveReport({
      userId: request.user.userId,
      title,
      reportData,
      reportId: parsedReportId,
    });

    return reply.send({ success: true, report });
  } catch (error) {
    const status = error.statusCode || 500;
    return reply.status(status).send({
      success: false,
      error: status >= 500 ? 'Failed to save report' : error.message,
    });
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
  const reportId = parseInt(id, 10);

  // M-28: проверка NaN — иначе NaN передаётся в SQL-запрос.
  if (isNaN(reportId) || reportId < 1) {
    return reply.status(400).send({ success: false, error: 'Invalid report id' });
  }

  try {
    const report = await reportsService.getReport(reportId, request.user.userId);
    return reply.send({ success: true, report });
  } catch (error) {
    const status = error.statusCode || 500;
    return reply.status(status).send({
      success: false,
      // M-27: не раскрываем детали внутренних ошибок для 5xx
      error: status >= 500 ? 'Failed to get report' : error.message,
    });
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
  const reportId = parseInt(id, 10);

  // M-28: проверка NaN
  if (isNaN(reportId) || reportId < 1) {
    return reply.status(400).send({ success: false, error: 'Invalid report id' });
  }

  try {
    await reportsService.deleteReport(reportId, request.user.userId);
    return reply.send({ success: true });
  } catch (error) {
    const status = error.statusCode || 500;
    return reply.status(status).send({
      success: false,
      error: status >= 500 ? 'Failed to delete report' : error.message,
    });
  }
}

/**
 * GET /reports/:publicId/html
 * Получить HTML отчёта для отображения внутри Flutter (через iframe srcdoc).
 *
 * Сервер:
 *   1. Проверяет доступ (владелец / публичный)
 *   2. Читает JSON-данные отчёта из БД
 *   3. Генерирует presigned URL для медиафайлов
 *   4. Генерирует HTML и возвращает JSON { success, html }
 *
 * Flutter вызывает этот эндпоинт, получает HTML-строку и
 * отображает её в iframe srcdoc (оставаясь на localhost:4000).
 *
 * Возвращает: { success: true, html: string }
 */
async function getReportHtml(request, reply) {
  const { publicId } = request.params;

  if (!publicId || publicId.length < 6) {
    return reply.status(400).send({ success: false, error: 'Invalid report id' });
  }

  try {
    const userId = request.user.userId;
    const report = await reportsService.getReportForViewByPublicId(publicId, userId);

    // Для приватных отчётов: токен передаётся для fallback proxy-URL фото.
    const authHeader = request.headers.authorization || '';
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;

    // Абсолютный baseUrl сервера — используется только для fallback proxy-ссылок.
    const baseUrl = `${request.protocol}://${request.host}`;

    const html = await reportsService.getReportHtml(report, token, baseUrl);

    return reply.send({ success: true, html });
  } catch (error) {
    const status = error.statusCode || 500;
    return reply.status(status).send({
      success: false,
      error: status >= 500 ? 'Failed to generate HTML' : error.message,
    });
  }
}

/**
 * GET /reports/:publicId/zip
 * Скачать ZIP-архив отчёта (JSON + HTML + медиа).
 *
 * Доступно только владельцу отчёта.
 */
async function downloadReportZip(request, reply) {
  const { publicId } = request.params;

  if (!publicId || publicId.length < 6) {
    return reply.status(400).send({ success: false, error: 'Invalid report id' });
  }

  try {
    const userId = request.user.userId;
    const report = await reportsService.getReportForViewByPublicId(publicId, userId);

    const { buffer, fileName } = await zipService.generateReportZip(report);

    return reply
      .header('Content-Disposition', `attachment; filename="${fileName}"`)
      .type('application/zip')
      .send(buffer);
  } catch (error) {
    const status = error.statusCode || 500;
    return reply.status(status).send({
      success: false,
      error: status >= 500 ? 'Failed to generate ZIP' : error.message,
    });
  }
}

module.exports = {
  saveReport,
  listReports,
  getReport,
  deleteReport,
  getReportHtml,
  downloadReportZip,
};
