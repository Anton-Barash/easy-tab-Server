// Database Migration Runner

const fs = require('fs');
const path = require('path');
const logger = require('../utils/logger');
const { pool } = require('../services/databaseService');

const MIGRATIONS_DIR = path.join(__dirname, 'migrations');

async function runMigrations() {
  const client = await pool.connect();
  try {
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

      const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
      logger.info(`Running migration: ${file}`);

      await client.query('BEGIN');
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations (filename) VALUES ($1)', [file]);
      await client.query('COMMIT');

      logger.info(`Migration ${file} applied successfully`);
    }

    logger.info('All migrations completed');
  } catch (error) {
    await client.query('ROLLBACK');
    logger.error(`Migration failed: ${error.message}`);
    throw error;
  } finally {
    client.release();
  }
}

module.exports = { runMigrations };
