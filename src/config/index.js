require('dotenv').config();

const defaultConfig = require('./default');
const productionConfig = require('./production');

const env = process.env.NODE_ENV || 'development';

const configs = {
  development: defaultConfig,
  production: { ...defaultConfig, ...productionConfig },
};

const config = configs[env] || defaultConfig;

config.env = env;
config.port = parseInt(process.env.PORT, 10) || config.port;

module.exports = config;
