// ============================================================
// S3-compatible Storage — замена KS3 SDK на AWS SDK v3.
//
// Поддерживает Kingsoft Cloud KS3 (S3-compatible) и любое другое
// S3-совместимое хранилище через кастомный endpoint.
//
// Интерфейс полностью совместим с предыдущим ks3Storage.js,
// поэтому потребители (fileService, reportsService, index.js)
// меняют только импорт.
// ============================================================

const {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  ListObjectsV2Command,
  HeadBucketCommand,
  PutBucketCorsCommand,
} = require('@aws-sdk/client-s3');
const { Upload } = require('@aws-sdk/lib-storage');
const aws4 = require('aws4');
const { Readable } = require('stream');
const logger = require('../utils/logger');

// ------------------------------------------------------------
// Конфигурация — только из env, fail-fast при отсутствии секретов.
// ------------------------------------------------------------

function _requireEnv(name) {
  const value = process.env[name];
  if (!value || value.trim() === '') {
    throw new Error(
      `S3 Storage: обязательная переменная окружения ${name} не задана. ` +
        `Установите её в .env (dev) или ecosystem.config.js (production).`
    );
  }
  return value.trim();
}

const S3_CONFIG = {
  accessKeyId: _requireEnv('KS3_ACCESS_KEY'),
  secretAccessKey: _requireEnv('KS3_SECRET_KEY'),
  bucket: _requireEnv('KS3_BUCKET'),
  region: _requireEnv('KS3_REGION'),
  endpoint: process.env.KS3_ENDPOINT || null,
};

/**
 * Построить endpoint по региону KS3, если не задан явно.
 * Список регионов взят из оригинального ks3 SDK (config.js).
 */
function _buildEndpoint(region) {
  const endpoints = {
    BEIJING: 'ks3-cn-beijing.ksyuncs.com',
    HONGKONG: 'ks3-cn-hk-1.ksyuncs.com',
    SHANGHAI: 'ks3-cn-shanghai.ksyuncs.com',
    GUANGZHOU: 'ks3-cn-guangzhou.ksyuncs.com',
    RUSSIA: 'ks3-rus.ksyuncs.com',
    SINGAPORE: 'ks3-sgp.ksyuncs.com',
    JR_BEIJING: 'ks3-jr-beijing.ksyuncs.com',
    JR_SHANGHAI: 'ks3-jr-shanghai.ksyuncs.com',
    GOV_BEIJING: 'ks3-gov-beijing.ksyuncs.com',
    AMERICA: 'ks3-us-west-1.ksyuncs.com',
  };
  const host = endpoints[region] || `ks3-${region.toLowerCase()}.ksyuncs.com`;
  return `https://${host}`;
}

const endpoint = S3_CONFIG.endpoint || _buildEndpoint(S3_CONFIG.region);

const client = new S3Client({
  region: S3_CONFIG.region,
  endpoint,
  // KS3 требует virtual-hosted style (bucket.endpoint/key).
  forcePathStyle: false,
  credentials: {
    accessKeyId: S3_CONFIG.accessKeyId,
    secretAccessKey: S3_CONFIG.secretAccessKey,
  },
  // HTTP keep-alive ускоряет серию запросов к хранилищу.
  requestHandler: {
    requestTimeout: 300000,
    httpsAgent: { maxSockets: 50, keepAlive: true },
  },
});

function getBucket() {
  return S3_CONFIG.bucket;
}

function getRegion() {
  return S3_CONFIG.region;
}

// ------------------------------------------------------------
// Upload
// ------------------------------------------------------------

/**
 * Загрузить файл в S3-совместимое хранилище.
 *
 * Для файлов <= 5 MB используем простой PutObjectCommand.
 * Для больших файлов — @aws-sdk/lib-storage (multipart upload),
 * чтобы не держать всё тело в памяти и не упираться в лимиты.
 */
async function saveFile(key, body, mimeType = 'application/octet-stream') {
  logger.info(`S3 upload: ${body.length} bytes, ${mimeType}`);
  logger.debug(`S3 upload key: ${key}`);

  const maxRetries = 3;
  let lastError;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await _saveFileOnce(key, body, mimeType);
    } catch (error) {
      lastError = error;
      const errCode = error && error.code;
      const errMsg = error && error.message ? error.message : String(error);
      const isRetryable =
        errCode === 'ECONNRESET' ||
        errCode === 'ENOTFOUND' ||
        errCode === 'ETIMEDOUT' ||
        errCode === 'ECONNREFUSED' ||
        errMsg.includes('timeout');

      if (isRetryable && attempt < maxRetries) {
        const delayMs = attempt * 2000;
        logger.warn(
          `S3 upload failed (attempt ${attempt}/${maxRetries}), retrying in ${delayMs}ms: ${errMsg}`
        );
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        continue;
      }

      logger.error(`Failed to upload to S3 after ${attempt} attempt(s): ${errMsg}`);
      throw error;
    }
  }

  throw lastError;
}

async function _saveFileOnce(key, body, mimeType) {
  const sizeBasedTimeout = Math.max(120000, Math.ceil(body.length / 100000) * 1000);
  const uploadTimeout = body.length > 5 * 1024 * 1024 ? 300000 : sizeBasedTimeout;

  if (body.length > 5 * 1024 * 1024) {
    // Multipart upload для больших файлов.
    const upload = new Upload({
      client,
      params: {
        Bucket: S3_CONFIG.bucket,
        Key: key,
        Body: body,
        ContentType: mimeType,
      },
      queueSize: 4,
      partSize: 5 * 1024 * 1024,
      leavePartsOnError: false,
    });

    const timeoutPromise = new Promise((_, reject) => {
      setTimeout(() => {
        reject(new Error(`S3 multipart upload timeout after ${uploadTimeout}ms for key ${key}`));
      }, uploadTimeout);
    });

    await Promise.race([upload.done(), timeoutPromise]);
  } else {
    const command = new PutObjectCommand({
      Bucket: S3_CONFIG.bucket,
      Key: key,
      Body: body,
      ContentType: mimeType,
    });

    const timeoutPromise = new Promise((_, reject) => {
      setTimeout(() => {
        reject(new Error(`S3 upload timeout after ${uploadTimeout}ms for key ${key}`));
      }, uploadTimeout);
    });

    await Promise.race([client.send(command), timeoutPromise]);
  }

  return {
    key,
    bucket: S3_CONFIG.bucket,
    region: S3_CONFIG.region,
    size: body.length,
    mimeType,
  };
}

// ------------------------------------------------------------
// Download
// ------------------------------------------------------------

async function getFile(key) {
  logger.info('S3 download');
  logger.debug(`S3 download key: ${key}`);

  try {
    const command = new GetObjectCommand({
      Bucket: S3_CONFIG.bucket,
      Key: key,
    });

    const response = await client.send(command);
    const chunks = [];
    for await (const chunk of response.Body) {
      chunks.push(chunk);
    }

    return { key, data: Buffer.concat(chunks) };
  } catch (error) {
    logger.error(`Failed to download from S3: ${error.message}`);
    throw error;
  }
}

async function getFileStream(key, range = null) {
  logger.info(`S3 download stream: range=${range || 'none'}`);
  logger.debug(`S3 download stream key: ${key}`);

  try {
    const url = await getPresignedUrl(key, 300);
    const fetchHeaders = {};
    if (range) {
      fetchHeaders.Range = range;
    }

    const response = await fetch(url, { headers: fetchHeaders });
    if (!response.ok && response.status !== 206) {
      const body = await response.text().catch(() => '');
      throw new Error(`S3 stream error: ${response.status} ${response.statusText} ${body.substring(0, 200)}`);
    }

    const contentType = response.headers.get('content-type') || 'application/octet-stream';
    const contentLength = response.headers.get('content-length');
    const contentRange = response.headers.get('content-range');
    const acceptRanges = response.headers.get('accept-ranges');

    return {
      stream: Readable.fromWeb(response.body),
      status: response.status,
      headers: {
        contentType,
        contentLength,
        contentRange,
        acceptRanges,
      },
    };
  } catch (error) {
    logger.error(`Failed to stream from S3: ${error.message}`);
    throw error;
  }
}

// ------------------------------------------------------------
// Presigned URLs
// ------------------------------------------------------------

/**
 * Построить виртуальный host для bucket (KS3 third-level domain).
 */
function _bucketHost() {
  const endpointUrl = new URL(endpoint);
  return `${S3_CONFIG.bucket}.${endpointUrl.host}`;
}

/**
 * Сгенерировать query-string подпись через aws4.
 *
 * AWS SDK v3 добавляет в presigned URL параметры (x-amz-checksum-mode,
 * X-Amz-Content-Sha256), которые KS3 не принимает. aws4 формирует
 * чистую AWS4-подпись, совместимую с KS3.
 */
function _ks3PresignedUrl(method, key, expires = 3600) {
  const host = _bucketHost();
  const encodedKey = key.split('/').map(encodeURIComponent).join('/');
  const opts = {
    host,
    path: `/${encodedKey}?X-Amz-Expires=${expires}&x-id=${method === 'GET' ? 'GetObject' : 'PutObject'}`,
    service: 's3',
    region: S3_CONFIG.region,
    method,
    signQuery: true,
  };

  aws4.sign(opts, {
    accessKeyId: S3_CONFIG.accessKeyId,
    secretAccessKey: S3_CONFIG.secretAccessKey,
  });

  return `https://${host}${opts.path}`;
}

async function getPresignedUrl(key, expires = 3600) {
  logger.info(`S3 presigned URL (expires in ${expires}s)`);
  logger.debug(`S3 presigned URL key: ${key}`);

  try {
    return _ks3PresignedUrl('GET', key, expires);
  } catch (error) {
    logger.error(`Failed to generate presigned URL: ${error.message}`);
    throw error;
  }
}

async function getPresignedUploadUrl(key, expires = 600) {
  logger.info(`S3 presigned PUT URL (expires in ${expires}s)`);
  logger.debug(`S3 presigned PUT URL key: ${key}`);

  try {
    return _ks3PresignedUrl('PUT', key, expires);
  } catch (error) {
    logger.error(`Failed to generate presigned PUT URL: ${error.message}`);
    throw error;
  }
}

// ------------------------------------------------------------
// List / Delete / Bucket checks
// ------------------------------------------------------------

async function listFiles() {
  logger.info('S3 list objects');

  try {
    const command = new ListObjectsV2Command({
      Bucket: S3_CONFIG.bucket,
    });

    const data = await client.send(command);
    const files = data.Contents || [];

    return files.map((file) => ({
      key: file.Key,
      size: file.Size,
      lastModified: file.LastModified,
    }));
  } catch (error) {
    logger.error(`Failed to list files from S3: ${error.message}`);
    throw error;
  }
}

async function deleteFile(key) {
  logger.info('S3 delete');
  logger.debug(`S3 delete key: ${key}`);

  try {
    const command = new DeleteObjectCommand({
      Bucket: S3_CONFIG.bucket,
      Key: key,
    });

    await client.send(command);
    return true;
  } catch (error) {
    logger.error(`Failed to delete from S3: ${error.message}`);
    throw error;
  }
}

async function checkBucket() {
  logger.info('S3 check bucket');

  try {
    const command = new HeadBucketCommand({
      Bucket: S3_CONFIG.bucket,
    });

    await client.send(command);
    logger.info(`S3 bucket accessible: ${S3_CONFIG.bucket}`);
    return true;
  } catch (error) {
    logger.error(`S3 bucket not accessible: ${error.message}`);
    return false;
  }
}

async function ensureBucketCors() {
  logger.info('S3 ensure bucket CORS');

  try {
    const command = new PutBucketCorsCommand({
      Bucket: S3_CONFIG.bucket,
      CORSConfiguration: {
        CORSRules: [
          {
            AllowedOrigins: ['*'],
            AllowedMethods: ['PUT', 'GET', 'HEAD'],
            AllowedHeaders: ['*'],
            ExposeHeaders: ['ETag', 'Content-Length', 'Content-Type'],
            MaxAgeSeconds: 3600,
          },
        ],
      },
    });

    await client.send(command);
    logger.info('S3 bucket CORS configured');
    return true;
  } catch (error) {
    logger.warn(`S3 bucket CORS config failed (non-fatal): ${error.message}`);
    return false;
  }
}

module.exports = {
  saveFile,
  getFile,
  getFileStream,
  getPresignedUrl,
  getPresignedUploadUrl,
  ensureBucketCors,
  deleteFile,
  checkBucket,
  getBucket,
  getRegion,
};
