// P3-49: Логируем только path-часть URL без query string.
// Query string может содержать чувствительные данные (токены, параметры поиска)
// и засоряет логи. Полный URL доступен в request.raw.url при необходимости.
function safeUrl(url) {
  if (!url) return url;
  const qIdx = url.indexOf('?');
  return qIdx === -1 ? url : url.slice(0, qIdx);
}

function requestLogger(fastify) {
  fastify.addHook('onRequest', (request, reply, done) => {
    request.log.info({
      method: request.method,
      url: safeUrl(request.url),
      ip: request.ip,
    }, 'Incoming request');
    done();
  });

  fastify.addHook('onResponse', (request, reply, done) => {
    request.log.info({
      method: request.method,
      url: safeUrl(request.url),
      statusCode: reply.statusCode,
      responseTime: reply.elapsedTime,
    }, 'Request completed');
    done();
  });
}

module.exports = requestLogger;
