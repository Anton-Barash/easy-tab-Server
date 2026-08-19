const path = require('path');
const config = require('../config');

function getUploadsDir() {
  return config.uploadsDir;
}

function getLogsDir() {
  return config.logsDir;
}

function getFilePath(filename) {
  // Предотвращаем path traversal
  const safeName = path.basename(filename);
  return path.join(getUploadsDir(), safeName);
}

/**
 * Определяет базовый URL сервера с правильным протоколом.
 *
 * НЕ используем request.protocol (Fastify почти всегда 'http') и
 * НЕ доверяем X-Forwarded-Proto (может быть подделан клиентом, если
 * сервер стоит напрямую без балансировщика).
 *
 * Протокол определяем по реальному TLS-соединению: socket.encrypted.
 * Если сервер запущен на чистом HTTP (текущий продакшен), возвращаем http://.
 *
 * @param {import('fastify').FastifyRequest} request
 * @returns {string} вида 'http://host:port' или 'https://host:port'
 */
function getBaseUrl(request) {
  const socket = request.raw?.socket || request.socket;
  const encrypted = socket?.encrypted === true;
  const protocol = encrypted ? 'https' : 'http';
  // request.host в Fastify уже включает порт, если он нестандартный.
  const host = request.host || 'localhost';
  return `${protocol}://${host}`;
}

module.exports = {
  getUploadsDir,
  getLogsDir,
  getFilePath,
  getBaseUrl,
};
