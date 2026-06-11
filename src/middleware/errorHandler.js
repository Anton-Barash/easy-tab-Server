function errorHandler(fastify) {
  fastify.setErrorHandler((error, request, reply) => {
    const statusCode = error.statusCode || 500;

    request.log.error({
      error: {
        message: error.message,
        stack: error.stack,
      },
      request: {
        method: request.method,
        url: request.url,
      },
    });

    reply.status(statusCode).send({
      error: {
        message: statusCode === 500 ? 'Internal Server Error' : error.message,
        statusCode,
      },
    });
  });
}

module.exports = errorHandler;
