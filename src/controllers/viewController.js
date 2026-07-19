// ============================================================
// View Controller — обработчики HTTP-запросов к /view
//
// Эндпоинты:
//   GET /view/report/:id/files/*  — проксировать файлы из KS3 (фото, видео)
//
// Использование:
//   - HTML отчёт получается через /reports/:id/html (см. reportsController)
//   - Flutter отображает HTML в iframe (srcdoc) на localhost:4000
//   - Медиа в HTML имеет ссылки на /view/report/:id/files/...
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
const logger = require('../utils/logger');
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
 * GET /view/report/:id
 * Получить HTML отчёта для просмотра в браузере.
 *
 * Сервер скачивает report.json из KS3 и генерирует HTML
 * (без загрузки готового HTML с клиента).
 *
 * Пути к медиа сразу генерируются как proxy-пути:
 *   /view/report/:id/files/photos/f1.jpg
 */
async function viewReport(request, reply) {
  const { id } = request.params;
  const reportId = parseInt(id, 10);

  if (isNaN(reportId) || reportId < 1) {
    return reply.status(400).send({ success: false, error: 'Invalid report id' });
  }

  try {
    // Получаем userId из request.user (может быть null для анонимов)
    const userId = request.user?.userId || null;

    // Получаем отчёт с проверкой доступа
    const report = await reportsService.getReportForView(reportId, userId);

    // Проверяем, что есть ks3Folder
    if (!report.ks3Folder) {
      logger.warn(`viewReport: report ${reportId} has no ks3_folder`);
      return reply.status(404).send({ success: false, error: 'Report files not found' });
    }

    // Генерируем HTML из JSON (пути к медиа уже proxy, без токена в URL)
    // Авторизация для файлов осуществляется через cookies
    const html = await reportsService.getReportHtml(report.ks3Folder, reportId);

    logger.info(`viewReport: serving report ${reportId} (public=${report.isPublic})`);

    return reply.type('text/html').send(html);
  } catch (error) {
    const status = error.statusCode || 500;
    logger.error(`viewReport: error ${status} for report ${reportId}: ${error.message}`);
    return reply.status(status).send({
      success: false,
      error: status >= 500 ? 'Failed to load report' : error.message,
    });
  }
}

/**
 * GET /view/report/:id/files/*
 * Получить файл из отчёта (изображения, видео и т.д.).
 *
 * Защита:
 *   1. Проверка доступа (публичный/приватный) через getReportForView
 *   2. Path traversal: нормализуем путь, запрещаем .. и абсолютные пути
 *   3. Файл берётся ТОЛЬКО из папки этого отчёта (ks3Folder + relativePath)
 *      — нельзя получить файлы из другого отчёта
 */
async function viewReportFile(request, reply) {
  // CORS и CORP заголовки для кросс-оригинных запросов из iframe
  // Добавляем в начало, чтобы возвращались даже при ошибках
  // 
  // about:srcdoc - origin для iframe с srcdoc (используется в Flutter Web)
  // localhost:* - для разработки
  // production - frontend и backend на одном домене
  // null origin - iframe может не отправлять Origin header
  // 
  // Важно: Credentials не нужны, так как авторизация через token в URL query.
  const origin = request.headers.origin;
  const isLocalhost = origin && /^https?:\/\/localhost(:\d+)?$/.test(origin);
  const isSrcdoc = origin === 'about:srcdoc';
  const isNullOrigin = origin === null || origin === undefined;
  
  if (isLocalhost || isSrcdoc || isNullOrigin) {
    reply.header('Access-Control-Allow-Origin', '*');
    reply.header('Cross-Origin-Resource-Policy', 'cross-origin');
    reply.header('Cross-Origin-Embedder-Policy', 'unsafe-none');
    reply.header('Access-Control-Expose-Headers', 'Cross-Origin-Resource-Policy, Cross-Origin-Embedder-Policy');
  }

  const { id } = request.params;
  const reportId = parseInt(id, 10);

  if (isNaN(reportId) || reportId < 1) {
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
    logger.warn(`viewReportFile: path traversal attempt for report ${reportId}: ${relativePath}`);
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
    logger.warn(`viewReportFile: blocked extension "${ext}" for report ${reportId}: ${relativePath}`);
    return reply.status(403).send({ success: false, error: 'File type not allowed' });
  }

  try {
    const userId = request.user?.userId || null;
    const report = await reportsService.getReportForView(reportId, userId);

    if (!report.ks3Folder) {
      logger.warn(`viewReportFile: report ${reportId} has no ks3_folder`);
      return reply.status(404).send({ success: false, error: 'Report files not found' });
    }

    // Получаем файл из KS3 (только из папки этого отчёта)
    const file = await reportsService.getReportFile(report.ks3Folder, normalizedPath);

    // Кэшируем на 1 час (файлы отчётов редко меняются)
    reply.header('Cache-Control', 'public, max-age=3600');

    logger.debug(`viewReportFile: serving ${normalizedPath} for report ${reportId}`);

    return reply.type(file.contentType).send(file.data);
  } catch (error) {
    const status = error.statusCode || 500;
    logger.error(`viewReportFile: error ${status} for report ${reportId}, file ${relativePath}: ${error.message}`);
    return reply.status(status).send({
      success: false,
      error: status >= 500 ? 'Failed to load file' : error.message,
    });
  }
}

async function viewReportThumbnail(request, reply) {
  const origin = request.headers.origin;
  const isLocalhost = origin && /^https?:\/\/localhost(:\d+)?$/.test(origin);
  const isSrcdoc = origin === 'about:srcdoc';
  const isNullOrigin = origin === null || origin === undefined;
  
  if (isLocalhost || isSrcdoc || isNullOrigin) {
    reply.header('Access-Control-Allow-Origin', '*');
    reply.header('Cross-Origin-Resource-Policy', 'cross-origin');
    reply.header('Cross-Origin-Embedder-Policy', 'unsafe-none');
    reply.header('Access-Control-Expose-Headers', 'Cross-Origin-Resource-Policy, Cross-Origin-Embedder-Policy');
  }

  const { id } = request.params;
  const reportId = parseInt(id, 10);

  if (isNaN(reportId) || reportId < 1) {
    return reply.status(400).send({ success: false, error: 'Invalid report id' });
  }

  const relativePath = request.params['*'];

  if (!relativePath) {
    return reply.status(400).send({ success: false, error: 'File path is required' });
  }

  const normalizedPath = normalizeKs3Path(relativePath);
  if (relativePath.includes('..') || normalizedPath.includes('..') || path.posix.isAbsolute(normalizedPath)) {
    logger.warn(`viewReportThumbnail: path traversal attempt for report ${reportId}: ${relativePath}`);
    return reply.status(400).send({ success: false, error: 'Invalid file path' });
  }

  const ext = normalizedPath.split('.').pop().toLowerCase();
  const allowedExtensions = [
    'jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp',
  ];
  if (!allowedExtensions.includes(ext)) {
    logger.warn(`viewReportThumbnail: blocked extension "${ext}" for report ${reportId}: ${relativePath}`);
    return reply.status(403).send({ success: false, error: 'File type not allowed' });
  }

  try {
    const userId = request.user?.userId || null;
    const report = await reportsService.getReportForView(reportId, userId);

    if (!report.ks3Folder) {
      logger.warn(`viewReportThumbnail: report ${reportId} has no ks3_folder`);
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
    logger.debug(`viewReportThumbnail: serving ${normalizedPath} for report ${reportId}`);

    return reply.type(file.contentType).send(file.data);
  } catch (error) {
    const status = error.statusCode || 500;
    logger.error(`viewReportThumbnail: error ${status} for report ${reportId}, file ${relativePath}: ${error.message}`);
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
