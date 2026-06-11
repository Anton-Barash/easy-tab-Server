const fs = require('fs').promises;
const fsSync = require('fs');
const path = require('path');
const pathHelper = require('../utils/pathHelper');
const logger = require('../utils/logger');

async function ensureUploadsDir() {
  const dir = pathHelper.getUploadsDir();
  if (!fsSync.existsSync(dir)) {
    await fs.mkdir(dir, { recursive: true });
  }
}

async function saveFile(filename, data, mimetype) {
  await ensureUploadsDir();
  const filePath = pathHelper.getFilePath(filename);
  await fs.writeFile(filePath, data);
  logger.info({ filename, mimetype }, 'File saved to local storage');
  return {
    filename,
    path: filePath,
    size: data.length,
    mimetype,
  };
}

async function getFile(filename) {
  const filePath = pathHelper.getFilePath(filename);
  try {
    const exists = fsSync.existsSync(filePath);
    if (!exists) {
      return null;
    }
    const data = await fs.readFile(filePath);
    return {
      data,
      filename,
      path: filePath,
    };
  } catch (err) {
    logger.error({ err, filename }, 'Error reading file');
    return null;
  }
}

async function listFiles() {
  await ensureUploadsDir();
  const dir = pathHelper.getUploadsDir();
  try {
    const files = await fs.readdir(dir);
    const fileInfos = await Promise.all(
      files.map(async (filename) => {
        const filePath = path.join(dir, filename);
        const stat = await fs.stat(filePath);
        return {
          filename,
          size: stat.size,
          modified: stat.mtime,
        };
      })
    );
    return fileInfos;
  } catch (err) {
    logger.error({ err }, 'Error listing files');
    return [];
  }
}

async function deleteFile(filename) {
  const filePath = pathHelper.getFilePath(filename);
  try {
    await fs.unlink(filePath);
    logger.info({ filename }, 'File deleted from local storage');
    return true;
  } catch (err) {
    logger.error({ err, filename }, 'Error deleting file');
    return false;
  }
}

module.exports = {
  saveFile,
  getFile,
  listFiles,
  deleteFile,
};
