const viewController = require('../controllers/viewController');
const { optionalAuth } = require('../middleware/authMiddleware');

// ============================================================
// Маршруты для просмотра HTML-отчётов через серверный прокси.
//
// Регистрируется в app.js с prefix: '/view'.
//
// Эндпоинты:
//   GET /view/report/:id          — HTML отчёта (проверка доступа)
//   GET /view/report/:id/files/*  — файлы отчёта (изображения, видео)
//
// Внимание: НЕ оборачиваем в fastify-plugin (fp). При использовании fp
// с опцией prefix маршруты регистрируются в родительском контексте
// без префикса, что приводит к 404.
// ============================================================

async function viewRoutes(fastify) {
  // GET /view/report/:id — просмотр HTML отчёта
  // Авторизация опциональна: для публичных отчётов не требуется
  // CSP убирается глобальным onSend hook в app.js (для всех /view/* URL)
  fastify.get('/report/:id', {
    preHandler: optionalAuth,
    handler: viewController.viewReport,
  });

  // GET /view/report/:id/files/* — проксирование файлов отчёта
  fastify.get('/report/:id/files/*', {
    preHandler: optionalAuth,
    handler: viewController.viewReportFile,
  });

  // GET /view/report/:id/thumbnails/* — миниатюры изображений
  fastify.get('/report/:id/thumbnails/*', {
    preHandler: optionalAuth,
    handler: viewController.viewReportThumbnail,
  });
}

module.exports = viewRoutes;
