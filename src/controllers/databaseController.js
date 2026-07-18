// ============================================================
// Database Controller — обработчики запросов администрирования БД
//
// БЕЗОПАСНОСТЬ:
// - Не возвращаем конфигурацию подключения (host/port/user) наружу (H-07).
// - Внутренние ошибки фильтруем — не раскрываем схему БД (M-27).
// ============================================================

const databaseService = require('../services/databaseService');

/**
 * Проверка статуса подключения к БД.
 * Возвращает только connected: true/false, без деталей конфигурации.
 */
async function checkConnection(request, reply) {
  try {
    const result = await databaseService.checkConnection();

    if (result.connected) {
      return reply.send({
        success: true,
        message: 'Database connection successful',
        timestamp: result.timestamp,
        // НЕ возвращаем result.config — это раскрывает host/user/port
      });
    } else {
      return reply.status(503).send({
        success: false,
        message: 'Database connection failed',
      });
    }
  } catch (error) {
    request.log.error(error);
    return reply.status(500).send({
      success: false,
      error: 'Database check failed',
    });
  }
}

/**
 * Получить версию PostgreSQL.
 */
async function getVersion(request, reply) {
  try {
    const version = await databaseService.getVersion();
    return reply.send({
      success: true,
      version,
    });
  } catch (error) {
    request.log.error(error);
    return reply.status(500).send({
      success: false,
      error: 'Failed to get database version',
    });
  }
}

/**
 * Список всех таблиц (для администрирования).
 */
async function listTables(request, reply) {
  try {
    const tables = await databaseService.listTables();
    return reply.send({
      success: true,
      count: tables.length,
      tables,
    });
  } catch (error) {
    request.log.error(error);
    return reply.status(500).send({
      success: false,
      error: 'Failed to list tables',
    });
  }
}

module.exports = {
  checkConnection,
  getVersion,
  listTables,
};
