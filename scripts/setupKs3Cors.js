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
const { ensureBucketCors, getBucket, getRegion } = require('../src/services/s3Storage');

const bucket = getBucket();
const region = getRegion();

console.log(`Настраиваю CORS на бакете ${bucket} (${region})...`);

ensureBucketCors()
  .then(() => {
    console.log('CORS успешно настроены.');
    console.log('Готово. Изображения с KS3 теперь должны грузиться в браузере (CanvasKit).');
    process.exit(0);
  })
  .catch((err) => {
    console.error('ОШИБКА при установке CORS:', err.message || err);
    process.exit(1);
  });