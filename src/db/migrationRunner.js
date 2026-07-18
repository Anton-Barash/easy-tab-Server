// Database Migration Runner

const fs = require('fs');
const path = require('path');
const logger = require('../utils/logger');
const { pool } = require('../services/databaseService');

const MIGRATIONS_DIR = path.join(__dirname, 'migrations');

// C-35: Фиксированный ключ для pg_advisory_lock — предотвращает гонку
// миграций в cluster mode (PM2 запускает несколько инстансов одновременно).
const MIGRATION_LOCK_KEY = 73318345;

/**
 * Убирает операторы BEGIN/COMMIT из SQL-файла миграции.
 * C-35: миграции содержат собственные BEGIN/COMMIT, но транзакцией
 * управляет runner — вложенные BEGIN/COMMIT ломают атомарность
 * (внутренний COMMIT фиксирует внешнюю транзакцию раньше времени).
 */
function stripTransactionStatements(sql) {
  return sql
    .replace(/^\s*BEGIN\s*;?\s*$/gmi, '')
    .replace(/^\s*COMMIT\s*;?\s*$/gmi, '')
    .replace(/^\s*START\s+TRANSACTION\s*;?\s*$/gmi, '')
    .replace(/^\s*ROLLBACK\s*;?\s*$/gmi, '')
    .trim();
}

async function runMigrations() {
  const client = await pool.connect();
  try {
    // C-35: Advisory lock — только один инстанс выполняет миграции.
    await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_KEY]);
    logger.debug('Acquired migration advisory lock');

    // Create migrations tracking table
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        filename TEXT PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);

    // Get applied migrations
    const applied = await client.query('SELECT filename FROM schema_migrations');
    const appliedFiles = new Set(applied.rows.map((r) => r.filename));

    // Get all migration files
    const files = fs
      .readdirSync(MIGRATIONS_DIR)
      .filter((f) => f.endsWith('.sql'))
      .sort();

    for (const file of files) {
      if (appliedFiles.has(file)) {
        logger.info(`Migration ${file} already applied, skipping`);
        continue;
      }

      const rawSql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
      // C-35: убираем вложенные BEGIN/COMMIT — транзакцией управляет runner.
      const sql = stripTransactionStatements(rawSql);
      logger.info(`Running migration: ${file}`);

      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (filename) VALUES ($1)', [file]);
        await client.query('COMMIT');
      } catch (migErr) {
        await client.query('ROLLBACK');
        logger.error(`Migration ${file} failed: ${migErr.message}`);
        throw migErr;
      }

      logger.info(`Migration ${file} applied successfully`);
    }

    logger.info('All migrations completed');
  } catch (error) {
    logger.error(`Migration runner error: ${error.message}`);
    throw error;
  } finally {
    // C-35: освобождаем advisory lock
    try {
      await client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_KEY]);
      logger.debug('Released migration advisory lock');
    } catch (unlockErr) {
      logger.error(`Failed to release advisory lock: ${unlockErr.message}`);
    }
    client.release();
  }
}

module.exports = { runMigrations };
