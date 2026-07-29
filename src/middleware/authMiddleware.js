// ============================================================
// Auth Middleware - извлечение и проверка JWT токена
//
// Поддерживает три способа передачи токена:
//   1. Authorization: Bearer <token> (стандартный способ для API)
//   2. Cookie: auth_token=<token> (для iframe и браузерных запросов)
//   3. Query параметр: ?token=<token> (для открытия URL в новой вкладке)
//
// Приоритет проверки: Bearer header → Cookie → Query параметр
//
// Middleware:
//   - requireAuth: требует аутентификацию (401 если нет токена)
//   - optionalAuth: пытается извлечь пользователя, но не требует авторизацию
// ============================================================

const authService = require('../services/authService');

/**
 * Extract and verify token from request.
 *
 * Проверяет токен в трёх местах:
 *   1. Authorization: Bearer <token> (для API-запросов из Flutter)
 *   2. Cookie: auth_token=<token> (для iframe и браузерных запросов)
 *   3. ?token=<token> query-параметр (для просмотра /view/report/:id в браузере)
 *
 * Cookie нужен, потому что при открытии новой вкладки браузера
 * (через window.open / anchor.click) Authorization header не передаётся.
 *
 * @param {object} request - Fastify request
 * @returns {object|null} - decoded user payload or null
 */
function extractUser(request) {
  const token = extractToken(request);
  if (!token) {
    console.log('[DEBUG] No token found. Cookies:', request.cookies, 'Query:', request.query);
    return null;
  }
  return authService.verifyToken(token);
}

/**
 * Extract raw JWT token string from request.
 *
 * Проверяет токен в трёх местах:
 *   1. Authorization: Bearer <token>
 *   2. Cookie: auth_token=<token>
 *   3. ?token=<token> query-параметр
 *
 * @param {object} request - Fastify request
 * @returns {string|null} - raw token or null
 */
function extractToken(request) {
  // 1. Проверяем Authorization header (стандартный способ)
  const authHeader = request.headers.authorization;
  // P3-60: RFC 7235 — схема авторизации case-insensitive.
  // toLowerCase() гарантирует, что 'bearer' и 'Bearer' обрабатываются одинаково.
  if (authHeader && authHeader.toLowerCase().startsWith('bearer ')) {
    return authHeader.substring(7);
  }

  // 2. Проверяем cookie auth_token (для iframe и браузерных запросов)
  const cookieToken = request.cookies?.auth_token;
  if (cookieToken && typeof cookieToken === 'string') {
    console.log('[DEBUG] Found auth_token cookie:', cookieToken.substring(0, 20) + '...');
    return cookieToken;
  }

  // 3. Проверяем query-параметр ?token= (для view-эндпоинтов в браузере)
  const queryToken = request.query && request.query.token;
  if (queryToken && typeof queryToken === 'string') {
    return queryToken;
  }

  return null;
}

/**
 * Middleware: require authentication
 */
async function requireAuth(request, reply) {
  const payload = extractUser(request);
  if (!payload) {
    return reply.status(401).send({
      success: false,
      error: 'Unauthorized',
    });
  }
  request.user = payload;
}

/**
 * Middleware: optional authentication
 * Пытается извлечь пользователя, но не требует авторизацию.
 * Используется для эндпоинтов, которые могут быть доступны анонимно (публичные ресурсы).
 */
async function optionalAuth(request, reply) {
  const payload = extractUser(request);
  if (payload) {
    request.user = payload;
  }
}

module.exports = {
  extractUser,
  extractToken,
  requireAuth,
  optionalAuth,
};
