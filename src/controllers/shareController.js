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
const { generateWelcomeHtml } = require('../services/htmlGenerator');

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
  const { reportData, anonymousId } = request.body || {};

  if (!reportData) {
    return reply.status(400).send({ success: false, error: 'Report data is required' });
  }

  try {
    const { share, report } = await shareService.getReportByShareToken(token);

    if (!shareService.canEdit(share)) {
      return reply.status(403).send({ success: false, error: 'This share link is view-only' });
    }

    const updated = await reportsService.saveReport({
      userId: report.creatorUserId,
      title: report.title,
      reportData,
      reportId: report.id,
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
    return reply.status(status).send({
      success: false,
      error: status >= 500 ? 'Failed to save report' : error.message,
    });
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
      return reply.status(403).send({ success: false, error: 'Forbidden' });
    }

    const baseUrl = `${request.protocol}://${request.host}`;
    const labels = {
      noName: 'Без названия',
      editAccess: 'Доступ на редактирование',
      viewOnlyAccess: 'Доступ только для просмотра',
      validUntil: 'Ссылка действительна до',
      viewOnlyWarning: 'Эта ссылка открыта только для просмотра. Редактирование недоступно.',
      openWebEditor: 'Редактировать',
      openWebEditorDesc: 'Редактировать отчёт в браузере',
      downloadZip: 'Скачать ZIP',
      downloadZipDesc: 'Офлайн-копия отчёта',
      openHtmlTooltip: 'Открыть HTML',
      openHtmlDesc: 'Просмотреть отчёт в лёгкой версии',
    };
    const html = generateWelcomeHtml(share, report, baseUrl, labels);

    await shareService.logShareAccess({
      shareId: share.id,
      request,
      anonymousId,
      action: 'welcome_html_open',
    });

    return reply.type('text/html').send(html);
  } catch (error) {
    const status = error.statusCode || 500;
    return reply.status(status).send({
      success: false,
      error: status >= 500 ? 'Failed to generate welcome page' : error.message,
    });
  }
}

/**
 * GET /reports/shares/:token/zip
 * ZIP-архив отчёта (JSON + медиа + HTML) для офлайн-работы.
 */
async function downloadSharedReportZip(request, reply) {
  const { token } = request.params;
  const anonymousId = request.query.anonymous_id || null;

  try {
    const { share, report } = await shareService.getReportByShareToken(token);

    if (!shareService.canView(share)) {
      return reply.status(403).send({ success: false, error: 'Forbidden' });
    }

    const { buffer, fileName } = await zipService.generateReportZip(report);

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
