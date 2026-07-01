// KS3 Storage - Kingsoft Cloud Storage Service

const KS3 = require('ks3');
const logger = require('../utils/logger');

// KS3 configuration
const KS3_CONFIG = {
  accessKeyId: process.env.KS3_ACCESS_KEY || 'AKLTVcEfi57Tqah5YLaRqHex',
  accessKeySecret: process.env.KS3_SECRET_KEY || 'OId4i10qT4Zpne6jiiU5p7ZYcZV32VfnDZ9LUR8d',
  bucket: process.env.KS3_BUCKET || 'ew-ks3',
  region: process.env.KS3_REGION || 'GUANGZHOU',
};

// Create KS3 client
const client = new KS3(
  KS3_CONFIG.accessKeyId,
  KS3_CONFIG.accessKeySecret,
  KS3_CONFIG.bucket,
  KS3_CONFIG.region
);

/**
 * Save file to KS3 bucket
 * @param {string} filename - File name/key
 * @param {Buffer} data - File data
 * @param {string} mimetype - MIME type
 * @returns {Promise<object>}
 */
async function saveFile(filename, data, mimetype) {
  try {
    logger.info(`Uploading file to KS3: ${filename}`);

    await new Promise((resolve, reject) => {
      client.object.put({
        Bucket: KS3_CONFIG.bucket,
        Key: filename,
        Body: data,
      }, (err, data, response) => {
        if (err) {
          logger.error(`KS3 upload error: ${err}`);
          reject(err);
        } else {
          logger.info(`KS3 upload success: ${filename}`);
          resolve(data);
        }
      });
    });

    return {
      filename,
      bucket: KS3_CONFIG.bucket,
      region: KS3_CONFIG.region,
      url: `https://${KS3_CONFIG.bucket}.ks3-cn-${KS3_CONFIG.region.toLowerCase()}.kss.ksyun.com/${filename}`,
    };
  } catch (error) {
    logger.error(`Failed to upload to KS3: ${error.message}`);
    throw error;
  }
}

/**
 * Get file from KS3 bucket
 * @param {string} filename - File name/key
 * @returns {Promise<object>}
 */
async function getFile(filename) {
  try {
    logger.info(`Downloading file from KS3: ${filename}`);
    
    const data = await new Promise((resolve, reject) => {
      client.object.get({
        Bucket: KS3_CONFIG.bucket,
        Key: filename,
      }, (err, data, response) => {
        if (err) {
          logger.error(`KS3 download error: ${err}`);
          reject(err);
        } else {
          resolve(data);
        }
      });
    });
    
    return {
      filename,
      data,
    };
  } catch (error) {
    logger.error(`Failed to download from KS3: ${error.message}`);
    throw error;
  }
}

/**
 * Generate presigned URL for file download
 * @param {string} filename - File name/key
 * @param {number} expires - URL expiration time in seconds (default 3600)
 * @returns {Promise<string>}
 */
async function getPresignedUrl(filename, expires = 3600) {
  try {
    logger.info(`Generating presigned URL for: ${filename}`);
    
    const url = await new Promise((resolve, reject) => {
      client.object.generatePresignedUrl({
        Bucket: KS3_CONFIG.bucket,
        Key: filename,
        Expires: expires,
      }, (err, data, response) => {
        if (err) {
          logger.error(`KS3 presigned URL error: ${err}`);
          reject(err);
        } else {
          resolve(data);
        }
      });
    });
    
    return url;
  } catch (error) {
    logger.error(`Failed to generate presigned URL: ${error.message}`);
    throw error;
  }
}

/**
 * List all files in bucket
 * @returns {Promise<array>}
 */
async function listFiles() {
  try {
    logger.info('Listing files from KS3 bucket');
    
    const data = await new Promise((resolve, reject) => {
      client.bucket.get({
        Bucket: KS3_CONFIG.bucket,
      }, (err, data, response) => {
        if (err) {
          logger.error(`KS3 list error: ${err}`);
          reject(err);
        } else {
          resolve(data);
        }
      });
    });
    
    // Parse list response
    const files = data.Contents || [];
    return files.map(file => ({
      filename: file.Key,
      size: file.Size,
      lastModified: file.LastModified,
    }));
  } catch (error) {
    logger.error(`Failed to list files from KS3: ${error.message}`);
    throw error;
  }
}

/**
 * Delete file from KS3 bucket
 * @param {string} filename - File name/key
 * @returns {Promise<boolean>}
 */
async function deleteFile(filename) {
  try {
    logger.info(`Deleting file from KS3: ${filename}`);
    
    await new Promise((resolve, reject) => {
      client.object.delete({
        Bucket: KS3_CONFIG.bucket,
        Key: filename,
      }, (err, data, response) => {
        if (err) {
          logger.error(`KS3 delete error: ${err}`);
          reject(err);
        } else {
          resolve(data);
        }
      });
    });
    
    return true;
  } catch (error) {
    logger.error(`Failed to delete from KS3: ${error.message}`);
    throw error;
  }
}

/**
 * Check if bucket exists and is accessible
 * @returns {Promise<boolean>}
 */
async function checkBucket() {
  try {
    logger.info('Checking KS3 bucket accessibility');
    
    await new Promise((resolve, reject) => {
      client.bucket.getACL({
        Bucket: KS3_CONFIG.bucket,
      }, (err, data, response) => {
        if (err) {
          logger.error(`KS3 bucket check error: ${err}`);
          reject(err);
        } else {
          logger.info(`KS3 bucket is accessible: ${KS3_CONFIG.bucket}`);
          resolve(data);
        }
      });
    });
    
    return true;
  } catch (error) {
    logger.error(`KS3 bucket not accessible: ${error.message}`);
    return false;
  }
}

module.exports = {
  saveFile,
  getFile,
  getPresignedUrl,
  listFiles,
  deleteFile,
  checkBucket,
  client,
  KS3_CONFIG,
};