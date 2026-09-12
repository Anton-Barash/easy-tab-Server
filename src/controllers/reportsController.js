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
const authService = require('../services/authService');
const logger = require('../utils/logger');

/**
 * POST /reports
 * Сохранить отчёт (создать новый или обновить существующий).
 *
 * Body: { title: string, reportData: object, reportId?: number, baseVersion?: number }
 *
 * Если reportId передан — обновляем существующий отчёт.
 * Если не передан — создаём новый.
 * baseVersion включает optimistic locking: при несовпадении возвращается 409.
 *
 * Возвращает: { success, report: { id, title, ... } }
 */
async function saveReport(request, reply) {
  const { title, reportData, reportId, baseVersion } = request.body;

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

  let parsedBaseVersion = null;
  if (baseVersion !== undefined && baseVersion !== null && baseVersion !== '') {
    parsedBaseVersion = Number(baseVersion);
    if (!Number.isInteger(parsedBaseVersion) || parsedBaseVersion < 1) {
      return reply.status(400).send({ success: false, error: 'Invalid baseVersion' });
    }
  }

  try {
    const report = await reportsService.saveReport({
      userId: request.user.userId,
      title,
      reportData,
      reportId: parsedReportId,
      baseVersion: parsedBaseVersion,
    });

    return reply.send({ success: true, report });
  } catch (error) {
    logger.error({ err: error }, 'saveReport failed');
    const status = error.statusCode || 500;
    const payload = {
      success: false,
      error: status >= 500 ? 'Failed to save report' : error.message,
    };
    if (error.code === 'VERSION_CONFLICT') {
      payload.code = error.code;
      payload.currentVersion = error.currentVersion;
    }
    return reply.status(status).send(payload);
  }
}

/**
 * PATCH /reports/:id
 * Обновить отчёт.
 *
 * Два формата тела:
 *   legacy: { baseVersion, baseSnapshot, reportData } — merge по дельте
 *   ops   : { ops: [...] }                              — merge-by-ID (Фаза 4)
 */
async function patchReport(request, reply) {
  const { id } = request.params;
  const reportId = parseInt(id, 10);
  const body = request.body || {};

  if (isNaN(reportId) || reportId < 1) {
    return reply.status(400).send({ success: false, error: 'Invalid report id' });
  }

  // ----- Merge-by-ID (ops) -----
  if (Array.isArray(body.ops)) {
    if (body.ops.length > 200) {
      return reply.status(400).send({ success: false, error: 'Too many ops' });
    }
    try {
      const report = await reportsService.patchReportOps({
        userId: request.user.userId,
        reportId,
        ops: body.ops,
      });
      return reply.send({
        success: true,
        newVersion: report.version,
        merged: report.merged,
      });
    } catch (error) {
      logger.error({ err: error }, 'patchReportOps failed');
      const status = error.statusCode || 500;
      const payload = {
        success: false,
        error: status >= 500 ? 'Failed to patch report' : error.message,
      };
      if (error.code === 'VERSION_CONFLICT') {
        payload.code = error.code;
        payload.currentVersion = error.currentVersion;
        if (error.conflicts && error.conflicts.length > 0) {
          payload.conflicts = error.conflicts;
        }
      }
      return reply.status(status).send(payload);
    }
  }

  // ----- Legacy (delta-merge) -----
  const { baseVersion, baseSnapshot, reportData } = body;
  if (baseSnapshot == null || typeof baseSnapshot !== 'object') {
    return reply.status(400).send({ success: false, error: 'baseSnapshot is required' });
  }
  if (reportData == null || typeof reportData !== 'object') {
    return reply.status(400).send({ success: false, error: 'reportData is required' });
  }

  const parsedBaseVersion = Number(baseVersion);
  if (!Number.isInteger(parsedBaseVersion) || parsedBaseVersion < 1) {
    return reply.status(400).send({ success: false, error: 'Invalid baseVersion' });
  }

  try {
    const report = await reportsService.patchReport({
      userId: request.user.userId,
      reportId,
      baseVersion: parsedBaseVersion,
      baseSnapshot,
      newReportData: reportData,
    });
    return reply.send({ success: true, report });
  } catch (error) {
    logger.error({ err: error }, 'patchReport (legacy) failed');
    const status = error.statusCode || 500;
    const payload = {
      success: false,
      error: status >= 500 ? 'Failed to patch report' : error.message,
    };
    if (error.code === 'VERSION_CONFLICT') {
      payload.code = error.code;
      payload.currentVersion = error.currentVersion;
      if (error.conflicts && error.conflicts.length > 0) {
        payload.conflicts = error.conflicts;
      }
    }
    return reply.status(status).send(payload);
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

    // baseUrl = null — используем относительные пути /view/report/:id/...
    // вместо абсолютных https-URL, чтобы избежать mixed content на HTTP-сервере.
    const baseUrl = null;

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
 * GET /reports/:publicId/view-token
 * Выдать короткоживущий (5 мин) read-only токен для просмотра HTML
 * во внешнем браузере, где нет HttpOnly cookie (например, на телефоне).
 *
 * Проверка доступа идентична /reports/:publicId/html (только владелец
 * или публичный отчёт). Возвращается токен, который подставляется в URL
 * /view/report/:publicId?token=...
 */
async function getHtmlViewToken(request, reply) {
  const { publicId } = request.params;

  if (!publicId || publicId.length < 6) {
    return reply.status(400).send({ success: false, error: 'Invalid report id' });
  }

  try {
    const userId = request.user.userId;
    // Проверка доступа: бросит 403 если отчёт приватный и не принадлежит userId.
    await reportsService.getReportForViewByPublicId(publicId, userId);

    const token = authService.generateViewToken(userId, request.user.username);
    return reply.send({ success: true, token, expiresIn: 86400 });
  } catch (error) {
    const status = error.statusCode || 401;
    return reply.status(status).send({
      success: false,
      error: status >= 500 ? 'Failed to generate view token' : error.message,
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

/**
 * POST /reports/verify
 * Проверить подлинность отчёта по паре (reportId + verificationCode).
 *
 * Тело: { reportId, verificationCode }. Не требует JWT — достаточно корректной
 * пары. При успехе возвращает метаданные отчёта и имя автора; авторство не
 * передаётся и не отбирается (только подтверждение подлинности).
 *
 * Возвращает: { success: true, report: { id, publicId, title, authorName } }
 * Ошибки: 400 — невалидный id/код, 404 — отчёт не найден, 403 — неверный код.
 */
async function verifyReport(request, reply) {
  const { reportId, verificationCode } = request.body || {};
  const parsedId = Number(reportId);

  if (!Number.isInteger(parsedId) || parsedId < 1) {
    return reply.status(400).send({ success: false, error: 'Invalid reportId' });
  }
  if (typeof verificationCode !== 'string' || !/^[0-9a-f]{64}$/.test(verificationCode)) {
    return reply.status(400).send({ success: false, error: 'Invalid verificationCode' });
  }

  try {
    const report = await reportsService.verifyReport({
      reportId: parsedId,
      verificationCode,
    });
    return reply.send({ success: true, report });
  } catch (error) {
    const status = error.statusCode || 500;
    return reply.status(status).send({
      success: false,
      error: status >= 500 ? 'Failed to verify report' : error.message,
    });
  }
}

module.exports = {
  saveReport,
  patchReport,
  listReports,
  verifyReport,
  getReport,
  deleteReport,
  getReportHtml,
  getHtmlViewToken,
  downloadReportZip,
};
