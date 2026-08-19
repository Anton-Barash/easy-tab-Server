// ============================================================
// View Controller — обработчики HTTP-запросов к /view
//
// Эндпоинты:
//   GET /view/report/:publicId/files/*  — проксировать файлы из KS3 (фото, видео)
//
// Использование:
//   - HTML отчёт получается через /reports/:publicId/html (см. reportsController)
//   - Flutter отображает HTML в iframe (srcdoc) на localhost:4000
//   - Медиа в HTML имеет ссылки на /view/report/:publicId/files/...
//   - Браузер загружает медиа через этот прокси
//
// Авторизация:
//   - Если отчёт публичный (is_public = true) — доступен всем
//   - Если приватный — требуется cookie auth_token (устанавливается при логине)
//   - Поддерживается также Bearer token и query параметр ?token=
//
// Безопасность файлов:
//   - Файл доступен только из папки конкретного отчёта (ks3Folder)
//   - Path traversal защита (запрет .. и абсолютных путей)
//   - KS3-ключи не раскрываются клиенту
// ============================================================

const reportsService = require('../services/reportsService');
const shareService = require('../services/shareService');
const { extractToken } = require('../middleware/authMiddleware');
const logger = require('../utils/logger');
const { getBaseUrl } = require('../utils/pathHelper');
const path = require('path');

/**
 * Нормализует путь для KS3: использует POSIX-стиль (прямые слеши),
 * даже если сервер работает на Windows (где path.normalize использует \).
 */
function normalizeKs3Path(p) {
  const normalized = path.posix.normalize(p);
  return normalized;
}

/**
 * GET /view/report/:publicId
 * Получить HTML отчёта для просмотра в браузере.
 *
 * Сервер читает JSON-данные отчёта из БД, генерирует presigned URL
 * для медиафайлов и строит HTML (без загрузки готового HTML с клиента).
 */
async function viewReport(request, reply) {
  // CORS и CORP заголовки для кросс-оригинных запросов из iframe.
  reply.header('Access-Control-Allow-Origin', '*');
  reply.header('Cross-Origin-Resource-Policy', 'cross-origin');
  reply.header('Cross-Origin-Embedder-Policy', 'unsafe-none');
  reply.header('Access-Control-Expose-Headers', 'Cross-Origin-Resource-Policy, Cross-Origin-Embedder-Policy');
  reply.header('Vary', 'Origin');

  const { publicId } = request.params;

  if (!publicId || publicId.length < 6) {
    return reply.status(400).send({ success: false, error: 'Invalid report id' });
  }

  try {
    // Получаем userId из request.user (может быть null для анонимов)
    const userId = request.user?.userId || null;

    // Получаем отчёт с проверкой доступа (включает report_data)
    const report = await reportsService.getReportForViewByPublicId(publicId, userId);

    // Токен и baseUrl для proxy-ссылок на медиа (для приватных отчётов).
    // Используем getBaseUrl — определяет протокол по socket.encrypted,
    // а не по request.protocol/X-Forwarded-Proto. На чистом HTTP-сервере
    // возвращает http:// — избегает mixed content и ERR_SSL_PROTOCOL_ERROR.
    const token = extractToken(request);
    const baseUrl = getBaseUrl(request);

    // Генерируем HTML из JSON БД с proxy URL для медиа
    const html = await reportsService.getReportHtml(report, token, baseUrl);

    logger.info(`viewReport: serving report ${report.publicId} (public=${report.isPublic})`);

    return reply.type('text/html').send(html);
  } catch (error) {
    const status = error.statusCode || 500;
    logger.error(`viewReport: error ${status} for report ${publicId}: ${error.message}`);
    return reply.status(status).send({
      success: false,
      error: status >= 500 ? 'Failed to load report' : error.message,
    });
  }
}

/**
 * GET /view/report/:publicId/files/*
 * Получить файл из отчёта (изображения, видео и т.д.).
 *
 * Защита:
 *   1. Проверка доступа (публичный/приватный) через getReportForView
 *   2. Path traversal: нормализуем путь, запрещаем .. и абсолютные пути
 *   3. Файл берётся ТОЛЬКО из папки этого отчёта (ks3Folder + relativePath)
 *      — нельзя получить файлы из другого отчёта
 */
async function viewReportFile(request, reply) {
  // CORS и CORP заголовки для кросс-оригинных запросов из iframe.
  // Возвращаем всегда: отчётные медиа могут встраиваться с любого origin
  // (авторизация идёт через token в URL query, credentials не используются).
  // Cross-Origin-Resource-Policy: cross-origin обязателен при
  // Cross-Origin-Embedder-Policy: require-corp на странице-родителе.
  reply.header('Access-Control-Allow-Origin', '*');
  reply.header('Cross-Origin-Resource-Policy', 'cross-origin');
  reply.header('Cross-Origin-Embedder-Policy', 'unsafe-none');
  reply.header('Access-Control-Expose-Headers', 'Cross-Origin-Resource-Policy, Cross-Origin-Embedder-Policy');
  reply.header('Vary', 'Origin');

  const { publicId } = request.params;

  if (!publicId || publicId.length < 6) {
    return reply.status(400).send({ success: false, error: 'Invalid report id' });
  }

  // Получаем относительный путь файла (всё после /files/)
  const relativePath = request.params['*'];

  if (!relativePath) {
    return reply.status(400).send({ success: false, error: 'File path is required' });
  }

  // Защита от path traversal:
  // - path.posix.normalize схлопывает ../ и использует прямые слеши (для KS3)
  // - проверяем, что нет .. в исходном пути
  // - проверяем, что путь не абсолютный
  const normalizedPath = normalizeKs3Path(relativePath);
  if (relativePath.includes('..') || normalizedPath.includes('..') || path.posix.isAbsolute(normalizedPath)) {
    logger.warn(`viewReportFile: path traversal attempt for report ${publicId}: ${relativePath}`);
    return reply.status(400).send({ success: false, error: 'Invalid file path' });
  }

  // Дополнительная защита: разрешаем только определённые расширения
  // (предотвращает доступ к report.json и другим служебным файлам)
  const ext = normalizedPath.split('.').pop().toLowerCase();
  const allowedExtensions = [
    'jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp',
    'mp4', 'webm', 'mov', 'avi',
    'css', 'js',
  ];
  if (!allowedExtensions.includes(ext)) {
    logger.warn(`viewReportFile: blocked extension "${ext}" for report ${publicId}: ${relativePath}`);
    return reply.status(403).send({ success: false, error: 'File type not allowed' });
  }

  try {
    const userId = request.user?.userId || null;
    const shareToken = request.query.share_token;

    // Если есть share-токен — валидируем и получаем объект share.
    // КРИТИЧНО (#1 IDOR): сам по себе валидный токен НЕ даёт доступ —
    // нужна дополнительная проверка привязки share к отчёту (см. ниже).
    const share = shareToken
      ? await shareService.getShareByToken(shareToken)
      : null;
    const shareCanView = share != null && shareService.canView(share);

    const report = await reportsService.getReportForViewByPublicId(
      publicId, userId, { skipAccessCheck: shareCanView }
    );

    // Привязка токена к отчёту: share.reportId должен совпадать с
    // запрошенным отчётом, иначе токен от отчёта A открывал бы отчёт B.
    if (shareToken && !(shareCanView && share.reportId === report.id)) {
      logger.warn(`viewReportFile: share-token report mismatch for report ${publicId}`);
      return reply.status(403).send({ success: false, error: 'Forbidden' });
    }

    if (!report.ks3Folder) {
      logger.warn(`viewReportFile: report ${report.publicId} has no ks3_folder`);
      return reply.status(404).send({ success: false, error: 'Report files not found' });
    }

    // Поддержка HTTP Range для потокового воспроизведения видео.
    const range = request.headers.range;
    if (range) {
      const file = await reportsService.getReportFileStream(report.ks3Folder, normalizedPath, range);
      reply.status(file.status);
      reply.header('Accept-Ranges', file.headers.acceptRanges || 'bytes');
      if (file.headers.contentLength) {
        reply.header('Content-Length', file.headers.contentLength);
      }
      if (file.headers.contentRange) {
        reply.header('Content-Range', file.headers.contentRange);
      }
      reply.header('Cache-Control', 'public, max-age=3600');
      logger.info(`viewReportFile: streaming ${normalizedPath} range=${range} for report ${report.publicId}`);
      return reply.type(file.headers.contentType).send(file.stream);
    }

    // Получаем файл из KS3 (только из папки этого отчёта)
    const file = await reportsService.getReportFile(report.ks3Folder, normalizedPath);

    // Кэшируем на 1 час (файлы отчётов редко меняются)
    reply.header('Cache-Control', 'public, max-age=3600');
    reply.header('Accept-Ranges', 'bytes');

    logger.debug(`viewReportFile: serving ${normalizedPath} for report ${report.publicId}`);

    return reply.type(file.contentType).send(file.data);
  } catch (error) {
    const status = error.statusCode || 500;
    logger.error(`viewReportFile: error ${status} for report ${publicId}, file ${relativePath}: ${error.message}`);
    return reply.status(status).send({
      success: false,
      error: status >= 500 ? 'Failed to load file' : error.message,
    });
  }
}

async function viewReportThumbnail(request, reply) {
  reply.header('Access-Control-Allow-Origin', '*');
  reply.header('Cross-Origin-Resource-Policy', 'cross-origin');
  reply.header('Cross-Origin-Embedder-Policy', 'unsafe-none');
  reply.header('Access-Control-Expose-Headers', 'Cross-Origin-Resource-Policy, Cross-Origin-Embedder-Policy');
  reply.header('Vary', 'Origin');

  const { publicId } = request.params;

  if (!publicId || publicId.length < 6) {
    return reply.status(400).send({ success: false, error: 'Invalid report id' });
  }

  const relativePath = request.params['*'];

  if (!relativePath) {
    return reply.status(400).send({ success: false, error: 'File path is required' });
  }

  const normalizedPath = normalizeKs3Path(relativePath);
  if (relativePath.includes('..') || normalizedPath.includes('..') || path.posix.isAbsolute(normalizedPath)) {
    logger.warn(`viewReportThumbnail: path traversal attempt for report ${publicId}: ${relativePath}`);
    return reply.status(400).send({ success: false, error: 'Invalid file path' });
  }

  const ext = normalizedPath.split('.').pop().toLowerCase();
  const allowedExtensions = [
    'jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp',
  ];
  if (!allowedExtensions.includes(ext)) {
    logger.warn(`viewReportThumbnail: blocked extension "${ext}" for report ${publicId}: ${relativePath}`);
    return reply.status(403).send({ success: false, error: 'File type not allowed' });
  }

  try {
    const userId = request.user?.userId || null;
    const shareToken = request.query.share_token;

    // КРИТИЧНО (#1 IDOR): валидируем share-токен и проверяем привязку к отчёту.
    const share = shareToken
      ? await shareService.getShareByToken(shareToken)
      : null;
    const shareCanView = share != null && shareService.canView(share);

    const report = await reportsService.getReportForViewByPublicId(
      publicId, userId, { skipAccessCheck: shareCanView }
    );

    // Привязка токена к отчёту (share.reportId === report.id).
    if (shareToken && !(shareCanView && share.reportId === report.id)) {
      logger.warn(`viewReportThumbnail: share-token report mismatch for report ${publicId}`);
      return reply.status(403).send({ success: false, error: 'Forbidden' });
    }

    if (!report.ks3Folder) {
      logger.warn(`viewReportThumbnail: report ${publicId} has no ks3_folder`);
      return reply.status(404).send({ success: false, error: 'Report files not found' });
    }

    const thumbnailService = require('../services/thumbnailService');
    const thumbnailKey = thumbnailService.getThumbnailStorageKey(`${report.ks3Folder}${normalizedPath}`);
    const file = await reportsService.getReportFileByKey(thumbnailKey);

    if (!file) {
      const originalKey = `${report.ks3Folder}${normalizedPath}`;
      const originalFile = await reportsService.getReportFileByKey(originalKey);
      if (!originalFile) {
        return reply.status(404).send({ success: false, error: 'Thumbnail not found' });
      }
      
      const thumbBuffer = await thumbnailService.generateThumbnail(originalFile.data);
      await reportsService.saveReportFile(thumbnailKey, thumbBuffer, 'image/jpeg');
      
      reply.header('Cache-Control', 'public, max-age=3600');
      return reply.type('image/jpeg').send(thumbBuffer);
    }

    reply.header('Cache-Control', 'public, max-age=3600');
    logger.debug(`viewReportThumbnail: serving ${normalizedPath} for report ${publicId}`);

    return reply.type(file.contentType).send(file.data);
  } catch (error) {
    const status = error.statusCode || 500;
    logger.error(`viewReportThumbnail: error ${status} for report ${publicId}, file ${relativePath}: ${error.message}`);
    return reply.status(status).send({
      success: false,
      error: status >= 500 ? 'Failed to load thumbnail' : error.message,
    });
  }
}

module.exports = {
  viewReport,
  viewReportFile,
  viewReportThumbnail,
};
