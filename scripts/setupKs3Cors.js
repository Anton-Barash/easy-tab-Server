// ============================================================
// setupKs3Cors.js — одноразовая настройка CORS на KS3-бакете.
//
// Проблема: Flutter web (CanvasKit renderer) грузит изображения через
// <img crossOrigin="anonymous">. Без Access-Control-Allow-Origin от KS3
// браузер блокирует загрузку с net::ERR_FAILED.
//
// Решение: настроить CORS rule на бакете:
//   AllowedOrigin: * (в prod — конкретные домены)
//   AllowedMethod: GET
//   AllowedHeader: *
//
// Запуск: node scripts/setupKs3Cors.js
// ============================================================

require('dotenv').config();
const KS3 = require('ks3');

function _requireEnv(name) {
  const value = process.env[name];
  if (!value || value.trim() === '') {
    console.error(`KS3: обязательная переменная ${name} не задана`);
    process.exit(1);
  }
  return value.trim();
}

const accessKeyId = _requireEnv('KS3_ACCESS_KEY');
const accessKeySecret = _requireEnv('KS3_SECRET_KEY');
const bucket = process.env.KS3_BUCKET || 'ew-ks3';
const region = process.env.KS3_REGION || 'GUANGZHOU';

// В production ограничиваем origins конкретными доменами из env.
const allowedOrigins = process.env.CORS_ALLOWED_ORIGINS
  ? process.env.CORS_ALLOWED_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean)
  : ['*'];

const client = new KS3(accessKeyId, accessKeySecret, bucket, region);

const corsRules = {
  allowedMethod: 'GET',
  allowedOrigin: allowedOrigins,
  allowedHeader: ['*'],
  maxAgeSeconds: '3600',
  exposeHeader: ['ETag', 'Content-Length', 'Content-Type'],
};

console.log(`Настраиваю CORS на бакете ${bucket} (${region})...`);
console.log(`AllowedOrigins: ${allowedOrigins.join(', ')}`);

// 1. Сначала читаем текущие CORS-правила (для информации).
client.bucket.getBucketCors({ Bucket: bucket }, (errGet, dataGet) => {
  if (errGet) {
    console.log(`Текущие CORS-правила: отсутствуют или ошибка чтения (${errGet.message || errGet})`);
  } else {
    console.log(`Текущие CORS-правила: ${JSON.stringify(dataGet).slice(0, 200)}`);
  }

  // 2. Применяем новые правила.
  client.bucket.putBucketCors({ Bucket: bucket, Rules: corsRules }, (errPut, dataPut) => {
    if (errPut) {
      console.error('ОШИБКА при установке CORS:', errPut.message || errPut);
      process.exit(1);
    }
    console.log('CORS успешно настроены:', JSON.stringify(dataPut || 'OK'));
    console.log('Готово. Изображения с KS3 теперь должны грузиться в браузере (CanvasKit).');
    process.exit(0);
  });
});
