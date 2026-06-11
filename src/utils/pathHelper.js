const path = require('path');
const config = require('../config');

function getUploadsDir() {
  return config.uploadsDir;
}

function getLogsDir() {
  return config.logsDir;
}

function getFilePath(filename) {
  // Предотвращаем path traversal
  const safeName = path.basename(filename);
  return path.join(getUploadsDir(), safeName);
}

module.exports = {
  getUploadsDir,
  getLogsDir,
  getFilePath,
};
