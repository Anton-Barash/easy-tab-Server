// P3-49: Логируем только path-часть URL без query string
// (query string может содержать чувствительные данные).
function safeUrl(url) {
  if (!url) return url;
  const qIdx = url.indexOf('?');
  return qIdx === -1 ? url : url.slice(0, qIdx);
}

function errorHandler(fastify) {
  fastify.setErrorHandler((error, request, reply) => {
    const statusCode = error.statusCode || 500;
    const isServerError = statusCode >= 500;

    // L-102: stack trace только для 5xx — 4xx засоряют логи.
    const logPayload = {
      error: {
        message: error.message,
      },
      request: {
        method: request.method,
        url: safeUrl(request.url),
      },
    };
    if (isServerError) {
      logPayload.error.stack = error.stack;
      request.log.error(logPayload);
    } else {
      request.log.warn(logPayload);
    }

    // M-27: для 5xx не раскрываем детали ошибки клиенту.
    // Для 4xx error.message обычно безопасен (404, 401, 403 и т.д.).
    reply.status(statusCode).send({
      error: {
        message: isServerError ? 'Internal Server Error' : error.message,
        statusCode,
      },
    });
  });
}

module.exports = errorHandler;
