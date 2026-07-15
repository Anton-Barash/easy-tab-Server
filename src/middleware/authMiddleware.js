// Auth Middleware - verifies JWT token from Authorization header

const authService = require('../services/authService');

/**
 * Extract and verify token from request
 * @param {object} request - Fastify request
 * @returns {object|null} - decoded user payload or null
 */
function extractUser(request) {
  const authHeader = request.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return null;
  }

  const token = authHeader.substring(7);
  return authService.verifyToken(token);
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
 * Middleware: optional authentication (doesn't fail if no token)
 */
async function optionalAuth(request, reply) {
  const payload = extractUser(request);
  if (payload) {
    request.user = payload;
  }
}

module.exports = {
  extractUser,
  requireAuth,
  optionalAuth,
};
