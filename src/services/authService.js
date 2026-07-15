// Auth Service - user registration, login, token verification

const crypto = require('crypto');
const logger = require('../utils/logger');
const { query } = require('./databaseService');
const authConfig = require('../config/auth');

/**
 * Hash a password using PBKDF2 (Node.js built-in, no external deps)
 * @param {string} password
 * @returns {string} - format: "salt:iterations:keylen:hash"
 */
function hashPassword(password) {
  const salt = crypto.randomBytes(32).toString('hex');
  const iterations = 100000;
  const keylen = 64;
  const hash = crypto
    .pbkdf2Sync(password, salt, iterations, keylen, 'sha512')
    .toString('hex');
  return `${salt}:${iterations}:${keylen}:${hash}`;
}

/**
 * Verify a password against stored hash
 * @param {string} password
 * @param {string} storedHash - format: "salt:iterations:keylen:hash"
 * @returns {boolean}
 */
function verifyPassword(password, storedHash) {
  try {
    const [salt, iterations, keylen, hash] = storedHash.split(':');
    const testHash = crypto
      .pbkdf2Sync(password, salt, parseInt(iterations), parseInt(keylen), 'sha512')
      .toString('hex');
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
    exp: Math.floor(Date.now() / 1000) + 7 * 24 * 60 * 60, // 7 days
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

    if (payload.exp && Math.floor(Date.now() / 1000) > payload.exp) {
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
  // Check if username or email already exists
  const existing = await query(
    'SELECT id FROM users WHERE username = $1 OR email = $2',
    [username, email]
  );

  if (existing.rows.length > 0) {
    const error = new Error('Username or email already exists');
    error.code = 'USER_EXISTS';
    throw error;
  }

  const passwordHash = hashPassword(password);

  const result = await query(
    `INSERT INTO users (username, name, email, password_hash)
     VALUES ($1, $2, $3, $4)
     RETURNING id, username, name, email, created_at`,
    [username, name, email, passwordHash]
  );

  const user = result.rows[0];
  const token = generateToken({ userId: user.id, username: user.username });

  logger.info(`User registered: ${username}`);

  return { user, token };
}

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
    const error = new Error('Invalid credentials');
    error.code = 'INVALID_CREDENTIALS';
    throw error;
  }

  const user = result.rows[0];

  if (!verifyPassword(password, user.password_hash)) {
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
