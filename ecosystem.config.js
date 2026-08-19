// ============================================================
// PM2 ecosystem config — production настройки
//
// БЕЗОПАСНОСТЬ:
// - Все секреты передаются через env_production.
// - В production JWT_SECRET, DB_PASSWORD, KS3_* обязательны.
// - Секреты НЕ хардкодить здесь — использовать deploy-скрипт
//   или переменные окружения PM2: pm2 start --env production
// ============================================================

module.exports = {
  apps: [{
    name: 'file-server',
    script: './src/index.js',
    instances: 2,
    exec_mode: 'cluster',
    autorestart: true,
    watch: false,
    max_memory_restart: '1G',
    env_production: {
      NODE_ENV: 'production',
      // Порт 8000 — именно его пробрасывает облачный балансировщик наружу
      // (внешний адрес http://110.43.49.137:8000).
      PORT: 8000,
      // Секреты и внутренние адреса (DB_HOST=10.0.1.32 и т.д.) — в .env.production
      // на сервере. Он загружается автоматически при NODE_ENV=production.
      // Не коммитить реальные значения в этот файл!
    },
  }],
};
