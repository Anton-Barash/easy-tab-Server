// Auth Controller - handles auth HTTP requests

const authService = require('../services/authService');

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

module.exports = {
  register,
  login,
  me,
};
