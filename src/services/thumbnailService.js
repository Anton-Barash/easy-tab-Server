const sharp = require('sharp');
const logger = require('../utils/logger');

const THUMBNAIL_WIDTH = 200;
const THUMBNAIL_QUALITY = 70;

async function generateThumbnail(imageBuffer) {
  try {
    const thumbnail = await sharp(imageBuffer)
      .resize(THUMBNAIL_WIDTH, null, {
        fit: sharp.fit.cover,
        withoutEnlargement: true,
      })
      .jpeg({
        quality: THUMBNAIL_QUALITY,
        progressive: true,
      })
      .toBuffer();

    logger.debug(`generateThumbnail: created thumbnail ${thumbnail.length} bytes`);
    return thumbnail;
  } catch (error) {
    logger.error(`generateThumbnail: failed - ${error.message}`);
    throw error;
  }
}

function getThumbnailStorageKey(originalStorageKey) {
  const ext = originalStorageKey.lastIndexOf('.');
  if (ext === -1) {
    return `${originalStorageKey}_thumb.jpg`;
  }
  return `${originalStorageKey.substring(0, ext)}_thumb.jpg`;
}

function isImageFile(mimeType) {
  return mimeType && mimeType.startsWith('image/');
}

module.exports = {
  generateThumbnail,
  getThumbnailStorageKey,
  isImageFile,
  THUMBNAIL_WIDTH,
  THUMBNAIL_QUALITY,
};