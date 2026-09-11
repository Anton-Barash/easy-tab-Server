// Auth Controller - handles auth HTTP requests

const authService = require('../services/authService');

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
 */
function setAuthCookie(reply, request, token) {
  reply.setCookie(AUTH_COOKIE_NAME, token, {
    path: '/',
    httpOnly: true,
    sameSite: 'lax',
    secure: request.protocol === 'https',
    maxAge: AUTH_COOKIE_MAX_AGE,
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

module.exports = {
  register,
  login,
  me,
  logout,
};
