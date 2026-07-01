// Database Routes - endpoints for database operations

const databaseController = require('../controllers/databaseController');

async function databaseRoutes(fastify) {
  // Check database connection
  fastify.get('/check', databaseController.checkConnection);

  // Get database version
  fastify.get('/version', databaseController.getVersion);

  // List all tables
  fastify.get('/tables', databaseController.listTables);
}

module.exports = databaseRoutes;