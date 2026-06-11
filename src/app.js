const fastify = require('fastify');
const multipart = require('@fastify/multipart');
const config = require('./config');
const errorHandler = require('./middleware/errorHandler');
const requestLogger = require('./middleware/requestLogger');
const registerRoutes = require('./routes');

function buildApp() {
  const app = fastify({
    logger: config.logger,
  });

  // Регистрация middleware
  errorHandler(app);
  requestLogger(app);

  // Регистрация plugins
  app.register(multipart, {
    limits: {
      fileSize: config.maxFileSize,
    },
  });

  // Регистрация routes
  app.register(registerRoutes);

  return app;
}

module.exports = buildApp;
