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
  try {
    // P3-49: storage_key (path в бакете) не логируем на info — только на debug.
    logger.info(`KS3 upload: ${body.length} bytes, ${mimeType}`);
    logger.debug(`KS3 upload key: ${key}`);

    await new Promise((resolve, reject) => {
      client.object.put(
        {
          Bucket: KS3_CONFIG.bucket,
          Key: key,
          Body: body,
          // Передаём MIME-тип — KS3 сохранит его в Content-Type объекта.
          // Для HTML это обеспечит отображение в браузере по подписанной ссылке.
          ContentType: mimeType,
        },
        (err, data, response) => {
          if (err) {
            logger.error(`KS3 upload error: ${err}`);
            reject(err);
          } else {
            logger.debug(`KS3 upload success: ${key}`);
            resolve(data);
          }
        }
      );
    });

    return {
      key,
      bucket: KS3_CONFIG.bucket,
      region: KS3_CONFIG.region,
      size: body.length,
      mimeType,
    };
  } catch (error) {
    logger.error(`Failed to upload to KS3: ${error.message}`);
    throw error;
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

    const data = await new Promise((resolve, reject) => {
      client.object.get(
        {
          Bucket: KS3_CONFIG.bucket,
          Key: key,
        },
        (err, data, response) => {
          if (err) {
            logger.error(`KS3 download error: ${err}`);
            reject(err);
          } else {
            resolve(data);
          }
        }
      );
    });

    return { key, data };
  } catch (error) {
    logger.error(`Failed to download from KS3: ${error.message}`);
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

    const url = await new Promise((resolve, reject) => {
      client.object.generatePresignedUrl(
        {
          Bucket: KS3_CONFIG.bucket,
          Key: key,
          Expires: expires,
        },
        (err, data, response) => {
          if (err) {
            logger.error(`KS3 presigned URL error: ${err}`);
            reject(err);
          } else {
            resolve(data);
          }
        }
      );
    });

    return url;
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

    const data = await new Promise((resolve, reject) => {
      client.bucket.get(
        {
          Bucket: KS3_CONFIG.bucket,
        },
        (err, data, response) => {
          if (err) {
            logger.error(`KS3 list error: ${err}`);
            reject(err);
          } else {
            resolve(data);
          }
        }
      );
    });

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

    await new Promise((resolve, reject) => {
      client.object.delete(
        {
          Bucket: KS3_CONFIG.bucket,
          Key: key,
        },
        (err, data, response) => {
          if (err) {
            logger.error(`KS3 delete error: ${err}`);
            reject(err);
          } else {
            resolve(data);
          }
        }
      );
    });

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

    await new Promise((resolve, reject) => {
      client.bucket.getACL(
        {
          Bucket: KS3_CONFIG.bucket,
        },
        (err, data, response) => {
          if (err) {
            logger.error(`KS3 bucket check error: ${err}`);
            reject(err);
          } else {
            logger.info(`KS3 bucket accessible: ${KS3_CONFIG.bucket}`);
            resolve(data);
          }
        }
      );
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
  deleteFile,
  checkBucket,
  // Геттеры вместо экспорта client/KS3_CONFIG (не раскрываем секреты)
  getBucket,
  getRegion,
};
