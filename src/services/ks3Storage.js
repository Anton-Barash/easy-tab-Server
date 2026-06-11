// KS3 Storage — заглушка для будущего использования
// Когда KS3 будет активирован, реализовать методы с ks3-sdk

const logger = require('../utils/logger');

async function saveFile(filename, data, mimetype) {
  throw new Error('KS3 storage is not configured yet. Set storage=local in config.');
}

async function getFile(filename) {
  throw new Error('KS3 storage is not configured yet. Set storage=local in config.');
}

async function listFiles() {
  throw new Error('KS3 storage is not configured yet. Set storage=local in config.');
}

async function deleteFile(filename) {
  throw new Error('KS3 storage is not configured yet. Set storage=local in config.');
}

module.exports = {
  saveFile,
  getFile,
  listFiles,
  deleteFile,
};
