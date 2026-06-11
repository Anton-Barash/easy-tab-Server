const localStorage = require('./localStorage');
const ks3Storage = require('./ks3Storage');
const config = require('../config');

function getStorage() {
  switch (config.storage) {
    case 'ks3':
      return ks3Storage;
    case 'local':
    default:
      return localStorage;
  }
}

module.exports = {
  saveFile: (filename, data, mimetype) => getStorage().saveFile(filename, data, mimetype),
  getFile: (filename) => getStorage().getFile(filename),
  listFiles: () => getStorage().listFiles(),
  deleteFile: (filename) => getStorage().deleteFile(filename),
};
