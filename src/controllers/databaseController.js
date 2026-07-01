// Database Controller - handles database-related requests

const databaseService = require('../services/databaseService');

/**
 * Check database connection status
 */
async function checkConnection(request, reply) {
  try {
    const result = await databaseService.checkConnection();
    
    if (result.connected) {
      return reply.send({
        success: true,
        message: 'Database connection successful',
        timestamp: result.timestamp,
        config: result.config,
      });
    } else {
      return reply.status(503).send({
        success: false,
        message: 'Database connection failed',
        error: result.error,
      });
    }
  } catch (error) {
    request.log.error(error);
    return reply.status(500).send({
      success: false,
      error: error.message,
    });
  }
}

/**
 * Get database version
 */
async function getVersion(request, reply) {
  try {
    const version = await databaseService.getVersion();
    return reply.send({
      success: true,
      version,
    });
  } catch (error) {
    request.log.error(error);
    return reply.status(500).send({
      success: false,
      error: error.message,
    });
  }
}

/**
 * List all tables
 */
async function listTables(request, reply) {
  try {
    const tables = await databaseService.listTables();
    return reply.send({
      success: true,
      count: tables.length,
      tables,
    });
  } catch (error) {
    request.log.error(error);
    return reply.status(500).send({
      success: false,
      error: error.message,
    });
  }
}

module.exports = {
  checkConnection,
  getVersion,
  listTables,
};