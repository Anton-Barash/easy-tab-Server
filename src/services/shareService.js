// ============================================================
// Share Service — временные публичные ссылки на отчёты.
//
// Позволяет автору отчёта создать share-ссылку с ограниченным
// сроком действия. По ссылке любой пользователь (в том числе
// анонимный) может открыть welcome-экран, отредактировать отчёт,
// посмотреть HTML или скачать ZIP.
// ============================================================

const { randomBytes } = require('crypto');
const db = require('./databaseService');
const reportsService = require('./reportsService');
const logger = require('../utils/logger');

// Длина токена share-ссылки в байтах (16 байт = 32 hex-символа).
const SHARE_TOKEN_BYTES = 16;

/**
 * Сгенерировать уникальный токен для share-ссылки.
 * @returns {string}
 */
function generateShareToken() {
  return randomBytes(SHARE_TOKEN_BYTES).toString('hex');
}

/**
 * Создать share-ссылку на отчёт.
 *
 * @param {object} params
 * @param {number} params.reportId - ID отчёта
 * @param {number} params.userId - ID создателя ссылки
 * @param {Date} [params.expiresAt] - срок действия (по умолчанию 7 дней)
 * @param {string} [params.permissions='edit'] - 'edit' | 'view'
 * @returns {Promise<object>} { id, reportId, token, expiresAt, permissions, url }
 * @throws {Error} 403 если userId не владелец отчёта, 404 если отчёт не найден
 */
async function createShare({
  reportId,
  userId,
  expiresAt,
  permissions = 'edit',
}) {
  // Проверяем, что пользователь — владелец отчёта.
  const reportResult = await db.query(
    'SELECT id FROM reports WHERE id = $1 AND creator_user_id = $2',
    [reportId, userId]
  );

  if (reportResult.rows.length === 0) {
    const err = new Error('Report not found or access denied');
    err.statusCode = 403;
    throw err;
  }

  const token = generateShareToken();
  const resolvedExpiresAt = expiresAt
    ? new Date(expiresAt)
    : new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

  const result = await db.query(
    `INSERT INTO report_shares (report_id, token, expires_at, permissions, created_by)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id, report_id, token, expires_at, permissions, created_at`,
    [reportId, token, resolvedExpiresAt, permissions, userId]
  );

  const row = result.rows[0];
  logger.info(`createShare: report=${reportId}, token=${token.substring(0, 8)}..., by=${userId}`);

  return {
    id: row.id,
    reportId: row.report_id,
    token: row.token,
    expiresAt: row.expires_at,
    permissions: row.permissions,
    createdAt: row.created_at,
  };
}

/**
 * Найти share-ссылку по токену и проверить, что она активна.
 *
 * @param {string} token
 * @returns {Promise<object>} { id, reportId, token, expiresAt, isActive, permissions }
 * @throws {Error} 404 если не найдена или истекла/отключена
 */
async function getShareByToken(token) {
  const result = await db.query(
    `SELECT id, report_id, token, expires_at, is_active, permissions
     FROM report_shares
     WHERE token = $1`,
    [token]
  );

  if (result.rows.length === 0) {
    const err = new Error('Share link not found');
    err.statusCode = 404;
    throw err;
  }

  const row = result.rows[0];

  if (!row.is_active) {
    const err = new Error('Share link has been revoked');
    err.statusCode = 410;
    throw err;
  }

  if (new Date(row.expires_at) < new Date()) {
    const err = new Error('Share link has expired');
    err.statusCode = 410;
    throw err;
  }

  return {
    id: row.id,
    reportId: row.report_id,
    token: row.token,
    expiresAt: row.expires_at,
    isActive: row.is_active,
    permissions: row.permissions,
  };
}

/**
 * Получить отчёт вместе с данными share-ссылки.
 *
 * @param {string} token
 * @returns {Promise<{share: object, report: object}>}
 */
async function getReportByShareToken(token) {
  const share = await getShareByToken(token);
  // skipAccessCheck = true — доступ уже проверен через валидный share-токен
  const report = await reportsService.getReportForView(share.reportId, null, { skipAccessCheck: true });
  return { share, report };
}

/**
 * Проверить, разрешает ли share-ссылка редактирование.
 * @param {object} share
 * @returns {boolean}
 */
function canEdit(share) {
  return share.permissions === 'edit';
}

/**
 * Проверить, разрешает ли share-ссылка просмотр.
 * @param {object} share
 * @returns {boolean}
 */
function canView(share) {
  return share.permissions === 'edit' || share.permissions === 'view';
}

/**
 * Записать событие доступа по share-ссылке.
 *
 * @param {object} params
 * @param {number} params.shareId - ID share-ссылки
 * @param {object} params.request - Fastify request
 * @param {string} [params.anonymousId] - anonymous_id из localStorage
 * @param {string} params.action - welcome_open, edit_open, html_open, zip_download, save
 * @returns {Promise<void>}
 */
async function logShareAccess({ shareId, request, anonymousId, action }) {
  const ip = request.ip || null;
  const userAgent = request.headers['user-agent'] || null;
  const userId = request.user?.userId || null;

  try {
    await db.query(
      `INSERT INTO report_share_logs
       (share_id, ip, user_agent, user_id, anonymous_id, action)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [shareId, ip, userAgent, userId, anonymousId || null, action]
    );
  } catch (err) {
    // Логирование не должно ломать основной запрос.
    logger.error(`logShareAccess failed: ${err.message}`);
  }
}

/**
 * Отозвать share-ссылку.
 *
 * @param {object} params
 * @param {string} params.token
 * @param {number} params.userId
 * @returns {Promise<boolean>}
 * @throws {Error} 403 если пользователь не владелец отчёта
 */
async function revokeShare({ token, userId }) {
  const result = await db.query(
    `UPDATE report_shares sh
     SET is_active = false
     FROM reports r
     WHERE sh.token = $1 AND sh.report_id = r.id AND r.creator_user_id = $2
     RETURNING sh.id`,
    [token, userId]
  );

  if (result.rows.length === 0) {
    const err = new Error('Share link not found or access denied');
    err.statusCode = 403;
    throw err;
  }

  logger.info(`revokeShare: token=${token.substring(0, 8)}..., by=${userId}`);
  return true;
}

/**
 * Список активных share-ссылок для отчёта.
 *
 * @param {number} reportId
 * @param {number} userId
 * @returns {Promise<Array<object>>}
 */
async function listSharesForReport(reportId, userId) {
  const reportResult = await db.query(
    'SELECT id FROM reports WHERE id = $1 AND creator_user_id = $2',
    [reportId, userId]
  );

  if (reportResult.rows.length === 0) {
    const err = new Error('Report not found or access denied');
    err.statusCode = 403;
    throw err;
  }

  const result = await db.query(
    `SELECT id, token, expires_at, is_active, permissions, created_at
     FROM report_shares
     WHERE report_id = $1
     ORDER BY created_at DESC`,
    [reportId]
  );

  return result.rows.map((row) => ({
    id: row.id,
    token: row.token,
    expiresAt: row.expires_at,
    isActive: row.is_active,
    permissions: row.permissions,
    createdAt: row.created_at,
  }));
}

module.exports = {
  createShare,
  getShareByToken,
  getReportByShareToken,
  canEdit,
  canView,
  logShareAccess,
  revokeShare,
  listSharesForReport,
};
