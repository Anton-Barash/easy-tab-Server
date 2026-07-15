const buildApp = require('./app');
const config = require('./config');
const { runMigrations } = require('./db/migrationRunner');

async function start() {
  const app = buildApp();

  try {
    // Run database migrations on startup
    await runMigrations();

    await app.listen({ port: config.port, host: config.host });
    app.log.info(`Server running on ${config.host}:${config.port} [${config.env}]`);
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}

start();
