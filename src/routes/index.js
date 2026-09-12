const healthRoutes = require('./health');
const filesRoutes = require('./files');
const databaseRoutes = require('./database');
const authRoutes = require('./auth');
const reportsRoutes = require('./reports');
const wellKnownRoutes = require('./wellKnown');

async function registerRoutes(fastify) {
  // Health check
  fastify.register(healthRoutes, { prefix: '/health' });

  // Auth API
  fastify.register(authRoutes, { prefix: '/auth' });

  // Files API (KS3 storage)
  fastify.register(filesRoutes, { prefix: '/files' });

  // Reports API (web-сохранение отчётов)
  fastify.register(reportsRoutes, { prefix: '/reports' });

  // Database API
  fastify.register(databaseRoutes, { prefix: '/database' });

  // Deep-link verification: /.well-known/assetlinks.json и
  // /.well-known/apple-app-site-association (регистрируются до @fastify/static).
  fastify.register(wellKnownRoutes);
}

module.exports = registerRoutes;
