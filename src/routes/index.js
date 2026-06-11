const healthRoutes = require('./health');
const filesRoutes = require('./files');

async function registerRoutes(fastify) {
  // Health check
  fastify.register(healthRoutes, { prefix: '/health' });

  // Files API
  fastify.register(filesRoutes, { prefix: '/files' });
}

module.exports = registerRoutes;
