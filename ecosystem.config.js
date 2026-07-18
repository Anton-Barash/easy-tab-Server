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
      PORT: 3000,
      // Секреты — задать перед деплоем (через CI/CD или вручную):
      // JWT_SECRET, DB_PASSWORD, KS3_ACCESS_KEY, KS3_SECRET_KEY,
      // DB_HOST, DB_USER, DB_NAME, CORS_ALLOWED_ORIGINS
      // Не коммитить реальные значения в этот файл!
    },
  }],
};
