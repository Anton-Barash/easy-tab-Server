// ============================================================
// Database Routes — эндпоинты администрирования БД
//
// БЕЗОПАСНОСТЬ: все эндпоинты защищены requireAuth (H-07).
// В production рекомендуется дополнительно проверять admin-роль.
// /database/check НЕ возвращает конфигурацию подключения
// (host/port/user) — только статус подключения.
// ============================================================

const { requireAuth } = require('../middleware/authMiddleware');
const databaseController = require('../controllers/databaseController');

async function databaseRoutes(fastify) {
  // Проверка подключения к БД (без раскрытия конфигурации)
  fastify.get('/check', { preHandler: requireAuth }, databaseController.checkConnection);

  // Версия PostgreSQL
  fastify.get('/version', { preHandler: requireAuth }, databaseController.getVersion);

  // Список таблиц
  fastify.get('/tables', { preHandler: requireAuth }, databaseController.listTables);
}

module.exports = databaseRoutes;
