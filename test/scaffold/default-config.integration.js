'use strict';

var path = require('path');
var should = require('chai').should();
var sinon = require('sinon');
var proxyquire = require('proxyquire');

describe('#defaultConfig', function() {
  var expectedExecPath = path.resolve(__dirname, '../../bin/meowcoind');

  it('will return expected configuration', function() {
    var config = JSON.stringify({
      network: 'livenet',
      port: 3001,
      services: [
        'meowcoind',
        'web'
      ],
	  messageLog: '',
	  servicesConfig: {
        web: {
          disablePolling: true,
	      enableSocketRPC: false
		},
		'insight-ui': {
		  routePrefix: '',
          apiPrefix: 'api'
		},
		'insight-api': {
		  routePrefix: 'api',
		  coinTicker: 'https://api.coinmarketcap.com/v1/ticker/meowcoin/?convert=USD',
		  coinShort: 'RVN',
      db: {
        host: '127.0.0.1',
        port: '27017',
        database: 'meowcoin-api-livenet',
        user: 'meowcoincore',
        password: 'password123'
      }      
		},
		meowcoind: {
		  sendTxLog: process.env.HOME + '/.meowcoincore/pushtx.log',
          spawn: {
            datadir: process.env.HOME + '/.meowcoincore/data',
            exec: expectedExecPath,
		    rpcqueue: 1000,
		    rpcport: 8766,
		    zmqpubrawtx: 'tcp://127.0.0.1:28332',
		    zmqpubhashblock: 'tcp://127.0.0.1:28332'
          }
        }
      }
    }, null, 2);
    var defaultConfig = proxyquire('../../lib/scaffold/default-config', {
      fs: {
        existsSync: sinon.stub().returns(false),
        writeFileSync: function(path, data) {
          path.should.equal(process.env.HOME + '/.meowcoincore/meowcoincore-node.json');
          data.should.equal(config);
        },
        readFileSync: function() {
          return config;
        }
      },
      mkdirp: {
        sync: sinon.stub()
      }
    });
    var home = process.env.HOME;
    var info = defaultConfig();
    info.path.should.equal(home + '/.meowcoincore');
    info.config.network.should.equal('livenet');
    info.config.port.should.equal(3001);
    info.config.services.should.deep.equal(['meowcoind', 'web']);
    var meowcoind = info.config.servicesConfig.meowcoind;
    should.exist(meowcoind);
    meowcoind.spawn.datadir.should.equal(home + '/.meowcoincore/data');
    meowcoind.spawn.exec.should.equal(expectedExecPath);
  });
  it('will include additional services', function() {
    var config = JSON.stringify({
      network: 'livenet',
      port: 3001,
      services: [
        'meowcoind',
        'web',
        'insight-api',
        'insight-ui'
      ],
	  messageLog: '',	  
	  servicesConfig: {
        web: {
          disablePolling: true,
	      enableSocketRPC: false
		},
		'insight-ui': {
		  routePrefix: '',
          apiPrefix: 'api'
		},
		'insight-api': {
		  routePrefix: 'api',
		  coinTicker: 'https://api.coinmarketcap.com/v1/ticker/meowcoin/?convert=USD',
		  coinShort: 'RVN',
      db: {
        host: '127.0.0.1',
        port: '27017',
        database: 'meowcoin-api-livenet',
        user: 'meowcoincore',
        password: 'password123'
      }      
		},
		meowcoind: {
		  sendTxLog: process.env.HOME + '/.meowcoincore/pushtx.log',
          spawn: {
            datadir: process.env.HOME + '/.meowcoincore/data',
            exec: expectedExecPath,
		    rpcqueue: 1000,
		    rpcport: 8766,
		    zmqpubrawtx: 'tcp://127.0.0.1:28332',
		    zmqpubhashblock: 'tcp://127.0.0.1:28332'
          }
        }
      }
    }, null, 2);
    var defaultConfig = proxyquire('../../lib/scaffold/default-config', {
      fs: {
        existsSync: sinon.stub().returns(false),
        writeFileSync: function(path, data) {
          path.should.equal(process.env.HOME + '/.meowcoincore/meowcoincore-node.json');
          data.should.equal(config);
        },
        readFileSync: function() {
          return config;
        }
      },
      mkdirp: {
        sync: sinon.stub()
      }
    });
    var home = process.env.HOME;
    var info = defaultConfig({
      additionalServices: ['insight-api', 'insight-ui']
    });
    info.path.should.equal(home + '/.meowcoincore');
    info.config.network.should.equal('livenet');
    info.config.port.should.equal(3001);
    info.config.services.should.deep.equal([
      'meowcoind',
      'web',
      'insight-api',
      'insight-ui'
    ]);
    var meowcoind = info.config.servicesConfig.meowcoind;
    should.exist(meowcoind);
    meowcoind.spawn.datadir.should.equal(home + '/.meowcoincore/data');
    meowcoind.spawn.exec.should.equal(expectedExecPath);
  });
});
