// Database Service - PostgreSQL connection and queries

const { Pool } = require('pg');
const dbConfig = require('../config/database');
const logger = require('../utils/logger');

// Create PostgreSQL connection pool
const pool = new Pool(dbConfig);

// Log connection events
// P3-60: debug вместо info — при каждом новом клиенте в пуле (до 20 шт.)
// info-лог создаёт лишний шум без полезной информации.
pool.on('connect', (client) => {
  logger.debug('New PostgreSQL client connected');
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
    // M-26: логируем только длительность и укороченный шаблон запроса (без параметров)
    // на уровне debug, чтобы не засорять prod-логи и не утекали данные/схема.
    const preview = typeof text === 'string' ? text.slice(0, 80) : String(text);
    logger.debug({ duration, preview, paramsCount: Array.isArray(params) ? params.length : 0 }, 'Query executed');
    return result;
  } catch (error) {
    // M-26: не логируем параметры и полный текст запроса в error-лог.
    logger.error({ err: error.message }, 'Query error');
    throw error;
  }
}

/**
 * Check database connection
 * @returns {Promise<boolean>}
 */
async function checkConnection() {
  try {
    const result = await query('SELECT NOW()');
    logger.info('Database connection successful');
    // P0-52: конфигурация БД не должна покидать сервисный слой.
    // Возвращаем только статус подключения и время.
    return {
      connected: true,
      timestamp: result.rows[0].now,
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
  checkConnection,
  getVersion,
  listTables,
  closePool,
  // pool используется migrationRunner'ом (pool.connect() для транзакций миграций).
  pool,
};