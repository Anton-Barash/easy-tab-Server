const path = require('path');
const fs = require('fs');

// NODE_ENV может быть задан извне (PM2: --env production) до загрузки .env.
// На компе разработчика он берётся из .env (development).
const env = process.env.NODE_ENV || 'development';
const rootDir = path.resolve(__dirname, '../..');

// Сначала базовый .env (общий), затем .env.<NODE_ENV> (если есть) —
// он переопределяет базовый. Так на компе (development) используются
// внешние адреса, а на сервере (production) — внутренние (10.0.x.x).
require('dotenv').config({ path: path.join(rootDir, '.env') });
const envFile = path.join(rootDir, `.env.${env}`);
if (env !== 'development' && fs.existsSync(envFile)) {
  require('dotenv').config({ path: envFile, override: true });
}

const defaultConfig = require('./default');
const productionConfig = require('./production');

const configs = {
  development: defaultConfig,
  production: { ...defaultConfig, ...productionConfig },
};

const config = configs[env] || defaultConfig;

config.env = env;
// P3-59: PORT=0 — валидный порт (авто-выбор ОС).
// Используем ?? вместо ||, чтобы 0 не перекрывался дефолтом.
const parsedPort = parseInt(process.env.PORT, 10);
config.port = !isNaN(parsedPort) ? parsedPort : config.port;

// P1-18: централизованная валидация конфигурации при старте.
// В production проверяем наличие всех обязательных переменных.
function validateConfig(cfg) {
  const errors = [];

  if (cfg.env !== 'development' && cfg.env !== 'production') {
    errors.push(`Недопустимый NODE_ENV: "${cfg.env}". Ожидается: development | production`);
  }

  if (cfg.env === 'production') {
    const required = [
      'JWT_SECRET',
      'DB_PASSWORD',
      'DB_HOST',
      'DB_USER',
      'DB_NAME',
      'KS3_ACCESS_KEY',
      'KS3_SECRET_KEY',
      'KS3_BUCKET',
      'KS3_REGION',
      'CORS_ALLOWED_ORIGINS',
    ];
    for (const key of required) {
      if (!process.env[key] || process.env[key].trim() === '') {
        errors.push(`Обязательная переменная ${key} не задана (production)`);
      }
    }
    const jwtSecret = process.env.JWT_SECRET;
    if (jwtSecret && jwtSecret.length < 32) {
      errors.push(`JWT_SECRET короче 32 символов (длина: ${jwtSecret.length})`);
    }
  }

  if (errors.length > 0) {
    console.error('Ошибка конфигурации:');
    errors.forEach((e) => console.error(`  - ${e}`));
    process.exit(1);
  }
}

module.exports = config;
module.exports.validateConfig = validateConfig;
