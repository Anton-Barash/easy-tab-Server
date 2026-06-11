function requestLogger(fastify) {
  fastify.addHook('onRequest', (request, reply, done) => {
    request.log.info({
      method: request.method,
      url: request.url,
      ip: request.ip,
    }, 'Incoming request');
    done();
  });

  fastify.addHook('onResponse', (request, reply, done) => {
    request.log.info({
      method: request.method,
      url: request.url,
      statusCode: reply.statusCode,
      responseTime: reply.elapsedTime,
    }, 'Request completed');
    done();
  });
}

module.exports = requestLogger;
