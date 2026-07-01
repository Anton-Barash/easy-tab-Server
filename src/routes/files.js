const filesController = require('../controllers/filesController');
const ks3Storage = require('../services/ks3Storage');

async function filesRoutes(fastify) {
  // Загрузка файла
  fastify.post('/upload', filesController.uploadFile);

  // Скачивание файла
  fastify.get('/download/:filename', filesController.downloadFile);

  // Список файлов
  fastify.get('/list', filesController.listFiles);

  // KS3 test endpoint - check bucket accessibility
  fastify.get('/ks3/check', async (request, reply) => {
    try {
      const isAccessible = await ks3Storage.checkBucket();
      return reply.send({
        success: isAccessible,
        bucket: ks3Storage.KS3_CONFIG.bucket,
        region: ks3Storage.KS3_CONFIG.region,
        message: isAccessible ? 'KS3 bucket is accessible' : 'KS3 bucket not accessible',
      });
    } catch (error) {
      return reply.status(500).send({ error: error.message });
    }
  });

  // KS3 test endpoint - generate presigned URL
  fastify.post('/ks3/presigned-url', async (request, reply) => {
    try {
      const { key, expires } = request.body;
      if (!key) {
        return reply.status(400).send({ error: 'Key is required' });
      }
      const url = await ks3Storage.getPresignedUrl(key, expires || 3600);
      return reply.send({
        success: true,
        url,
        key,
        expires: expires || 3600,
      });
    } catch (error) {
      return reply.status(500).send({ error: error.message });
    }
  });
}

module.exports = filesRoutes;
