// ============================================================
// KS3 Storage — сервис хранилища Kingsoft Cloud (KS3)
//
// Обёртка над KS3 SDK для загрузки/скачивания/удаления файлов.
// Ключ объекта: files/{UUID}/{очищенное_имя}
//
// Все файлы хранятся в приватном бакете.
// Доступ — только через подписанные URL (presigned URLs).
//
// БЕЗОПАСНОСТЬ: ключи KS3 берутся ТОЛЬКО из env-переменных.
// Хардкод отсутствует — в production сервер упадёт при запуске
// без KS3_ACCESS_KEY/KS3_SECRET_KEY.
// ============================================================

const KS3 = require('ks3');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Readable } = require('stream');
const logger = require('../utils/logger');

// ------------------------------------------------------------
// Конфигурация KS3 — только из env, без хардкода.
// Если переменные не заданы — выбрасываем ошибку сразу
// (fail-fast), чтобы не запускать сервер без секретов.
// ------------------------------------------------------------

function _requireEnv(name) {
  const value = process.env[name];
  if (!value || value.trim() === '') {
    throw new Error(
      `KS3: обязательная переменная окружения ${name} не задана. ` +
      `Установите её в .env (dev) или ecosystem.config.js (production).`
    );
  }
  return value.trim();
}

// P0-1: bucket и region теперь обязательные — без них приложение не должно
// стартовать, т.к. fallback-значения ('ew-ks3', 'GUANGZHOU') могут указывать
// на чужой/несуществующий бакет и приводить к утечке данных.
const KS3_CONFIG = {
  accessKeyId: _requireEnv('KS3_ACCESS_KEY'),
  accessKeySecret: _requireEnv('KS3_SECRET_KEY'),
  bucket: _requireEnv('KS3_BUCKET'),
  region: _requireEnv('KS3_REGION'),
};

// Создаём KS3-клиент один раз при загрузке модуля
const client = new KS3(
  KS3_CONFIG.accessKeyId,
  KS3_CONFIG.accessKeySecret,
  KS3_CONFIG.bucket,
  KS3_CONFIG.region
);

// ------------------------------------------------------------
// Геттеры для конфигурации (вместо экспорта объекта с ключами).
// Возвращают только безопасные поля (bucket, region) —
// ключи наружу не отдаются.
// ------------------------------------------------------------

/**
 * Получить имя бакета KS3.
 * @returns {string}
 */
function getBucket() {
  return KS3_CONFIG.bucket;
}

/**
 * Получить регион KS3.
 * @returns {string}
 */
function getRegion() {
  return KS3_CONFIG.region;
}

// ------------------------------------------------------------
// Внутренняя утилита: обёрнуть callback-style вызов KS3 SDK в Promise.
//
// До рефакторинга один и тот же шаблон
//   new Promise((resolve, reject) => client.X.method(params, (err, data) => {...}))
// дублировался в getFile/getPresignedUrl/listFiles/deleteFile/checkBucket.
// Универсальная обёртка убирает дублирование и единообразно логирует ошибки.
//
// Не применяется в _saveFileOnce: там особая диагностика ошибок
// (allKeys/fullError inspect) и таймаут через Promise.race — это намеренно.
// ------------------------------------------------------------

/**
 * Вызвать callback-style метод KS3 SDK и вернуть Promise.
 *
 * @param {string} label - человекочитаемая метка для логов (например 'download')
 * @param {(cb: function) => void} invoke - функция, принимающая node-callback
 *        и выполняющая вызов SDK (например cb => client.object.get(params, cb))
 * @returns {Promise<*>} данные, возвращённые SDK
 */
function _ks3Callback(label, invoke) {
  return new Promise((resolve, reject) => {
    invoke((err, data) => {
      if (err) {
        // Расширенная диагностика: KS3 возвращает code/statusCode/body(XML).
        // Раньше это логирование было только в getFile, теперь единообразно
        // во всех callback-вызовах — улучшает отладку delete/list/presigned URL.
        const errInfo = {
          message: err && err.message ? err.message : 'unknown',
          code: err && err.code ? err.code : null,
          statusCode: err && err.statusCode ? err.statusCode : null,
          body: err && err.body ? String(err.body).substring(0, 200) : null,
        };
        logger.error(`KS3 ${label} error: ${JSON.stringify(errInfo)}`);
        reject(err);
      } else {
        resolve(data);
      }
    });
  });
}

/**
 * Загрузить файл в KS3.
 *
 * @param {string} key - ключ объекта (например "files/abc-123/report.html")
 * @param {Buffer} body - содержимое файла
 * @param {string} [mimeType='application/octet-stream'] - MIME-тип файла.
 *        Важно для HTML: text/html заставит браузер отобразить страницу.
 * @returns {Promise<object>} информация о загруженном файле
 */
async function saveFile(key, body, mimeType = 'application/octet-stream') {
  // P3-49: storage_key (path в бакете) не логируем на info — только на debug.
  logger.info(`KS3 upload: ${body.length} bytes, ${mimeType}`);
  logger.debug(`KS3 upload key: ${key}`);

  // P3-53: Retry-логика для временных сетевых ошибок (ECONNRESET, ENOTFOUND, timeout).
  // KS3 из некоторых регионов нестабилен — наблюдались ECONNRESET через ~100s
  // и ENOTFOUND при DNS-сбоях. Повторяем до 3 раз с нарастающей задержкой.
  const maxRetries = 3;
  let lastError;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const result = await _saveFileOnce(key, body, mimeType);
      return result;
    } catch (error) {
      lastError = error;
      const errCode = error && error.code;
      const errMsg = error && error.message ? error.message : String(error);
      const isRetryable =
        errCode === 'ECONNRESET' ||
        errCode === 'ENOTFOUND' ||
        errCode === 'ETIMEDOUT' ||
        errMsg.includes('timeout');

      if (isRetryable && attempt < maxRetries) {
        const delayMs = attempt * 2000;
        logger.warn(`KS3 upload failed (attempt ${attempt}/${maxRetries}), retrying in ${delayMs}ms: ${errMsg}`);
        await new Promise(resolve => setTimeout(resolve, delayMs));
        continue;
      }

      logger.error(`Failed to upload to KS3 after ${attempt} attempt(s): ${errMsg}`);
      throw error;
    }
  }

  throw lastError;
}

/**
 * Одна попытка загрузки файла в KS3.
 * Создаёт временный файл, загружает через SDK, удаляет временный файл.
 */
async function _saveFileOnce(key, body, mimeType) {
  let tmpFile = null;
  try {
    // KS3 SDK копирует Buffer в память при вычислении CRC64 (WebAssembly),
    // что приводит к OOM для файлов > ~15 MB. Сохраняем тело во временный файл
    // и передаём путь — SDK тогда использует поток и считает CRC по чанкам.
    tmpFile = path.join(os.tmpdir(), `ks3-upload-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await fs.promises.writeFile(tmpFile, body);

    const uploadPromise = new Promise((resolve, reject) => {
      logger.info(`KS3 upload starting for key: ${key}`);
      client.object.put(
        {
          Bucket: KS3_CONFIG.bucket,
          Key: key,
          FilePath: tmpFile,
          ContentType: mimeType,
        },
        (err, data, response) => {
          logger.info(`KS3 upload callback received for key: ${key}, err=${!!err}`);
          if (err) {
            const util = require('util');
            const errInfo = {
              message: err && err.message ? err.message : 'unknown',
              code: err && err.code ? err.code : null,
              statusCode: err && err.statusCode ? err.statusCode : (response && response.statusCode),
              body: err && err.body ? String(err.body).substring(0, 500) : null,
              requestId: err && err.requestId ? err.requestId : (response && response.headers && response.headers['x-kss-request-id']),
              allKeys: Object.keys(err),
              fullError: util.inspect(err, { depth: 3, showHidden: true }),
            };
            logger.error(`KS3 upload error for key "${key}": ${JSON.stringify(errInfo)}`);
            reject(err);
          } else {
            logger.debug(`KS3 upload success: ${key}`);
            resolve(data);
          }
        }
      );
    });

    // P3-50: KS3 из некоторых регионов загружает большие файлы медленно
    // (наблюдалось ~80s для 9.5 MB). Таймаут вычисляем по размеру:
    // минимум 120s + 1s на каждые 100 KB, но не менее 300s для файлов > 5 MB.
    const sizeBasedTimeout = Math.max(120000, Math.ceil(body.length / 100000) * 1000);
    const uploadTimeout = body.length > 5 * 1024 * 1024 ? 300000 : sizeBasedTimeout;

    logger.info(`KS3 upload timeout set to ${uploadTimeout}ms for key: ${key}`);

    const timeoutPromise = new Promise((_, reject) => {
      setTimeout(() => {
        reject(new Error(`KS3 upload timeout after ${uploadTimeout}ms for key ${key}`));
      }, uploadTimeout);
    });

    await Promise.race([uploadPromise, timeoutPromise]);

    return {
      key,
      bucket: KS3_CONFIG.bucket,
      region: KS3_CONFIG.region,
      size: body.length,
      mimeType,
    };
  } finally {
    if (tmpFile) {
      try {
        await fs.promises.unlink(tmpFile);
      } catch (unlinkErr) {
        logger.warn(`Failed to remove temp file ${tmpFile}: ${unlinkErr.message}`);
      }
    }
  }
}

/**
 * Скачать файл из KS3 (возвращает содержимое).
 * Используется сервером, когда нужно прочитать файл (например, для отдачи напрямую).
 *
 * @param {string} key - ключ объекта в KS3
 * @returns {Promise<{key: string, data: Buffer}>}
 */
async function getFile(key) {
  try {
    // P3-49: storage_key не логируем на info — только на debug.
    logger.info('KS3 download');
    logger.debug(`KS3 download key: ${key}`);

    const data = await _ks3Callback('download', (cb) =>
      client.object.get({ Bucket: KS3_CONFIG.bucket, Key: key }, cb)
    );

    return { key, data };
  } catch (error) {
    logger.error(`Failed to download from KS3: ${error.message}`);
    throw error;
  }
}

/**
 * Получить поток файла из KS3 с поддержкой Range-запросов.
 *
 * Использует presigned URL + fetch(), чтобы браузер мог запрашивать
 * видео по частям (HTTP Range) через наш прокси.
 *
 * @param {string} key - ключ объекта в KS3
 * @param {string|null} range - HTTP Range header, например "bytes=0-1048575"
 * @returns {Promise<{stream: Readable, status: number, headers: object}>}
 */
async function getFileStream(key, range = null) {
  try {
    logger.info(`KS3 download stream: range=${range || 'none'}`);
    logger.debug(`KS3 download stream key: ${key}`);

    const url = await getPresignedUrl(key, 300);
    const fetchHeaders = {};
    if (range) {
      fetchHeaders.Range = range;
    }

    const response = await fetch(url, { headers: fetchHeaders });
    if (!response.ok && response.status !== 206) {
      const body = await response.text().catch(() => '');
      throw new Error(`KS3 stream error: ${response.status} ${response.statusText} ${body.substring(0, 200)}`);
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
    logger.error(`Failed to stream from KS3: ${error.message}`);
    throw error;
  }
}

/**
 * Сгенерировать подписанный URL для скачивания/просмотра файла.
 *
 * URL действует ограниченное время (по умолчанию 1 час).
 * По этому URL можно скачать или открыть файл напрямую из KS3,
 * не проходя через сервер.
 *
 * Для inline-файлов (HTML) браузер откроет страницу,
 * для остальных — предложит скачивание.
 *
 * @param {string} key - ключ объекта в KS3
 * @param {number} [expires=3600] - время жизни URL в секундах
 * @returns {Promise<string>} подписанный URL
 */
async function getPresignedUrl(key, expires = 3600) {
  try {
    // P3-49: storage_key не логируем на info — только на debug.
    logger.info(`KS3 presigned URL (expires in ${expires}s)`);
    logger.debug(`KS3 presigned URL key: ${key}`);

    const url = await _ks3Callback('presigned URL', (cb) =>
      client.object.generatePresignedUrl(
        { Bucket: KS3_CONFIG.bucket, Key: key, Expires: expires },
        cb
      )
    );

    // KS3 SDK генерирует http:// URL, но CSP требует https://
    return url ? url.replace(/^http:\/\//, 'https://') : url;
  } catch (error) {
    logger.error(`Failed to generate presigned URL: ${error.message}`);
    throw error;
  }
}

/**
 * Получить список всех объектов в бакете.
 * Используется для администрирования, не для обычных запросов.
 *
 * @returns {Promise<Array<{key: string, size: number, lastModified: string}>>}
 */
async function listFiles() {
  try {
    logger.info('KS3 list objects');

    const data = await _ks3Callback('list', (cb) =>
      client.bucket.get({ Bucket: KS3_CONFIG.bucket }, cb)
    );

    // Парсим XML-ответ KS3 SDK
    const files = data.Contents || [];
    return files.map((file) => ({
      key: file.Key,
      size: file.Size,
      lastModified: file.LastModified,
    }));
  } catch (error) {
    logger.error(`Failed to list files from KS3: ${error.message}`);
    throw error;
  }
}

/**
 * Удалить файл из KS3.
 * Вызывается при удалении файла владельцем (см. files.txt п.6).
 *
 * @param {string} key - ключ объекта в KS3
 * @returns {Promise<boolean>} true при успехе
 */
async function deleteFile(key) {
  try {
    // P3-49: storage_key не логируем на info — только на debug.
    logger.info('KS3 delete');
    logger.debug(`KS3 delete key: ${key}`);

    // P3-55: KS3 SDK экспортирует метод удаления как `del`, а НЕ `delete`
    // (см. node_modules/ks3/lib/api/object.js: `del: del`).
    // Раньше здесь вызывался несуществующий client.object.delete —
    // удаление из KS3 молча падало (non-fatal в fileService), и все
    // "удалённые" файлы оставались в бакете навсегда (orphan objects).
    await _ks3Callback('delete', (cb) =>
      client.object.del({ Bucket: KS3_CONFIG.bucket, Key: key }, cb)
    );

    return true;
  } catch (error) {
    logger.error(`Failed to delete from KS3: ${error.message}`);
    throw error;
  }
}

/**
 * Проверить доступность бакета KS3.
 * Используется в health-check эндпоинтах.
 *
 * @returns {Promise<boolean>} true, если бакет доступен
 */
async function checkBucket() {
  try {
    logger.info('KS3 check bucket');

    await _ks3Callback('bucket check', (cb) =>
      client.bucket.getACL({ Bucket: KS3_CONFIG.bucket }, cb)
    );
    logger.info(`KS3 bucket accessible: ${KS3_CONFIG.bucket}`);

    return true;
  } catch (error) {
    logger.error(`KS3 bucket not accessible: ${error.message}`);
    return false;
  }
}

// ------------------------------------------------------------
// Presigned upload URL — прямая загрузка из браузера в KS3.
//
// Сервер генерирует подписанный PUT URL, браузер грузит файл напрямую
// в KS3, минуя сервер. Это убирает фазу "Обработка..." (сервер→KS3)
// и ускоряет загрузку примерно в 2 раза.
//
// Требует CORS на бакете (см. ensureBucketCors).
// ------------------------------------------------------------

/**
 * Сгенерировать подписанный URL для прямой загрузки (PUT) в KS3.
 *
 * @param {string} key - ключ объекта в KS3
 * @param {number} [expires=600] - время жизни URL в секундах (10 мин по умолчанию)
 * @returns {Promise<string>} подписанный PUT URL
 */
async function getPresignedUploadUrl(key, expires = 600) {
  try {
    logger.info(`KS3 presigned PUT URL (expires in ${expires}s)`);
    logger.debug(`KS3 presigned PUT URL key: ${key}`);

    const url = await _ks3Callback('presigned PUT URL', (cb) =>
      client.object.generatePresignedUrl(
        {
          Bucket: KS3_CONFIG.bucket,
          Key: key,
          Method: 'PUT',
          Expires: expires,
        },
        cb
      )
    );

    // KS3 SDK генерирует http:// URL, но CSP/CORS требуют https://
    return url ? url.replace(/^http:\/\//, 'https://') : url;
  } catch (error) {
    logger.error(`Failed to generate presigned PUT URL: ${error.message}`);
    throw error;
  }
}

/**
 * Настроить CORS на бакете KS3 для прямой загрузки из браузера.
 *
 * Разрешает PUT/GET/HEAD из любого origin с любыми заголовками.
 * Вызывается один раз при старте сервера.
 *
 * @returns {Promise<boolean>} true при успехе
 */
async function ensureBucketCors() {
  try {
    logger.info('KS3 ensure bucket CORS');

    const corsRules = [
      {
        AllowedOrigin: ['*'],
        AllowedMethod: ['PUT', 'GET', 'HEAD'],
        AllowedHeader: ['*'],
        ExposeHeader: ['ETag', 'Content-Length', 'Content-Type'],
        MaxAgeSeconds: 3600,
      },
    ];

    await _ks3Callback('putBucketCors', (cb) =>
      client.bucket.putBucketCors(
        { Bucket: KS3_CONFIG.bucket, Rules: corsRules },
        cb
      )
    );

    logger.info('KS3 bucket CORS configured');
    return true;
  } catch (error) {
    logger.warn(`KS3 bucket CORS config failed (non-fatal): ${error.message}`);
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
  // Геттеры вместо экспорта client/KS3_CONFIG (не раскрываем секреты)
  getBucket,
  getRegion,
};
