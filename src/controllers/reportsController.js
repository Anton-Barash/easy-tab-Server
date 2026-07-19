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
 * GET /reports/:id/html
 * Получить HTML отчёта для отображения внутри Flutter (через iframe srcdoc).
 *
 * Сервер:
 *   1. Проверяет доступ (владелец / публичный)
 *   2. Скачивает report.json из KS3
 *   3. Генерирует HTML с АБСОЛЮТНЫМИ URL к фото (через baseUrl)
 *   4. Возвращает JSON { success, html }
 *
 * Flutter вызывает этот эндпоинт, получает HTML-строку и
 * отображает её в iframe srcdoc (оставаясь на localhost:4000).
 *
 * Возвращает: { success: true, html: string }
 */
async function getReportHtml(request, reply) {
  const { id } = request.params;
  const reportId = parseInt(id, 10);

  if (isNaN(reportId) || reportId < 1) {
    return reply.status(400).send({ success: false, error: 'Invalid report id' });
  }

  try {
    const userId = request.user.userId;
    const report = await reportsService.getReportForView(reportId, userId);

    if (!report.ks3Folder) {
      return reply.status(404).send({ success: false, error: 'Report files not found' });
    }

    // Для приватных отчётов: токен нужен для proxy-URL фото.
    // Cookies не работают для кросс-оригинных запросов из iframe (localhost:4000 -> localhost:8000),
    // поэтому передаём токен в URL.
    const authHeader = request.headers.authorization || '';
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;

    // Формируем baseUrl для абсолютных URL в HTML (чтобы iframe мог загрузить фото).
    // В dev: http://localhost:8000, в prod: https://domain.com
    const baseUrl = `${request.protocol}://${request.host}`;

    const html = await reportsService.getReportHtml(report.ks3Folder, reportId, token, baseUrl);

    return reply.send({ success: true, html });
  } catch (error) {
    const status = error.statusCode || 500;
    return reply.status(status).send({
      success: false,
      error: status >= 500 ? 'Failed to generate HTML' : error.message,
    });
  }
}

module.exports = {
  saveReport,
  listReports,
  getReport,
  deleteReport,
  getReportHtml,
};
