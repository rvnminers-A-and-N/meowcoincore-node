'use strict';

var path = require('path');

/**
 * Will return the path and default meowcoincore-node configuration on environment variables
 * or default locations.
 * @param {Object} options
 * @param {String} options.network - "testnet" or "livenet"
 * @param {String} options.datadir - Absolute path to meowcoin database directory
 */
function getDefaultBaseConfig(options) {
  if (!options) {
    options = {};
  }
  return {
    path: process.cwd(),
    config: {
      network: options.network || 'livenet',
      port: 3001,
      services: ['meowcoind', 'web'],
      servicesConfig: {
        meowcoind: {
          spawn: {
            datadir: options.datadir || path.resolve(process.env.HOME, '.meowcoin'),
            exec: path.resolve(__dirname, '../../bin/meowcoind')
          }
        }
      }
    }
  };
}

module.exports = getDefaultBaseConfig;
