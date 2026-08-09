// ============================================================
// ZIP Service — генерация офлайн-архива отчёта.
//
// Архив содержит:
//   - report.json       — полные данные отчёта
//   - index.html        — HTML-версия для просмотра без сервера
//   - photos/<files>    — фото и видео отчёта (как в локальной папке)
//
// HTML использует относительные пути к медиа, поэтому архив
// можно открыть локально в браузере.
// ============================================================

const archiver = require('archiver');
const db = require('./databaseService');
const ks3 = require('./s3Storage');
const htmlGenerator = require('./htmlGenerator');
const logger = require('../utils/logger');

/**
 * Сгенерировать ZIP-архив отчёта.
 *
 * @param {object} report - объект отчёта из reportsService.getReportForView
 * @returns {Promise<{buffer: Buffer, fileName: string}>}
 */
async function generateReportZip(report) {
  const reportData = report.reportData;
  if (!reportData) {
    const err = new Error('Report has no data');
    err.statusCode = 400;
    throw err;
  }

  // Получаем все файлы отчёта из БД.
  const filesResult = await db.query(
    `SELECT id, storage_key, relative_path, mime_type
     FROM files
     WHERE report_id = $1`,
    [report.id]
  );
  const files = filesResult.rows;

  // Для offline-режима считаем, что медиа доступны, если они есть в БД.
  const mediaUrls = {};
  for (const file of files) {
    mediaUrls[file.relative_path] = { full: true, thumb: true };
  }

  // Генерируем HTML с относительными путями к медиа.
  // В ZIP медиа лежат в том же пути, что и в локальной папке отчёта
  // (например, photos/f1.jpg), поэтому offlineBasePath пустой.
  const html = htmlGenerator.generateReportHtml(
    reportData,
    report.publicId,
    null, // token
    null, // baseUrl
    mediaUrls,
    report.ks3Folder,
    '' // offlineBasePath
  );

  return new Promise((resolve, reject) => {
    const archive = new archiver.ZipArchive({ zlib: { level: 6 } });
    const chunks = [];

    archive.on('data', (chunk) => chunks.push(chunk));
    archive.on('end', () => {
      const buffer = Buffer.concat(chunks);
      const reportName = reportData.reportName || report.title || 'report';
      const safeTitle = reportName
        .replace(/[^a-zA-Z0-9а-яА-ЯёЁ\-_ ]/g, '')
        .replace(/\s+/g, '_')
        .substring(0, 80);
      const fileName = `${safeTitle}_${report.publicId}.zip`;
      resolve({ buffer, fileName });
    });
    archive.on('warning', (warn) => logger.warn(`ZIP warning: ${warn.message}`));
    archive.on('error', (err) => reject(err));

    // JSON отчёта.
    archive.append(Buffer.from(JSON.stringify(reportData, null, 2), 'utf-8'), {
      name: 'report.json',
    });

    // HTML для просмотра.
    archive.append(Buffer.from(html, 'utf-8'), {
      name: 'index.html',
    });

    // Медиа-файлы из KS3.
    const mediaPromises = files.map(async (file) => {
      try {
        const fileData = await ks3.getFile(file.storage_key);
        // Сохраняем тот же относительный путь, что и в локальной папке
        // (например, photos/f1.jpg или X/f2.jpg).
        const name = (file.relative_path || '').replace(/^\//, '');
        archive.append(fileData.data, { name });
      } catch (err) {
        // Не прерываем архив из-за одного недоступного файла.
        logger.error(`ZIP: failed to add ${file.storage_key}: ${err.message}`);
      }
    });

    Promise.all(mediaPromises)
      .then(() => archive.finalize())
      .catch(reject);
  });
}

module.exports = {
  generateReportZip,
};
