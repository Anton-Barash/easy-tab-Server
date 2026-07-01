const healthRoutes = require('./health');
const filesRoutes = require('./files');
const databaseRoutes = require('./database');

async function registerRoutes(fastify) {
  // Health check
  fastify.register(healthRoutes, { prefix: '/health' });

  // Files API
  fastify.register(filesRoutes, { prefix: '/files' });

  // Database API
  fastify.register(databaseRoutes, { prefix: '/database' });
}

module.exports = registerRoutes;
