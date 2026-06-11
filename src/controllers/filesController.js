const storageService = require('../services/storageService');

async function uploadFile(request, reply) {
  try {
    const data = await request.file();

    if (!data) {
      return reply.status(400).send({ error: 'No file uploaded' });
    }

    const buffer = await data.toBuffer();
    const result = await storageService.saveFile(
      data.filename,
      buffer,
      data.mimetype
    );

    return reply.status(201).send({
      message: 'File uploaded successfully',
      file: result,
    });
  } catch (err) {
    request.log.error(err);
    return reply.status(500).send({ error: 'Upload failed' });
  }
}

async function downloadFile(request, reply) {
  try {
    const { filename } = request.params;
    const result = await storageService.getFile(filename);

    if (!result) {
      return reply.status(404).send({ error: 'File not found' });
    }

    return reply
      .header('Content-Disposition', `attachment; filename="${filename}"`)
      .send(result.data);
  } catch (err) {
    request.log.error(err);
    return reply.status(500).send({ error: 'Download failed' });
  }
}

async function listFiles(request, reply) {
  try {
    const files = await storageService.listFiles();
    return reply.send({ files, count: files.length });
  } catch (err) {
    request.log.error(err);
    return reply.status(500).send({ error: 'Failed to list files' });
  }
}

module.exports = {
  uploadFile,
  downloadFile,
  listFiles,
};
