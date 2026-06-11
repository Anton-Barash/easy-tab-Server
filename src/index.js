const buildApp = require('./app');
const config = require('./config');

async function start() {
  const app = buildApp();

  try {
    await app.listen({ port: config.port, host: config.host });
    app.log.info(`Server running on ${config.host}:${config.port} [${config.env}]`);
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}

start();
