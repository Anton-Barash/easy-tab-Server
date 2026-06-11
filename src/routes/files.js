const filesController = require('../controllers/filesController');

async function filesRoutes(fastify) {
  // Загрузка файла
  fastify.post('/upload', filesController.uploadFile);

  // Скачивание файла
  fastify.get('/download/:filename', filesController.downloadFile);

  // Список файлов
  fastify.get('/list', filesController.listFiles);
}

module.exports = filesRoutes;
