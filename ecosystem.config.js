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
      // HTTPS-порт: сервер терминирует TLS сам (easytab.cloud, certs/).
      // Порт 443 требует прав root (или setcap cap_net_bind_service) и должен
      // быть открыт в облачном firewall/балансировщике.
      PORT: 443,
      TLS_ENABLED: 1,
      TLS_CERT: 'certs/easytab.cloud.pem',
      TLS_KEY: 'certs/easytab.cloud.key',
      // HTTP→HTTPS редирект: приложение отдельно слушает 80 и редиректит на 443.
      TLS_REDIRECT_PORT: 80,
      // Секреты и внутренние адреса (DB_HOST=10.0.1.32 и т.д.) — в .env.production
      // на сервере. Он загружается автоматически при NODE_ENV=production.
      // Не коммитить реальные значения в этот файл!
    },
  }],
};
