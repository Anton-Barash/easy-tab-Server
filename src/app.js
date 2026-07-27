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
const cookie = require('@fastify/cookie');
const path = require('path');
const config = require('./config');
const errorHandler = require('./middleware/errorHandler');
const requestLogger = require('./middleware/requestLogger');
const registerRoutes = require('./routes');
const viewRoutes = require('./routes/view');

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

  // Регистрация cookie плагина для чтения auth_token cookie
  app.register(cookie, {
    secret: process.env.JWT_SECRET || 'default-secret', // для подписанных cookie (не используется, но требуется)
  });

  // M-12: Security headers через helmet.
  // CSP разрешает:
  //   - inline-изображения (data:) — используется в inline-file serving
  //   - inline-стили ('unsafe-inline') — для /view/report HTML с inline <style>
  //   - inline-скрипты ('unsafe-inline') — для /view/report HTML с inline <script>
  app.register(helmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'", 'https://*.gstatic.com'],
        imgSrc: ["'self'", 'data:', 'blob:', 'http://localhost:8000', 'https://localhost:8000', 'https://*.gstatic.com', 'https://*.ksyuncs.com'],
        scriptSrc: ["'self'", "'unsafe-inline'", "'unsafe-eval'", 'https://*.gstatic.com'],
        scriptSrcAttr: ["'unsafe-inline'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        styleSrcAttr: ["'unsafe-inline'"],
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
        frameAncestors: ["'none'"],
        workerSrc: ["'self'", 'blob:', 'https://*.gstatic.com'],
        childSrc: ["'self'", 'blob:', 'https://*.gstatic.com'],
        fontSrc: ["'self'", 'data:', 'https://*.gstatic.com'],
        connectSrc: ["'self'", 'http://localhost:8000', 'https://localhost:8000', 'https://*.gstatic.com', 'https://*.ksyuncs.com'],
        mediaSrc: ["'self'", 'http://localhost:8000', 'https://localhost:8000', 'https://*.gstatic.com', 'https://*.ksyuncs.com'],
        manifestSrc: ["'self'"],
      },
    },
    crossOriginResourcePolicy: false,
    crossOriginOpenerPolicy: false,
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
    credentials: true, // Разрешаем cookies для кросс-доменных запросов (iframe)
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

  // Регистрация view routes (для просмотра HTML отчётов)
  app.register(viewRoutes, { prefix: '/view' });

  app.register(require('@fastify/static'), {
    root: path.join(__dirname, '../web'),
    prefix: '/',
    schemaHide: true,
    wildcard: false,
});

app.setNotFoundHandler({ prefix: '/' }, (request, reply) => {
    const accept = request.headers.accept || '';
    if (accept.includes('text/html')) {
        reply.sendFile('index.html', path.join(__dirname, '../web'));
    } else {
        reply.status(404).send({ success: false, error: 'Not found' });
    }
});

return app;
}

module.exports = buildApp;
