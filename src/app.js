// ============================================================
// buildApp — фабрика Fastify-приложения
//
// БЕЗОПАСНОСТЬ (H-08, M-13, H-45, H-09, M-12):
// - CORS: whitelist доменов вместо origin: true.
// - credentials убран (auth через Bearer, не куки).
// - trustProxy: true для корректного request.ip за nginx/PM2.
// - Helmet: security headers (CSP, X-Frame-Options, HSTS и т.д.).
// - Rate limiting: глобальный + строгий для /auth/login и /auth/register.
// ============================================================

const fastify = require('fastify');
const cors = require('@fastify/cors');
const helmet = require('@fastify/helmet');
const rateLimit = require('@fastify/rate-limit');
const multipart = require('@fastify/multipart');
const config = require('./config');
const errorHandler = require('./middleware/errorHandler');
const requestLogger = require('./middleware/requestLogger');
const registerRoutes = require('./routes');

// ------------------------------------------------------------
// Whitelist разрешённых источников для CORS.
// В development — localhost на любых портах.
// В production — конкретные домены из env CORS_ALLOWED_ORIGINS.
// ------------------------------------------------------------

const PROD_ALLOWED_ORIGINS = (process.env.CORS_ALLOWED_ORIGINS || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

function isOriginAllowed(origin) {
  if (!origin) return true; // same-origin / non-browser requests
  if (config.env !== 'production') {
    // В dev разрешаем любой localhost
    return /^https?:\/\/localhost(:\d+)?$/.test(origin);
  }
  return PROD_ALLOWED_ORIGINS.includes(origin);
}

function buildApp() {
  const app = fastify({
    logger: config.logger,
    // trustProxy: корректный request.ip за обратным прокси (nginx/PM2)
    trustProxy: true,
    // M-31: ограничение размера JSON-тела (10MB) — защита от огромных payload.
    // Multipart-загрузки регулируются отдельно через @fastify/multipart limits.
    bodyLimit: 10 * 1024 * 1024,
  });

  // Регистрация middleware
  errorHandler(app);
  requestLogger(app);

  // M-12: Security headers через helmet.
  // CSP разрешает inline-изображения (data:) — используется в inline-file serving.
  app.register(helmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        imgSrc: ["'self'", 'data:'],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'"],
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
        frameAncestors: ["'none'"],
      },
    },
    // HSTS только в production (в dev нет HTTPS)
    hsts: config.env === 'production',
  });

  // H-09: Глобальный rate limit — 100 запросов/мин на IP.
  app.register(rateLimit, {
    global: true,
    max: 100,
    timeWindow: '1 minute',
    // Исключаем healthcheck из глобального лимита
    whitelist: (req) => req.url === '/health' || req.url === '/',
  });

  // Регистрация CORS с whitelist
  app.register(cors, {
    origin: (origin, cb) => {
      // P2-43: cb(null, false) вместо cb(new Error(...), false) —
      // ошибка в callback приводит к логированию и некорректному ответу.
      // false просто отклоняет origin без ошибки.
      if (isOriginAllowed(origin)) {
        cb(null, true);
      } else {
        cb(null, false);
      }
    },
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
    // credentials убран: auth через Authorization: Bearer, не куки (M-13)
  });

  app.register(multipart, {
    limits: {
      fileSize: config.maxFileSize,
      // P2-41: Дополнительные лимиты multipart-парсинга — защита от
      // resource exhaustion через множество полей/огромные имена.
      files: 1,        // только один файл за запрос
      fields: 10,      // максимум 10 текстовых полей
      fieldSize: 1024, // 1KB на текстовое поле
      fieldNameSize: 100, // 100 байт на имя поля
    },
  });

  // Регистрация routes
  app.register(registerRoutes);

  return app;
}

module.exports = buildApp;
