// Auth Service - user registration, login, token verification

const crypto = require('crypto');
const { promisify } = require('util');
const logger = require('../utils/logger');
const { query } = require('./databaseService');
const authConfig = require('../config/auth');

// TODO-32: асинхронный PBKDF2 — не блокирует event loop при хэшировании/проверке.
const pbkdf2Async = promisify(crypto.pbkdf2);

/**
 * Hash a password using PBKDF2 (Node.js built-in, no external deps)
 * @param {string} password
 * @returns {Promise<string>} - format: "salt:iterations:keylen:hash"
 */
async function hashPassword(password) {
  const salt = crypto.randomBytes(32).toString('hex');
  const iterations = 100000;
  const keylen = 64;
  const hash = (await pbkdf2Async(password, salt, iterations, keylen, 'sha512')).toString('hex');
  return `${salt}:${iterations}:${keylen}:${hash}`;
}

/**
 * Verify a password against stored hash
 * @param {string} password
 * @param {string} storedHash - format: "salt:iterations:keylen:hash"
 * @returns {Promise<boolean>}
 */
async function verifyPassword(password, storedHash) {
  try {
    const [salt, iterations, keylen, hash] = storedHash.split(':');
    const testHash = (await pbkdf2Async(password, salt, parseInt(iterations), parseInt(keylen), 'sha512')).toString('hex');
    return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(testHash, 'hex'));
  } catch (error) {
    logger.error(`Password verification error: ${error.message}`);
    return false;
  }
}

/**
 * Generate a simple signed token (HMAC-based, no external deps)
 * @param {object} payload
 * @returns {string}
 */
function generateToken(payload) {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const body = Buffer.from(JSON.stringify({
    ...payload,
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + authConfig.tokenExpirySeconds,
  })).toString('base64url');

  const signature = crypto
    .createHmac('sha256', authConfig.jwtSecret)
    .update(`${header}.${body}`)
    .digest('base64url');

  return `${header}.${body}.${signature}`;
}

/**
 * Verify a signed token
 * @param {string} token
 * @returns {object|null} - decoded payload or null
 */
function verifyToken(token) {
  try {
    const [header, body, signature] = token.split('.');
    if (!header || !body || !signature) return null;

    // P2-42: Проверка header — alg MUST be HS256, typ MUST be JWT.
    // Защита от algorithm confusion attack (alg=none или RS256 с public key).
    const headerObj = JSON.parse(Buffer.from(header, 'base64url').toString());
    if (headerObj.alg !== 'HS256' || headerObj.typ !== 'JWT') {
      logger.warn(`Token rejected: invalid header alg=${headerObj.alg} typ=${headerObj.typ}`);
      return null;
    }

    const expectedSignature = crypto
      .createHmac('sha256', authConfig.jwtSecret)
      .update(`${header}.${body}`)
      .digest('base64url');

    if (!crypto.timingSafeEqual(
      Buffer.from(signature),
      Buffer.from(expectedSignature)
    )) {
      return null;
    }

    const payload = JSON.parse(Buffer.from(body, 'base64url').toString());

    // P2-42: Обязательные поля payload.
    if (!payload.userId || !payload.exp || !payload.iat) {
      logger.warn('Token rejected: missing required claims');
      return null;
    }

    if (Math.floor(Date.now() / 1000) > payload.exp) {
      logger.warn('Token expired');
      return null;
    }

    return payload;
  } catch (error) {
    logger.error(`Token verification error: ${error.message}`);
    return null;
  }
}

/**
 * Register a new user
 * @param {string} username
 * @param {string} name
 * @param {string} email
 * @param {string} password
 * @returns {Promise<object>} - user info and token
 */
async function register(username, name, email, password) {
  // Check if username or email already exists (fast-path, user-friendly error)
  const existing = await query(
    'SELECT id FROM users WHERE username = $1 OR email = $2',
    [username, email]
  );

  if (existing.rows.length > 0) {
    const error = new Error('Username or email already exists');
    error.code = 'USER_EXISTS';
    throw error;
  }

  const passwordHash = await hashPassword(password);

  let result;
  try {
    result = await query(
      `INSERT INTO users (username, name, email, password_hash)
       VALUES ($1, $2, $3, $4)
       RETURNING id, username, name, email, created_at`,
      [username, name, email, passwordHash]
    );
  } catch (err) {
    // Task 20: race condition — другой запрос успел вставить между SELECT и INSERT.
    // PostgreSQL unique_violation — code 23505.
    if (err.code === '23505') {
      const error = new Error('Username or email already exists');
      error.code = 'USER_EXISTS';
      throw error;
    }
    throw err;
  }

  const user = result.rows[0];
  const token = generateToken({ userId: user.id, username: user.username });

  logger.info(`User registered: ${username}`);

  return { user, token };
}

// Task 21: фиктивный хеш для выравнивания timing при несуществующем пользователе.
// Тот же формат и стоимость PBKDF2, что и в hashPassword — атакующий не отличит
// «нет пользователя» от «неверный пароль» по времени ответа.
const DUMMY_HASH = (() => {
  const salt = crypto.randomBytes(32).toString('hex');
  const iterations = 100000;
  const keylen = 64;
  const hash = crypto
    .pbkdf2Sync('dummy', salt, iterations, keylen, 'sha512')
    .toString('hex');
  return `${salt}:${iterations}:${keylen}:${hash}`;
})();

/**
 * Login user
 * @param {string} usernameOrEmail
 * @param {string} password
 * @returns {Promise<object>} - user info and token
 */
async function login(usernameOrEmail, password) {
  const result = await query(
    'SELECT id, username, name, email, password_hash, created_at FROM users WHERE username = $1 OR email = $1',
    [usernameOrEmail]
  );

  if (result.rows.length === 0) {
    // Task 21: выполняем verifyPassword против фиктивного хеша, чтобы
    // выровнять время ответа (защита от user enumeration по timing).
    await verifyPassword(password, DUMMY_HASH);
    const error = new Error('Invalid credentials');
    error.code = 'INVALID_CREDENTIALS';
    throw error;
  }

  const user = result.rows[0];

  if (!(await verifyPassword(password, user.password_hash))) {
    const error = new Error('Invalid credentials');
    error.code = 'INVALID_CREDENTIALS';
    throw error;
  }

  const token = generateToken({ userId: user.id, username: user.username });

  logger.info(`User logged in: ${user.username}`);

  // Remove password_hash from response
  delete user.password_hash;

  return { user, token };
}

/**
 * Get user by ID
 * @param {number} userId
 * @returns {Promise<object|null>}
 */
async function getUserById(userId) {
  const result = await query(
    'SELECT id, username, name, email, created_at FROM users WHERE id = $1',
    [userId]
  );

  return result.rows[0] || null;
}

module.exports = {
  hashPassword,
  verifyPassword,
  generateToken,
  verifyToken,
  register,
  login,
  getUserById,
};
