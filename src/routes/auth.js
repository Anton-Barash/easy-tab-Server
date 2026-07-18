// Auth Routes - endpoints for authentication

const authController = require('../controllers/authController');
const { requireAuth } = require('../middleware/authMiddleware');

// H-09: Строгий rate limit для auth-эндпоинтов — защита от брутфорса.
const AUTH_RATE_LIMIT = {
  rateLimit: {
    max: 5,
    timeWindow: '1 minute',
  },
};

// P1-19: JSON Schema для валидации body — Fastify автоматически
// отклоняет невалидные запросы с 400 до контроллера.
const registerSchema = {
  body: {
    type: 'object',
    required: ['username', 'password'],
    properties: {
      username: { type: 'string', minLength: 3, maxLength: 50 },
      password: { type: 'string', minLength: 6, maxLength: 256 },
      name: { type: 'string', maxLength: 100 },
      email: { type: 'string', format: 'email', maxLength: 255 },
    },
    additionalProperties: false,
  },
};

const loginSchema = {
  body: {
    type: 'object',
    required: ['username', 'password'],
    properties: {
      username: { type: 'string', minLength: 1, maxLength: 50 },
      password: { type: 'string', minLength: 1, maxLength: 256 },
    },
    additionalProperties: false,
  },
};

async function authRoutes(fastify) {
  // Register new user
  fastify.post(
    '/register',
    { config: AUTH_RATE_LIMIT, schema: registerSchema },
    authController.register
  );

  // Login
  fastify.post(
    '/login',
    { config: AUTH_RATE_LIMIT, schema: loginSchema },
    authController.login
  );

  // Get current user (requires auth)
  fastify.get('/me', { preHandler: requireAuth }, authController.me);
}

module.exports = authRoutes;
