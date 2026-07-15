// Auth configuration

module.exports = {
  // JWT secret for signing tokens
  jwtSecret: process.env.JWT_SECRET || 'easytab_secret_key_change_in_production',

  // Token expiration
  tokenExpiry: '7d',

  // Bcrypt rounds for password hashing
  bcryptRounds: 10,
};
