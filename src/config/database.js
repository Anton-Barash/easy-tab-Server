// ============================================================
// Database configuration — PostgreSQL
//
// БЕЗОПАСНОСТЬ (C-04):
// - Пароль берётся ТОЛЬКО из env. Без него — ошибка.
// - DB_PORT парсится как число.
// - В production рекомендуется не использовать суперпользователя postgres.
// ============================================================

const DB_PASSWORD = process.env.DB_PASSWORD;

if (!DB_PASSWORD || DB_PASSWORD.length < 1) {
  throw new Error(
    'DB_PASSWORD не задан. Установите его в .env (dev) или ecosystem.config.js (production).'
  );
}

module.exports = {
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT, 10) || 5432,
  database: process.env.DB_NAME || 'postgres',
  user: process.env.DB_USER || 'postgres',
  password: DB_PASSWORD,
  max: 20, // Максимальное количество клиентов в пуле
  idleTimeoutMillis: 30000, // Закрывать простаивающие подключения через 30 сек
  connectionTimeoutMillis: 2000, // Таймаут подключения — 2 сек
};
