// ============================================================
// Auth configuration
//
// БЕЗОПАСНОСТЬ (C-03, M-43):
// - JWT секрет берётся ТОЛЬКО из env. Без него сервер падает.
// - bcryptRounds удалён (используется PBKDF2 — см. authService).
// - tokenExpiry используется в generateToken (единый источник).
// ============================================================

const JWT_SECRET = process.env.JWT_SECRET;

if (!JWT_SECRET || JWT_SECRET.length < 32) {
  throw new Error(
    'JWT_SECRET не задан или короче 32 символов. ' +
    'Установите его в .env (dev) или ecosystem.config.js (production). ' +
    'Пример генерации: node -e "console.log(require(\'crypto\').randomBytes(48).toString(\'hex\'))"'
  );
}

module.exports = {
  jwtSecret: JWT_SECRET,
  // Срок жизни JWT-токена в секундах (7 дней)
  tokenExpirySeconds: 7 * 24 * 60 * 60,
  // Параметры PBKDF2 (используется в authService)
  pbkdf2: {
    iterations: 100000,
    keylen: 64,
    digest: 'sha512',
    saltLength: 32,
  },
};
