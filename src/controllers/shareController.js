// ============================================================
// Share Controller — HTTP-обработчики для share-ссылок.
//
// Эндпоинты:
//   POST   /reports/:id/shares              — создать share-ссылку
//   GET    /reports/:id/shares              — список ссылок отчёта
//   DELETE /reports/shares/:token           — отозвать ссылку
//   GET    /reports/shares/:token           — мета-информация (welcome)
//   POST   /reports/shares/:token/save      — сохранить отчёт по ссылке
//   GET    /reports/shares/:token/html      — HTML для просмотра
//   GET    /reports/shares/:token/zip       — ZIP для офлайн-работы
//
// Анонимные эндпоинты используют optionalAuth для логирования
// авторизованных пользователей, но не требуют авторизации.
// ============================================================

const shareService = require('../services/shareService');
const reportsService = require('../services/reportsService');
const fileService = require('../services/fileService');
const zipService = require('../services/zipService');
const { generateWelcomeHtml, generateShareErrorHtml } = require('../services/htmlGenerator');

/**
 * POST /reports/:id/shares
 * Создать share-ссылку на отчёт.
 */
async function createShare(request, reply) {
  const reportId = parseInt(request.params.id, 10);
  if (!Number.isInteger(reportId) || reportId < 1) {
    return reply.status(400).send({ success: false, error: 'Invalid report id' });
  }

  const { expiresAt, permissions } = request.body || {};

  try {
    const share = await shareService.createShare({
      reportId,
      userId: request.user.userId,
      expiresAt,
      permissions,
    });

    const baseUrl = `${request.protocol}://${request.host}`;
    const url = `${baseUrl}/#/welcome?token=${share.token}`;

    return reply.send({ success: true, share: { ...share, url } });
  } catch (error) {
    const status = error.statusCode || 500;
    return reply.status(status).send({
      success: false,
      error: status >= 500 ? 'Failed to create share link' : error.message,
    });
  }
}

/**
 * GET /reports/:id/shares
 * Список share-ссылок отчёта.
 */
async function listShares(request, reply) {
  const reportId = parseInt(request.params.id, 10);
  if (!Number.isInteger(reportId) || reportId < 1) {
    return reply.status(400).send({ success: false, error: 'Invalid report id' });
  }

  try {
    const shares = await shareService.listSharesForReport(reportId, request.user.userId);
    return reply.send({ success: true, shares });
  } catch (error) {
    const status = error.statusCode || 500;
    return reply.status(status).send({
      success: false,
      error: status >= 500 ? 'Failed to list share links' : error.message,
    });
  }
}

/**
 * DELETE /reports/shares/:token
 * Отозвать share-ссылку.
 */
async function revokeShare(request, reply) {
  const { token } = request.params;

  try {
    await shareService.revokeShare({ token, userId: request.user.userId });
    return reply.send({ success: true });
  } catch (error) {
    const status = error.statusCode || 500;
    return reply.status(status).send({
      success: false,
      error: status >= 500 ? 'Failed to revoke share link' : error.message,
    });
  }
}

/**
 * GET /reports/shares/:token
 * Мета-информация отчёта для welcome-экрана.
 */
async function getShareInfo(request, reply) {
  const { token } = request.params;
  const anonymousId = request.query.anonymous_id || null;

  try {
    const { share, report } = await shareService.getReportByShareToken(token);

    await shareService.logShareAccess({
      shareId: share.id,
      request,
      anonymousId,
      action: 'welcome_open',
    });

    return reply.send({
      success: true,
      report: {
        id: report.id,
        title: report.title,
        publicId: report.publicId,
        ks3Folder: report.ks3Folder,
        reportData: report.reportData,
      },
      share: {
        token: share.token,
        expiresAt: share.expiresAt,
        permissions: share.permissions,
      },
    });
  } catch (error) {
    const status = error.statusCode || 500;
    return reply.status(status).send({
      success: false,
      error: status >= 500 ? 'Failed to load share link' : error.message,
    });
  }
}

/**
 * POST /reports/shares/:token/save
 * Сохранить изменения отчёта, открытого по share-ссылке.
 */
async function saveSharedReport(request, reply) {
  const { token } = request.params;
  const { reportData, anonymousId, baseVersion } = request.body || {};

  if (!reportData) {
    return reply.status(400).send({ success: false, error: 'Report data is required' });
  }

  try {
    const { share, report } = await shareService.getReportByShareToken(token);

    if (!shareService.canEdit(share)) {
      return reply.status(403).send({ success: false, error: 'This share link is view-only' });
    }

    let parsedBaseVersion = null;
    if (baseVersion !== undefined && baseVersion !== null && baseVersion !== '') {
      parsedBaseVersion = Number(baseVersion);
      if (!Number.isInteger(parsedBaseVersion) || parsedBaseVersion < 1) {
        return reply.status(400).send({ success: false, error: 'Invalid baseVersion' });
      }
    }

    const updated = await reportsService.saveReport({
      userId: report.creatorUserId,
      title: report.title,
      reportData,
      reportId: report.id,
      baseVersion: parsedBaseVersion,
    });

    await shareService.logShareAccess({
      shareId: share.id,
      request,
      anonymousId,
      action: 'save',
    });

    return reply.send({ success: true, report: updated });
  } catch (error) {
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
 * GET /reports/shares/:token/html
 * HTML-версия отчёта для просмотра.
 */
async function getSharedReportHtml(request, reply) {
  const { token } = request.params;
  const anonymousId = request.query.anonymous_id || null;

  try {
    const { share, report } = await shareService.getReportByShareToken(token);

    if (!shareService.canView(share)) {
      return reply.status(403).send({ success: false, error: 'Forbidden' });
    }

    const baseUrl = `${request.protocol}://${request.host}`;
    const html = await reportsService.getReportHtml(report, null, baseUrl, token);

    await shareService.logShareAccess({
      shareId: share.id,
      request,
      anonymousId,
      action: 'html_open',
    });

    return reply.type('text/html').send(html);
  } catch (error) {
    const status = error.statusCode || 500;
    return reply.status(status).send({
      success: false,
      error: status >= 500 ? 'Failed to generate HTML' : error.message,
    });
  }
}

/**
 * GET /reports/shares/:token/welcome
 * HTML-welcome страница share-ссылки (чистый HTML, без Flutter).
 * Показывает название отчёта и кнопки-действия. Во Flutter переходит
 * только кнопка «Редактировать» (/#/share-edit?token=...).
 */
async function getSharedWelcomeHtml(request, reply) {
  const { token } = request.params;
  const anonymousId = request.query.anonymous_id || null;

  try {
    const { share, report } = await shareService.getReportByShareToken(token);

    if (!shareService.canView(share)) {
      return reply
        .status(403)
        .type('text/html')
        .send(generateShareErrorHtml(403, `${request.protocol}://${request.host}/`));
    }

    const baseUrl = `${request.protocol}://${request.host}`;
    // Все локализованные строки теперь генерируются inline в самом HTML
    // через встроенный i18n-bootstrap — не передаём labels-объект.
    const html = generateWelcomeHtml(share, report, baseUrl);

    await shareService.logShareAccess({
      shareId: share.id,
      request,
      anonymousId,
      action: 'welcome_html_open',
    });

    return reply.type('text/html').send(html);
  } catch (error) {
    const status = error.statusCode || 500;
    // Для 4xx — HTML-страница с i18n (403 Forbidden), для 5xx — тоже HTML
    // (иначе анонимный пользователь увидит голый JSON).
    if (status >= 400 && status < 500) {
      return reply
        .status(status)
        .type('text/html')
        .send(generateShareErrorHtml(403, `${request.protocol}://${request.host}/`));
    }
    return reply.status(status).type('text/html').send(
      generateShareErrorHtml(500, `${request.protocol}://${request.host}/`),
    );
  }
}

/**
 * GET /reports/shares/:token/zip
 * ZIP-архив отчёта для офлайн-работы.
 *
 * - Для view-only ссылок: HTML + медиа (без report.json, чтобы не раздавать
 *   исходные редактируемые данные без права редактирования).
 * - Для edit/full ссылок: добавляется report.json.
 */
async function downloadSharedReportZip(request, reply) {
  const { token } = request.params;
  const anonymousId = request.query.anonymous_id || null;

  try {
    const { share, report } = await shareService.getReportByShareToken(token);

    if (!shareService.canView(share)) {
      return reply.status(403).send({ success: false, error: 'Forbidden' });
    }

    const includeJson = share.permissions !== 'view';
    const { buffer, fileName } = await zipService.generateReportZip(report, {
      includeJson,
    });

    await shareService.logShareAccess({
      shareId: share.id,
      request,
      anonymousId,
      action: 'zip_download',
    });

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
  createShare,
  listShares,
  revokeShare,
  getShareInfo,
  saveSharedReport,
  getSharedReportHtml,
  getSharedWelcomeHtml,
  downloadSharedReportZip,
};
