const buildApp = require('./app');
const config = require('./config');
const { runMigrations } = require('./db/migrationRunner');
const { closePool } = require('./services/databaseService');
const ks3 = require('./services/ks3Storage');

// P1-18: валидация конфигурации при старте (production: обязательные переменные).
config.validateConfig(config);

// P3-49: Глобальные обработчики неперехваченных ошибок.
// Логируем и завершаем процесс — PM2/systemd перезапустят.
// Не продолжаем работу в неопределённом состоянии.
process.on('uncaughtException', (err) => {
  console.error('FATAL: uncaughtException', err);
  process.exit(1);
});
process.on('unhandledRejection', (reason) => {
  console.error('FATAL: unhandledRejection', reason);
  process.exit(1);
});

async function start() {
  const app = buildApp();

  try {
    // Run database migrations on startup
    await runMigrations();

    // Настройка CORS на бакете KS3 для прямой загрузки из браузера.
    // Non-fatal: если не удалось — продолжаем (fallback на серверную загрузку).
    await ks3.ensureBucketCors();

    await app.listen({ port: config.port, host: config.host });
    app.log.info(`Server running on ${config.host}:${config.port} [${config.env}]`);
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }

  // H-37: Graceful shutdown — обработка SIGTERM/SIGINT (PM2 restart, deploy).
  // 1. app.close() — перестать принимать новые соединения, дождаться активных запросов.
  // 2. closePool() — закрыть все соединения PostgreSQL.
  let shuttingDown = false;
  async function gracefulShutdown(signal) {
    if (shuttingDown) return; // Защита от повторных сигналов
    shuttingDown = true;
    app.log.info(`Received ${signal}, starting graceful shutdown...`);
    try {
      await app.close();
      app.log.info('Fastify closed');
    } catch (err) {
      app.log.error(`Error closing Fastify: ${err.message}`);
    }
    try {
      await closePool();
      app.log.info('PostgreSQL pool closed');
    } catch (err) {
      app.log.error(`Error closing pool: ${err.message}`);
    }
    process.exit(0);
  }

  process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
  process.on('SIGINT', () => gracefulShutdown('SIGINT'));
}

start();
