// ============================================================
// httpRedirectServer — HTTP→HTTPS редирект (301 Moved Permanently).
//
// Поднимается ОТДЕЛЬНЫМ plain-HTTP сервером на отдельном порту (обычно 80)
// только когда включён TLS (HTTPS-сервер на 443). Любой запрос на HTTP
// перенаправляется на HTTPS с сохранением пути, query и хэша.
//
// Зачем отдельный сервер: Fastify-приложение в TLS-режиме слушает 443 и не
// может одновременно слушать 80. Поэтому редирект живёт в лёгком node:http.
//
// Назначение порта: config.tlsRedirectPort (env TLS_REDIRECT_PORT).
// ============================================================

const http = require('http');

/**
 * Поднимает HTTP-сервер, который редиректит всё на https://host[:httpsPort]...
 *
 * @param {Object} opts
 * @param {number} opts.port       — порт, на котором слушаем HTTP (напр. 80)
 * @param {number} opts.httpsPort  — порт HTTPS-приложения (напр. 443)
 * @param {string} opts.host       — bind-адрес (обычно '0.0.0.0')
 * @param {string} opts.httpsHost  — публичный host для Location (напр. 'easytab.cloud')
 * @returns {Promise<http.Server>}
 */
function startHttpToHttpsRedirect({ port, httpsPort, host, httpsHost }) {
  const server = http.createServer((req, res) => {
    // Переназначаем на HTTPS. Query и хэш сохраняем.
    const location = `https://${httpsHost}${httpsPort === 443 ? '' : `:${httpsPort}`}${req.url}`;
    res.writeHead(301, {
      location,
      'Cache-Control': 'no-store',
    });
    res.end();
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      console.log(`HTTP→HTTPS redirect listening on ${host}:${port} → https://${httpsHost}`);
      resolve(server);
    });
  });
}

module.exports = { startHttpToHttpsRedirect };