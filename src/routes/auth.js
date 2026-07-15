// Auth Routes - endpoints for authentication

const authController = require('../controllers/authController');
const { requireAuth } = require('../middleware/authMiddleware');

async function authRoutes(fastify) {
  // Register new user
  fastify.post('/register', authController.register);

  // Login
  fastify.post('/login', authController.login);

  // Get current user (requires auth)
  fastify.get('/me', { preHandler: requireAuth }, authController.me);
}

module.exports = authRoutes;
