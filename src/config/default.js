const path = require('path');

module.exports = {
  port: 3000,
  host: '0.0.0.0',
  storage: 'local',
  uploadsDir: path.join(__dirname, '../../uploads'),
  logsDir: path.join(__dirname, '../../logs'),
  maxFileSize: 50 * 1024 * 1024, // 50 MB
  logger: {
    level: 'info',
  },
};
