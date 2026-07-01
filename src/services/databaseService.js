// Database Service - PostgreSQL connection and queries

const { Pool } = require('pg');
const dbConfig = require('../config/database');
const logger = require('../utils/logger');

// Create PostgreSQL connection pool
const pool = new Pool(dbConfig);

// Log connection events
pool.on('connect', (client) => {
  logger.info('New PostgreSQL client connected');
});

pool.on('error', (err, client) => {
  logger.error(`PostgreSQL pool error: ${err.message}`);
});

/**
 * Execute a query
 * @param {string} text - SQL query
 * @param {array} params - Query parameters
 * @returns {Promise<object>}
 */
async function query(text, params) {
  const start = Date.now();
  try {
    const result = await pool.query(text, params);
    const duration = Date.now() - start;
    logger.info(`Query executed in ${duration}ms: ${text}`);
    return result;
  } catch (error) {
    logger.error(`Query error: ${error.message}`);
    throw error;
  }
}

/**
 * Get a client from the pool for transaction
 * @returns {Promise<object>}
 */
async function getClient() {
  const client = await pool.connect();
  return client;
}

/**
 * Check database connection
 * @returns {Promise<boolean>}
 */
async function checkConnection() {
  try {
    const result = await query('SELECT NOW()');
    logger.info('Database connection successful');
    return {
      connected: true,
      timestamp: result.rows[0].now,
      config: {
        host: dbConfig.host,
        port: dbConfig.port,
        database: dbConfig.database,
        user: dbConfig.user,
      },
    };
  } catch (error) {
    logger.error(`Database connection failed: ${error.message}`);
    return {
      connected: false,
      error: error.message,
    };
  }
}

/**
 * Get database version
 * @returns {Promise<string>}
 */
async function getVersion() {
  try {
    const result = await query('SELECT version()');
    return result.rows[0].version;
  } catch (error) {
    logger.error(`Failed to get version: ${error.message}`);
    throw error;
  }
}

/**
 * List all tables in the database
 * @returns {Promise<array>}
 */
async function listTables() {
  try {
    const result = await query(`
      SELECT table_name 
      FROM information_schema.tables 
      WHERE table_schema = 'public'
      ORDER BY table_name
    `);
    return result.rows;
  } catch (error) {
    logger.error(`Failed to list tables: ${error.message}`);
    throw error;
  }
}

/**
 * Close all connections in the pool
 * @returns {Promise<void>}
 */
async function closePool() {
  try {
    await pool.end();
    logger.info('PostgreSQL pool closed');
  } catch (error) {
    logger.error(`Failed to close pool: ${error.message}`);
    throw error;
  }
}

module.exports = {
  query,
  getClient,
  checkConnection,
  getVersion,
  listTables,
  closePool,
  pool,
};