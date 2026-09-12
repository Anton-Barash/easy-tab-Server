// Auth Controller - handles auth HTTP requests

const crypto = require('crypto');
const authService = require('../services/authService');
const databaseService = require('../services/databaseService');

// ============================================================
// HttpOnly cookie для авторизации в новой вкладке браузера.
//
// Используется эндпоинтом GET /view/report/:publicId, который открывает
// HTML напрямую (без загрузки Flutter/Dart). При открытии в новой вкладке
// JS-заголовок Authorization отправить нельзя, поэтому токен передаётся
// через cookie. HttpOnly + SameSite=Lax: JS не может прочитать cookie,
// а браузер сам шлёт его на same-site навигации (/view/...).
// ============================================================
const AUTH_COOKIE_NAME = 'auth_token';
// Время жизни cookie совпадает с TTL JWT (.env JWT_EXPIRES_IN, по умолч. 7 дней).
const AUTH_COOKIE_MAX_AGE = 7 * 24 * 60 * 60;

/**
 * Установить HttpOnly cookie auth_token.
 * Secure включается только по HTTPS (иначе cookie с Secure не сохранится
 * в dev на plain HTTP localhost).
 * @param {number} [maxAgeSec] - время жизни cookie (по умолчанию 7 дней).
 */
function setAuthCookie(reply, request, token, maxAgeSec = AUTH_COOKIE_MAX_AGE) {
  reply.setCookie(AUTH_COOKIE_NAME, token, {
    path: '/',
    httpOnly: true,
    sameSite: 'lax',
    secure: request.protocol === 'https',
    maxAge: maxAgeSec,
  });
}

/**
 * Снять HttpOnly cookie auth_token (при logout).
 * JS не может очистить HttpOnly cookie через document.cookie, поэтому это
 * делает сервер (Set-Cookie с Max-Age=0).
 */
function clearAuthCookie(reply) {
  reply.clearCookie(AUTH_COOKIE_NAME, { path: '/' });
}

/**
 * Register a new user
 * Body: { username, name, email, password }
 */
async function register(request, reply) {
  try {
    const { username, password } = request.body;
    // name and email are optional - if omitted, derived from username
    let { name, email } = request.body;

    // Validate input
    if (!username || !password) {
      return reply.status(400).send({
        success: false,
        error: 'Username and password are required',
      });
    }

    if (password.length < 6) {
      return reply.status(400).send({
        success: false,
        error: 'Password must be at least 6 characters',
      });
    }

    // P3-49: Верхний лимит пароля — защита от DoS через PBKDF2 на гигантском пароле.
    if (password.length > 256) {
      return reply.status(400).send({
        success: false,
        error: 'Password must be at most 256 characters',
      });
    }

    if (username.length < 3) {
      return reply.status(400).send({
        success: false,
        error: 'Username must be at least 3 characters',
      });
    }

    // If name not provided, use username as display name
    if (!name) {
      name = username;
    }

    // If email not provided, generate a placeholder from username
    if (!email) {
      email = `${username.toLowerCase()}@easytab.local`;
    }

    // Basic email validation (only if user provided email)
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      return reply.status(400).send({
        success: false,
        error: 'Invalid email format',
      });
    }

    const result = await authService.register(username, name, email, password);

    // Ставим HttpOnly cookie, чтобы прямой HTML (/view/report) работал.
    setAuthCookie(reply, request, result.token);

    return reply.status(201).send({
      success: true,
      message: 'User registered successfully',
      user: result.user,
      token: result.token,
    });
  } catch (error) {
    request.log.error(error);

    if (error.code === 'USER_EXISTS') {
      return reply.status(409).send({
        success: false,
        error: 'Username or email already exists',
      });
    }

    return reply.status(500).send({
      success: false,
      error: 'Registration failed',
    });
  }
}

/**
 * Login user
 * Body: { username, password }
 */
async function login(request, reply) {
  try {
    const { username, password } = request.body;

    if (!username || !password) {
      return reply.status(400).send({
        success: false,
        error: 'Username and password are required',
      });
    }

    const result = await authService.login(username, password);

    // Ставим HttpOnly cookie, чтобы прямой HTML (/view/report) работал.
    setAuthCookie(reply, request, result.token);

    return reply.send({
      success: true,
      message: 'Login successful',
      user: result.user,
      token: result.token,
    });
  } catch (error) {
    request.log.error(error);

    if (error.code === 'INVALID_CREDENTIALS') {
      return reply.status(401).send({
        success: false,
        error: 'Invalid username or password',
      });
    }

    return reply.status(500).send({
      success: false,
      error: 'Login failed',
    });
  }
}

/**
 * Get current user info
 * Requires: Bearer token
 */
async function me(request, reply) {
  try {
    const userId = request.user.userId;
    const user = await authService.getUserById(userId);

    if (!user) {
      return reply.status(404).send({
        success: false,
        error: 'User not found',
      });
    }

    return reply.send({
      success: true,
      user,
    });
  } catch (error) {
    request.log.error(error);
    return reply.status(500).send({
      success: false,
      error: 'Failed to get user info',
    });
  }
}

/**
 * Logout — снимает HttpOnly cookie auth_token.
 * Серверный logout нужен, т.к. JS не может очистить HttpOnly cookie.
 */
async function logout(request, reply) {
  clearAuthCookie(reply);
  return reply.send({ success: true });
}

// ============================================================
// Обмен короткого view-токена на HttpOnly cookie.
//
// Телефон открывает серверный HTML во внешнем браузере, где нет
// HttpOnly cookie. Чтобы не держать ?token= в каждом URL (включая
// подписи к медиа), короткий токен один раз обменивается на cookie:
//   1. Браузер переходит на /auth/redeem-view?token=<viewToken>&target=/view/report/<publicId>
//   2. Сервер проверяет токен (scope='view', не истёк), помечает его
//      использованным (одноразовый) и ставит HttpOnly cookie auth_token
//      с тем же коротким view-токеном (5 мин, только просмотр).
//   3. Делает 302-редирект на target — теперь URL чистый, а браузер
//      сам шлёт cookie на /view/report/<publicId>, включая медиа.
//
// Cookie ограничена 5 минутами: внутри неё лежит view-токен, который
// быстро истекает и не даёт права записи. Это не полноценная 30-дневная
// сессия, поэтому утечка даже обменянного токена не открывает доступ.
// ============================================================
// Одноразовость view-токенов хранится в БД (а не в памяти процесса),
// чтобы работала в кластер-режиме: воркеры делят одну БД, поэтому
// повторное использование токена блокируется, даже если запросы
// попали в разные инстансы.
// ============================================================

// Внутренние пути приложения, на которые разрешён редирект после обмена.
// Ничего внешнего (http/https///) — защита от open-redirect.
const ALLOWED_REDIRECT_PREFIXES = ['/view/', '/view-report'];

/** Относительный + внутренний путь для редиректа, либо '/' */
function safeTargetPath(raw) {
  if (typeof raw !== 'string' || raw === '') return '/';
  // Блокируем абсолютные URL и protocol-relative ("//host").
  if (raw.startsWith('//') || /^[a-z][a-z0-9+.-]*:/i.test(raw)) return '/';
  if (!raw.startsWith('/')) return '/';
  if (!ALLOWED_REDIRECT_PREFIXES.some((p) => raw.startsWith(p))) return '/';
  return raw;
}

/**
 * GET /auth/redeem-view?token=...&target=/view/report/<publicId>
 * Обмен короткого view-токена на HttpOnly cookie с последующим редиректом.
 */
async function redeemViewToken(request, reply) {
  const token = request.query?.token;
  const rawTarget = request.query?.target;

  if (typeof token !== 'string' || token === '') {
    return reply.status(400).send({ success: false, error: 'Missing token' });
  }

  let payload;
  try {
    payload = authService.verifyToken(token);
  } catch (err) {
    return reply.status(401).send({ success: false, error: 'Invalid or expired token' });
  }

  // Принимаем только read-only view-токены.
  if (payload.scope !== 'view') {
    return reply.status(403).send({ success: false, error: 'Token is not for viewing' });
  }

  // Одноразовость через БД: INSERT ... ON CONFLICT DO NOTHING с полем
  // token_hash как PK. Если строка уже существует (rowCount === 0), токен
  // уже был обменян — повторное использование запрещено.
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  const nowMs = Date.now();
  // Opportunity-очистка истёкших записей (не критично, если не пройдёт).
  try {
    await databaseService.query('DELETE FROM used_view_tokens WHERE expires_at < $1', [nowMs]);
  } catch (_err) { /* ignore */ }

  const inserted = await databaseService.query(
    'INSERT INTO used_view_tokens (token_hash, expires_at, created_at) VALUES ($1, $2, $3) ' +
      'ON CONFLICT (token_hash) DO NOTHING',
    [tokenHash, payload.exp * 1000, nowMs]
  );
  if ((inserted.rowCount || 0) === 0) {
    return reply.status(401).send({ success: false, error: 'Token already used' });
  }

  // Ставим HttpOnly cookie с тем же коротким view-токеном (1 сутки, view).
  setAuthCookie(reply, request, token, 86400);

  const target = safeTargetPath(rawTarget);
  reply.redirect(target);
}

module.exports = {
  register,
  login,
  me,
  logout,
  redeemViewToken,
};
