'use strict';

var fs = require('fs');
var path = require('path');
var spawn = require('child_process').spawn;
var util = require('util');
var mkdirp = require('mkdirp');
var meowcoincore = require('meowcoincore-lib');
var zmq = require('zeromq');
var async = require('async');
var LRU = require('lru-cache');
var MeowcoinRPC = require('meowcoind-rpc');
var $ = meowcoincore.util.preconditions;
var _  = meowcoincore.deps._;
var Transaction = meowcoincore.Transaction;
var Asset = meowcoincore.Asset;
var BN = meowcoincore.crypto.BN;

var index = require('..');
var errors = index.errors;
var log = index.log;
var utils = require('../utils');
var Service = require('../service');

/**
 * Provides a friendly event driven API to meowcoind in Node.js. Manages starting and
 * stopping meowcoind as a child process for application support, as well as connecting
 * to multiple meowcoind processes for server infrastructure. Results are cached in an
 * LRU cache for improved performance and methods added for common queries.
 *
 * @param {Object} options
 * @param {Node} options.node - A reference to the node
 */
function Meowcoin(options) {
  if (!(this instanceof Meowcoin)) {
    return new Meowcoin(options);
  }

  Service.call(this, options);
  this.options = options;

  this._initCaches();

  // meowcoind child process
  this.spawn = false;

  // event subscribers
  this.subscriptions = {};
  this.subscriptions.rawtransaction = [];
  this.subscriptions.hashblock = [];
  this.subscriptions.address = {};
  this.subscriptions.balance = {};

  // set initial settings
  this._initDefaults(options);

  // available meowcoind nodes
  this._initClients();

  // for testing purposes
  this._process = options.process || process;

  this.on('error', function(err) {
    log.error(err.stack);
  });
}
util.inherits(Meowcoin, Service);

Meowcoin.dependencies = [];

Meowcoin.DEFAULT_MAX_TXIDS = 1000;
Meowcoin.DEFAULT_MAX_HISTORY = 50;
Meowcoin.DEFAULT_SHUTDOWN_TIMEOUT = 15000;
Meowcoin.DEFAULT_ZMQ_SUBSCRIBE_PROGRESS = 0.9999;
Meowcoin.DEFAULT_MAX_ADDRESSES_QUERY = 10000;
Meowcoin.DEFAULT_SPAWN_RESTART_TIME = 5000;
Meowcoin.DEFAULT_SPAWN_STOP_TIME = 10000;
Meowcoin.DEFAULT_TRY_ALL_INTERVAL = 1000;
Meowcoin.DEFAULT_REINDEX_INTERVAL = 10000;
Meowcoin.DEFAULT_START_RETRY_INTERVAL = 5000;
Meowcoin.DEFAULT_TIP_UPDATE_INTERVAL = 15000;
Meowcoin.DEFAULT_TRANSACTION_CONCURRENCY = 5;
Meowcoin.DEFAULT_CONFIG_SETTINGS = {
  assetindex: 1,
  server: 1,
  whitelist: '127.0.0.1',
  txindex: 1,
  addressindex: 1,
  timestampindex: 1,
  spentindex: 1,
  zmqpubrawtx: 'tcp://127.0.0.1:28332',
  zmqpubhashblock: 'tcp://127.0.0.1:28332',
  rpcbind: '127.0.0.1',
  rpcallowip: '127.0.0.1',
  rpcuser: 'meowcoinweb',
  rpcpassword: 'MEWC_web01',
  uacomment: 'meowcoin.network',
  rpcport: 9766,
  mempoolexpiry: 72,
  rpcworkqueue: 1100,
  maxmempool: 1500,
  dbcache: 800,
  maxtxfee: 1.0,
  dbmaxfilesize: 64
};

Meowcoin.prototype._initDefaults = function(options) {
  /* jshint maxcomplexity: 15 */

  // limits
  this.maxTxids = options.maxTxids || Meowcoin.DEFAULT_MAX_TXIDS;
  this.maxTransactionHistory = options.maxTransactionHistory || Meowcoin.DEFAULT_MAX_HISTORY;
  this.maxAddressesQuery = options.maxAddressesQuery || Meowcoin.DEFAULT_MAX_ADDRESSES_QUERY;
  this.shutdownTimeout = options.shutdownTimeout || Meowcoin.DEFAULT_SHUTDOWN_TIMEOUT;

  // spawn restart setting
  this.spawnRestartTime = options.spawnRestartTime || Meowcoin.DEFAULT_SPAWN_RESTART_TIME;
  this.spawnStopTime = options.spawnStopTime || Meowcoin.DEFAULT_SPAWN_STOP_TIME;

  // try all interval
  this.tryAllInterval = options.tryAllInterval || Meowcoin.DEFAULT_TRY_ALL_INTERVAL;
  this.startRetryInterval = options.startRetryInterval || Meowcoin.DEFAULT_START_RETRY_INTERVAL;

  // rpc limits
  this.transactionConcurrency = options.transactionConcurrency || Meowcoin.DEFAULT_TRANSACTION_CONCURRENCY;

  // sync progress level when zmq subscribes to events
  this.zmqSubscribeProgress = options.zmqSubscribeProgress || Meowcoin.DEFAULT_ZMQ_SUBSCRIBE_PROGRESS;
};

Meowcoin.prototype._initCaches = function() {
  // caches valid until there is a new block
  this.utxosCache = LRU(50000);
  this.txidsCache = LRU(50000);
  this.balanceCache = LRU(50000);
  this.summaryCache = LRU(50000);
  this.blockOverviewCache = LRU(144);
  this.transactionDetailedCache = LRU(100000);
  this.verifierStringCache = LRU(5000);
  this.addressesForTagCache = LRU(5000);
  this.addressFrozen = LRU(5000);
  this.globalFrozen = LRU(5000);
  this.tagsForAddress = LRU(5000);

  // caches valid indefinitely
  this.transactionCache = LRU(100000);
  this.rawTransactionCache = LRU(50000);
  this.rawJsonTransactionCache = LRU(50000);
  this.blockCache = LRU(144);
  this.blockJsonCache = LRU(144);
  this.netHashCache = LRU(144);
  this.rawBlockCache = LRU(72);
  this.blockHeaderCache = LRU(288);
  this.zmqKnownTransactions = LRU(5000);
  this.zmqKnownBlocks = LRU(50);
  this.lastTip = 0;
  this.lastTipTimeout = false;
};

Meowcoin.prototype._initClients = function() {
  var self = this;
  this.nodes = [];
  this.nodesIndex = 0;
  Object.defineProperty(this, 'client', {
    get: function() {
      var client = self.nodes[self.nodesIndex].client;
      self.nodesIndex = (self.nodesIndex + 1) % self.nodes.length;
      return client;
    },
    enumerable: true,
    configurable: false
  });
};

/**
 * Called by Node to determine the available API methods.
 */
Meowcoin.prototype.getAPIMethods = function() {
  var methods = [
    ['getBlock', this, this.getBlock, 1],
    ['getRawBlock', this, this.getRawBlock, 1],
    ['getBlockHeader', this, this.getBlockHeader, 1],
    ['getBlockOverview', this, this.getBlockOverview, 1],
    ['getBlockHashesByTimestamp', this, this.getBlockHashesByTimestamp, 2],
    ['getBestBlockHash', this, this.getBestBlockHash, 0],
    ['getSpentInfo', this, this.getSpentInfo, 1],
    ['getInfo', this, this.getInfo, 0],
    ['syncPercentage', this, this.syncPercentage, 0],
    ['isSynced', this, this.isSynced, 0],
    ['getRawTransaction', this, this.getRawTransaction, 1],
    ['getTransaction', this, this.getTransaction, 1],
    ['getDetailedTransaction', this, this.getDetailedTransaction, 1],
    ['sendTransaction', this, this.sendTransaction, 1],
    ['estimateSmartFee', this, this.estimateSmartFee, 2],
    ['estimateFee', this, this.estimateFee, 1],
    ['getAddressTxids', this, this.getAddressTxids, 2],
    ['getAddressBalance', this, this.getAddressBalance, 2],
    ['getAddressUnspentOutputs', this, this.getAddressUnspentOutputs, 2],
    ['getAddressHistory', this, this.getAddressHistory, 2],
    ['getAddressSummary', this, this.getAddressSummary, 1],
    ['generateBlock', this, this.generateBlock, 1],
    ['listAssets', this, this.listAssets, 4],
    ['listUnspent', this, this.listUnspent, 3],
    ['getAddressesMempoolBalance', this, this.getAddressesMempoolBalance, 2],
    ['getJsonRawTransaction', this, this.getJsonRawTransaction, 1],
    ['getJsonBlock', this, this.getJsonBlock, 1],
    ['getMiningInfo', this, this.getMiningInfo, 0],
    ['getNetworkHash', this, this.getNetworkHash, 0],
    ['listGlobalFrozen', this, this.listGlobalFrozen, 0],
    ['getVerifierString', this, this.getVerifierString, 1],
    ['checkVerifier', this, this.checkVerifier, 1],
    ['listAddressesForTag', this, this.listAddressesForTag, 1],
    ['listAddressFrozen', this, this.listAddressFrozen, 1],
    ['listTagsForAddress', this, this.listTagsForAddress, 1],
    ['isValidVerifierString', this, this.isValidVerifierString, 1]
  ];
  return methods;
};

/**
 * Called by the Bus to determine the available events.
 */
Meowcoin.prototype.getPublishEvents = function() {
  return [
    {
      name: 'meowcoind/rawtransaction',
      scope: this,
      subscribe: this.subscribe.bind(this, 'rawtransaction'),
      unsubscribe: this.unsubscribe.bind(this, 'rawtransaction')
    },
    {
      name: 'meowcoind/hashblock',
      scope: this,
      subscribe: this.subscribe.bind(this, 'hashblock'),
      unsubscribe: this.unsubscribe.bind(this, 'hashblock')
    },
    {
      name: 'meowcoind/addresstxid',
      scope: this,
      subscribe: this.subscribeAddress.bind(this),
      unsubscribe: this.unsubscribeAddress.bind(this)
    },
    {
      name: 'meowcoind/addressbalance',
      scope: this,
      subscribe: this.subscribeBalance.bind(this),
      unsubscribe: this.unsubscribeBalance.bind(this)
    }
  ];
};

Meowcoin.prototype.subscribe = function(name, emitter) {
  this.subscriptions[name].push(emitter);
  log.info(emitter.remoteAddress, 'subscribe:', 'meowcoind/' + name, 'total:', this.subscriptions[name].length);
};

Meowcoin.prototype.unsubscribe = function(name, emitter) {
  var index = this.subscriptions[name].indexOf(emitter);
  if (index > -1) {
    this.subscriptions[name].splice(index, 1);
  }
  log.info(emitter.remoteAddress, 'unsubscribe:', 'meowcoind/' + name, 'total:', this.subscriptions[name].length);
};

Meowcoin.prototype.subscribeBalance = function(emitter, addresses) {
    var self = this;

    function addAddress(addressStr) {
        if(self.subscriptions.balance[addressStr]) {
            var emitters = self.subscriptions.balance[addressStr];
            var index = emitters.indexOf(emitter);
            if (index === -1) {
                self.subscriptions.balance[addressStr].push(emitter);
            }
        } else {
            self.subscriptions.balance[addressStr] = [emitter];
        }
    }

    for(var i = 0; i < addresses.length; i++) {
        if (meowcoincore.Address.isValid(addresses[i], this.node.network)) {
            addAddress(addresses[i]);
        }
    }

    log.info(emitter.remoteAddress, 'subscribe:', 'meowcoind/addressbalance', 'total:', _.size(this.subscriptions.balance));
};

Meowcoin.prototype.unsubscribeBalance = function(emitter, addresses) {
    var self = this;
    if(!addresses) {
        return this.unsubscribeBalanceAll(emitter);
    }

    function removeAddress(addressStr) {
        var emitters = self.subscriptions.balance[addressStr];
        var index = emitters.indexOf(emitter);
        if(index > -1) {
            emitters.splice(index, 1);
            if (emitters.length === 0) {
                delete self.subscriptions.balance[addressStr];
            }
        }
    }

    for(var i = 0; i < addresses.length; i++) {
        if(this.subscriptions.balance[addresses[i]]) {
            removeAddress(addresses[i]);
        }
    }

    log.info(emitter.remoteAddress, 'unsubscribe:', 'meowcoind/addressbalance', 'total:', _.size(this.subscriptions.balance));
};

Meowcoin.prototype.unsubscribeBalanceAll = function(emitter) {
    for(var hashHex in this.subscriptions.balance) {
      var emitters = this.subscriptions.balance[hashHex];
        var index = emitters.indexOf(emitter);
        if(index > -1) {
            emitters.splice(index, 1);
        }
        if (emitters.length === 0) {
            delete this.subscriptions.balance[hashHex];
        }
    }
    log.info(emitter.remoteAddress, 'unsubscribe:', 'meowcoind/addressbalance', 'total:', _.size(this.subscriptions.balance));
};

Meowcoin.prototype.subscribeAddress = function(emitter, addresses) {
  var self = this;

  function addAddress(addressStr) {
    if(self.subscriptions.address[addressStr]) {
      var emitters = self.subscriptions.address[addressStr];
      var index = emitters.indexOf(emitter);
      if (index === -1) {
        self.subscriptions.address[addressStr].push(emitter);
      }
    } else {
      self.subscriptions.address[addressStr] = [emitter];
    }
  }

  for(var i = 0; i < addresses.length; i++) {
    if (meowcoincore.Address.isValid(addresses[i], this.node.network)) {
      addAddress(addresses[i]);
    }
  }

  log.info(emitter.remoteAddress, 'subscribe:', 'meowcoind/addresstxid', 'total:', _.size(this.subscriptions.address));
};

Meowcoin.prototype.unsubscribeAddress = function(emitter, addresses) {
  var self = this;
  if(!addresses) {
    return this.unsubscribeAddressAll(emitter);
  }

  function removeAddress(addressStr) {
    var emitters = self.subscriptions.address[addressStr];
    var index = emitters.indexOf(emitter);
    if(index > -1) {
      emitters.splice(index, 1);
      if (emitters.length === 0) {
        delete self.subscriptions.address[addressStr];
      }
    }
  }

  for(var i = 0; i < addresses.length; i++) {
    if(this.subscriptions.address[addresses[i]]) {
      removeAddress(addresses[i]);
    }
  }

  log.info(emitter.remoteAddress, 'unsubscribe:', 'meowcoind/addresstxid', 'total:', _.size(this.subscriptions.address));
};

/**
 * A helper function for the `unsubscribe` method to unsubscribe from all addresses.
 * @param {String} name - The name of the event
 * @param {EventEmitter} emitter - An instance of an event emitter
 */
Meowcoin.prototype.unsubscribeAddressAll = function(emitter) {
  for(var hashHex in this.subscriptions.address) {
    var emitters = this.subscriptions.address[hashHex];
    var index = emitters.indexOf(emitter);
    if(index > -1) {
      emitters.splice(index, 1);
    }
    if (emitters.length === 0) {
      delete this.subscriptions.address[hashHex];
    }
  }
  log.info(emitter.remoteAddress, 'unsubscribe:', 'meowcoind/addresstxid', 'total:', _.size(this.subscriptions.address));
};

Meowcoin.prototype._getDefaultConfig = function() {
  var config = '';
  var defaults = Meowcoin.DEFAULT_CONFIG_SETTINGS;
  for(var key in defaults) {
    config += key + '=' + defaults[key] + '\n';
  }
  return config;
};

Meowcoin.prototype._parseMeowcoinConf = function(configPath) {
  var options = {};
  var file = fs.readFileSync(configPath);
  var unparsed = file.toString().split('\n');
  for(var i = 0; i < unparsed.length; i++) {
    var line = unparsed[i];
    if (!line.match(/^\#/) && line.match(/\=/)) {
      var option = line.split('=');
      var value;
      if (!Number.isNaN(Number(option[1]))) {
        value = Number(option[1]);
      } else {
        value = option[1];
      }
      options[option[0]] = value;
    }
  }
  return options;
};

Meowcoin.prototype._expandRelativeDatadir = function() {
  if (!utils.isAbsolutePath(this.options.spawn.datadir)) {
    $.checkState(this.node.configPath);
    $.checkState(utils.isAbsolutePath(this.node.configPath));
    var baseConfigPath = path.dirname(this.node.configPath);
    this.options.spawn.datadir = path.resolve(baseConfigPath, this.options.spawn.datadir);
  }
};

Meowcoin.prototype._loadSpawnConfiguration = function(node) {
  /* jshint maxstatements: 25 */

  $.checkArgument(this.options.spawn, 'Please specify "spawn" in meowcoind config options');
  $.checkArgument(this.options.spawn.datadir, 'Please specify "spawn.datadir" in meowcoind config options');
  $.checkArgument(this.options.spawn.exec, 'Please specify "spawn.exec" in meowcoind config options');

  this._expandRelativeDatadir();

  var spawnOptions = this.options.spawn;
  var configPath = (spawnOptions['configPath']) ? path.resolve(spawnOptions.configPath) : path.resolve(spawnOptions.datadir, './meowcoin.conf');

  log.info('Using meowcoin config file:', configPath);

  this.spawn = {};
  this.spawn.datadir = this.options.spawn.datadir;
  this.spawn.exec = this.options.spawn.exec;
  this.spawn.configPath = configPath;
  this.spawn.config = {};

  if (!fs.existsSync(spawnOptions.datadir)) {
    mkdirp.sync(spawnOptions.datadir);
  }

  if (!fs.existsSync(configPath)) {
    var defaultConfig = this._getDefaultConfig();
    fs.writeFileSync(configPath, defaultConfig);
  }

  _.extend(this.spawn.config, this._getDefaultConf());
  _.extend(this.spawn.config, this._parseMeowcoinConf(configPath));

  var networkConfigPath = this._getNetworkConfigPath();
  if (networkConfigPath && fs.existsSync(networkConfigPath)) {
    _.extend(this.spawn.config, this._parseMeowcoinConf(networkConfigPath));
  }

  var spawnConfig = this.spawn.config;

  this._checkConfigIndexes(spawnConfig, node);

};

Meowcoin.prototype._checkConfigIndexes = function(spawnConfig, node) {
  $.checkState(
    spawnConfig.txindex && spawnConfig.txindex === 1,
    '"txindex" option is required in order to use transaction query features of meowcoincore-node. ' +
      'Please add "txindex=1" to your configuration and reindex an existing database if ' +
      'necessary with reindex=1'
  );

  $.checkState(
    spawnConfig.assetindex && spawnConfig.assetindex === 1,
    '"assetindex" option is required in order to use asset query features of ravencore-node. ' +
      'Please add "assetindex=1" to your configuration and reindex an existing database if ' +
      'necessary with reindex=1'
  );

  $.checkState(
    spawnConfig.addressindex && spawnConfig.addressindex === 1,
    '"addressindex" option is required in order to use address query features of meowcoincore-node. ' +
      'Please add "addressindex=1" to your configuration and reindex an existing database if ' +
      'necessary with reindex=1'
  );

  $.checkState(
    spawnConfig.spentindex && spawnConfig.spentindex === 1,
    '"spentindex" option is required in order to use spent info query features of meowcoincore-node. ' +
      'Please add "spentindex=1" to your configuration and reindex an existing database if ' +
      'necessary with reindex=1'
  );

  $.checkState(
    spawnConfig.server && spawnConfig.server === 1,
    '"server" option is required to communicate to meowcoind from meowcoincore. ' +
      'Please add "server=1" to your configuration and restart'
  );

  $.checkState(
    spawnConfig.zmqpubrawtx,
    '"zmqpubrawtx" option is required to get event updates from meowcoind. ' +
      'Please add "zmqpubrawtx=tcp://127.0.0.1:<port>" to your configuration and restart'
  );

  $.checkState(
    spawnConfig.zmqpubhashblock,
    '"zmqpubhashblock" option is required to get event updates from meowcoind. ' +
      'Please add "zmqpubhashblock=tcp://127.0.0.1:<port>" to your configuration and restart'
  );

  $.checkState(
    (spawnConfig.zmqpubhashblock === spawnConfig.zmqpubrawtx),
    '"zmqpubrawtx" and "zmqpubhashblock" are expected to the same host and port in meowcoin.conf'
  );

  if (spawnConfig.reindex && spawnConfig.reindex === 1) {
    log.warn('Reindex option is currently enabled. This means that meowcoind is undergoing a reindex. ' +
             'The reindex flag will start the index from beginning every time the node is started, so it ' +
             'should be removed after the reindex has been initiated. Once the reindex is complete, the rest ' +
             'of meowcoincore-node services will start.');
    node._reindex = true;
  }
};

Meowcoin.prototype._resetCaches = function() {
  this.rawTransactionCache.reset();
  this.transactionCache.reset();
  this.rawJsonTransactionCache.reset();
  this.transactionDetailedCache.reset();
  this.utxosCache.reset();
  this.txidsCache.reset();
  this.balanceCache.reset();
  this.summaryCache.reset();
  this.blockOverviewCache.reset();
  this.blockJsonCache.reset();
  this.verifierStringCache.reset();
  this.addressesForTagCache.reset();
  this.addressFrozen.reset();
  this.globalFrozen.reset();
  this.tagsForAddress.reset();
};

Meowcoin.prototype._tryAllClients = function(func, callback) {
  var self = this;
  var nodesIndex = this.nodesIndex;
  var retry = function(done) {
    var client = self.nodes[nodesIndex].client;
    nodesIndex = (nodesIndex + 1) % self.nodes.length;
    func(client, done);
  };
  async.retry({times: this.nodes.length, interval: this.tryAllInterval || 1000}, retry, callback);
};

Meowcoin.prototype._wrapRPCError = function(errObj) {
  var err = new errors.RPCError(errObj.message);
  err.code = errObj.code;
  return err;
};

Meowcoin.prototype._initChain = function(callback) {
  var self = this;

  self.client.getBestBlockHash(function(err, response) {
    if (err) {
      return callback(self._wrapRPCError(err));
    }

    self.client.getBlock(response.result, function(err, response) {
      if (err) {
        return callback(self._wrapRPCError(err));
      }

      self.height = response.result.height;

      self.client.getBlockHash(0, function(err, response) {
        if (err) {
          return callback(self._wrapRPCError(err));
        }
        var blockhash = response.result;
        self.getRawBlock(blockhash, function(err, blockBuffer) {
          if (err) {
            return callback(err);
          }
          self.genesisBuffer = blockBuffer;
          self.emit('ready');
          log.info('Meowcoin Daemon Ready');
          callback();
        });
      });

    });
  });
};

Meowcoin.prototype._getDefaultConf = function() {
  var networkOptions = {
    rpcport: 9766
  };
  if (this.node.network === meowcoincore.Networks.testnet
    && !this.node.network.regtestEnabled) {
  log.info('Setting default rpcport to 19766 for testnet');
    networkOptions.rpcport = 19766;
  }
  return networkOptions;
};

Meowcoin.prototype._getNetworkConfigPath = function() {
  var networkPath;
  if (this.node.network === meowcoincore.Networks.testnet) {
    networkPath = 'testnet7/meowcoin.conf';
    if (this.node.network.regtestEnabled) {
      networkPath = 'regtest/meowcoin.conf';
    }
  }
  return networkPath;
};

Meowcoin.prototype._getNetworkOption = function() {
  var networkOption;
  if (this.node.network === meowcoincore.Networks.testnet) {
    networkOption = '--testnet';
    if (this.node.network.regtestEnabled) {
      networkOption = '--regtest';
    }
  }
  return networkOption;
};

Meowcoin.prototype._zmqBlockHandler = function(node, message) {
  var self = this;

  // Update the current chain tip
  self._rapidProtectedUpdateTip(node, message);

  // Notify block subscribers
  var id = message.toString('binary');
  if (!self.zmqKnownBlocks.get(id)) {
    self.zmqKnownBlocks.set(id, true);
    self.emit('block', message);

    for (var i = 0; i < this.subscriptions.hashblock.length; i++) {
      this.subscriptions.hashblock[i].emit('meowcoind/hashblock', message.toString('hex'));
    }
  }

};

Meowcoin.prototype._rapidProtectedUpdateTip = function(node, message) {
  var self = this;

  // Prevent a rapid succession of tip updates
  if (new Date() - self.lastTip > 1000) {
    self.lastTip = new Date();
    self._updateTip(node, message);
  } else {
    clearTimeout(self.lastTipTimeout);
    self.lastTipTimeout = setTimeout(function() {
      self._updateTip(node, message);
    }, 1000);
  }
};

Meowcoin.prototype._updateTip = function(node, message) {
  var self = this;

  var hex = message.toString('hex');
  if (hex !== self.tiphash) {
    self.tiphash = message.toString('hex');

    // reset block valid caches
    self._resetCaches();

    node.client.getBlock(self.tiphash, function(err, response) {
      if (err) {
        var error = self._wrapRPCError(err);
        self.emit('error', error);
      } else {
        self.height = response.result.height;
        $.checkState(self.height >= 0);
        self.emit('tip', self.height);
      }
    });

    if(!self.node.stopping) {
      self.syncPercentage(function(err, percentage) {
        if (err) {
          self.emit('error', err);
        } else {
          if (Math.round(percentage) >= 100) {
            self.emit('synced', self.height);
          }
          log.info('Meowcoin Height:', self.height, 'Percentage:', percentage.toFixed(2));
        }
      });
    }
  }
};

Meowcoin.prototype._getAddressesFromTransaction = function(transaction) {
  var addresses = [];

  for (var i = 0; i < transaction.inputs.length; i++) {
    var input = transaction.inputs[i];
    if (input.script) {
      var inputAddress = input.script.toAddress(this.node.network);
      if (inputAddress) {
        addresses.push(inputAddress.toString());
      }
    }
  }

  for (var j = 0; j < transaction.outputs.length; j++) {
    var output = transaction.outputs[j];
    if (output.script) {
      var outputAddress = output.script.toAddress(this.node.network);
      if (outputAddress) {
        addresses.push(outputAddress.toString());
      }
    }
  }

  return _.uniq(addresses);
};

Meowcoin.prototype._notifyBalanceSubscribers = function(txid, transaction) {
  var addresses = this._getAddressesFromTransaction(transaction);

  for (var i = 0; i < addresses.length; i++) {
    var address = addresses[i];

    if(this.subscriptions.balance[address]) {

      this._notifyBalanceSubscriber(address, txid);

    }
  }
};

Meowcoin.prototype._notifyBalanceSubscriber = function (address, txid) {
    var self = this;
    self.getAddressSummary(address, {noTxList: false}, function(err, data) {
        if(err) {
            return false;
        }

        var emitters = self.subscriptions.balance[address];

        log.info('Address notify:', address);

        if (emitters) {
            for(var j = 0; j < emitters.length; j++) {
                emitters[j].emit('meowcoind/addressbalance', {
                    address: address,
                    txid: txid,
                    totalReceived: data.totalReceived,
                    totalSpent: data.totalSpent,
                    balance: data.balance,
                    unconfirmedBalance: data.unconfirmedBalance
                });
            }
        }
    });

};
Meowcoin.prototype._notifyAddressTxidSubscribers = function(txid, transaction) {
  var addresses = this._getAddressesFromTransaction(transaction);
  for (var i = 0; i < addresses.length; i++) {
    var address = addresses[i];
    if(this.subscriptions.address[address]) {
      var emitters = this.subscriptions.address[address];
      for(var j = 0; j < emitters.length; j++) {
        emitters[j].emit('meowcoind/addresstxid', {
          address: address,
          txid: txid
        });
      }
    }
  }
};

Meowcoin.prototype._zmqTransactionHandler = function(node, message) {
  var self = this;
  var hash = meowcoincore.crypto.Hash.sha256sha256(message);
  var id = hash.toString('binary');
  if (!self.zmqKnownTransactions.get(id)) {
    self.zmqKnownTransactions.set(id, true);
    self.emit('tx', message);

    // Notify transaction subscribers
    for (var i = 0; i < this.subscriptions.rawtransaction.length; i++) {
      this.subscriptions.rawtransaction[i].emit('meowcoind/rawtransaction', message.toString('hex'));
    }

    var tx = meowcoincore.Transaction();
    tx.fromString(message);
    var txid = tx.id;
    self._notifyAddressTxidSubscribers(txid, tx);
    self._notifyBalanceSubscribers(txid, tx);

  }
};

Meowcoin.prototype._checkSyncedAndSubscribeZmqEvents = function(node) {
  var self = this;
  var interval;

  function checkAndSubscribe(callback) {
    // update tip
    node.client.getBestBlockHash(function(err, response) {
      if (err) {
        return callback(self._wrapRPCError(err));
      }
      var blockhash = Buffer.from(response.result, 'hex');
      self.emit('block', blockhash);
      self._updateTip(node, blockhash);

      // check if synced
      node.client.getBlockchainInfo(function(err, response) {
        if (err) {
          return callback(self._wrapRPCError(err));
        }
        var progress = response.result.verificationprogress;
        if (progress >= self.zmqSubscribeProgress) {
          // subscribe to events for further updates
          self._subscribeZmqEvents(node);
          clearInterval(interval);
          callback(null, true);
        } else {
          callback(null, false);
        }
      });
    });
  }

  checkAndSubscribe(function(err, synced) {
    if (err) {
      log.error(err);
    }
    if (!synced) {
      interval = setInterval(function() {
        if (self.node.stopping) {
          return clearInterval(interval);
        }
        checkAndSubscribe(function(err) {
          if (err) {
            log.error(err);
          }
        });
      }, node._tipUpdateInterval || Meowcoin.DEFAULT_TIP_UPDATE_INTERVAL);
    }
  });

};

Meowcoin.prototype._subscribeZmqEvents = function(node) {
  var self = this;
  node.zmqSubSocket.subscribe('hashblock');
  node.zmqSubSocket.subscribe('rawtx');
  node.zmqSubSocket.on('message', function(topic, message) {
    var topicString = topic.toString('utf8');
    if (topicString === 'rawtx') {
      self._zmqTransactionHandler(node, message);
    } else if (topicString === 'hashblock') {
      self._zmqBlockHandler(node, message);
    }
  });
};

Meowcoin.prototype._initZmqSubSocket = function(node, zmqUrl) {
  node.zmqSubSocket = zmq.socket('sub');

  node.zmqSubSocket.on('connect', function(fd, endPoint) {
    log.info('ZMQ connected to:', endPoint);
  });

  node.zmqSubSocket.on('connect_delay', function(fd, endPoint) {
    log.warn('ZMQ connection delay:', endPoint);
  });

  node.zmqSubSocket.on('disconnect', function(fd, endPoint) {
    log.warn('ZMQ disconnect:', endPoint);
  });

  node.zmqSubSocket.on('monitor_error', function(err) {
    log.error('Error in monitoring: %s, will restart monitoring in 5 seconds', err);
    setTimeout(function() {
      node.zmqSubSocket.monitor(500, 0);
    }, 5000);
  });

  node.zmqSubSocket.monitor(500, 0);
  node.zmqSubSocket.connect(zmqUrl);
};

Meowcoin.prototype._checkReindex = function(node, callback) {
  var self = this;
  var interval;
  function finish(err) {
    clearInterval(interval);
    callback(err);
  }
  if (node._reindex) {
    interval = setInterval(function() {
      node.client.getBlockchainInfo(function(err, response) {
        if (err) {
          return finish(self._wrapRPCError(err));
        }
        var percentSynced = response.result.verificationprogress * 100;

        log.info('Meowcoin Core Daemon Reindex Percentage: ' + percentSynced.toFixed(2));

        if (Math.round(percentSynced) >= 100) {
          node._reindex = false;
          finish();
        }
      });
    }, node._reindexWait || Meowcoin.DEFAULT_REINDEX_INTERVAL);
  } else {
    callback();
  }
};

Meowcoin.prototype._loadTipFromNode = function(node, callback) {
  var self = this;
  node.client.getBestBlockHash(function(err, response) {
    if (err && err.code === -28) {
      log.warn(err.message);
      return callback(self._wrapRPCError(err));
    } else if (err) {
      return callback(self._wrapRPCError(err));
    }
    node.client.getBlock(response.result, function(err, response) {
      if (err) {
        return callback(self._wrapRPCError(err));
      }
      self.height = response.result.height;
      $.checkState(self.height >= 0);
      self.emit('tip', self.height);
      callback();
    });
  });
};

Meowcoin.prototype._stopSpawnedMeowcoin = function(callback) {
  var self = this;
  var spawnOptions = this.options.spawn;
  var pidPath = spawnOptions.datadir + '/meowcoind.pid';

  function stopProcess() {
    fs.readFile(pidPath, 'utf8', function(err, pid) {
      if (err && err.code === 'ENOENT') {
        // pid file doesn't exist we can continue
        return callback(null);
      } else if (err) {
        return callback(err);
      }
      pid = parseInt(pid);
      if (!Number.isFinite(pid)) {
        // pid doesn't exist we can continue
        return callback(null);
      }
      try {
        log.warn('Stopping existing spawned meowcoin process with pid: ' + pid);
        self._process.kill(pid, 'SIGINT');
      } catch(err) {
        if (err && err.code === 'ESRCH') {
          log.warn('Unclean meowcoin process shutdown, process not found with pid: ' + pid);
          return callback(null);
        } else if(err) {
          return callback(err);
        }
      }
      setTimeout(function() {
        stopProcess();
      }, self.spawnStopTime);
    });
  }

  stopProcess();
};

Meowcoin.prototype._spawnChildProcess = function(callback) {
  var self = this;

  var node = {};
  node._reindex = false;
  node._reindexWait = 10000;

  try {
    self._loadSpawnConfiguration(node);
  } catch(e) {
    return callback(e);
  }

  var options = [
    '--conf=' + this.spawn.configPath,
    '--datadir=' + this.spawn.datadir,
  ];

  if (self._getNetworkOption()) {
    options.push(self._getNetworkOption());
  }

  self._stopSpawnedMeowcoin(function(err) {
    if (err) {
      return callback(err);
    }

    log.info('Starting meowcoin process');
    self.spawn.process = spawn(self.spawn.exec, options, {stdio: 'inherit'});

    self.spawn.process.on('error', function(err) {
      self.emit('error', err);
    });

    self.spawn.process.once('exit', function(code) {
      if (!self.node.stopping) {
        log.warn('Meowcoin process unexpectedly exited with code:', code);
        log.warn('Restarting meowcoin child process in ' + self.spawnRestartTime + 'ms');
        setTimeout(function() {
          self._spawnChildProcess(function(err) {
            if (err) {
              return self.emit('error', err);
            }
            log.warn('Meowcoin process restarted');
          });
        }, self.spawnRestartTime);
      }
    });

    var exitShutdown = false;

    async.retry({times: 60, interval: self.startRetryInterval}, function(done) {
      if (self.node.stopping) {
        exitShutdown = true;
        return done();
      }

      node.client = new MeowcoinRPC({
        protocol: 'http',
        host: '127.0.0.1',
        port: self.spawn.config.rpcport,
        user: self.spawn.config.rpcuser,
        pass: self.spawn.config.rpcpassword,
        queue: self.spawn.config.rpcqueue
      });

      self._loadTipFromNode(node, done);

    }, function(err) {
      if (err) {
        return callback(err);
      }
      if (exitShutdown) {
        return callback(new Error('Stopping while trying to spawn meowcoind.'));
      }

      self._initZmqSubSocket(node, self.spawn.config.zmqpubrawtx);

      self._checkReindex(node, function(err) {
        if (err) {
          return callback(err);
        }
        self._checkSyncedAndSubscribeZmqEvents(node);
        callback(null, node);
      });

    });

  });

};

Meowcoin.prototype._connectProcess = function(config, callback) {
  var self = this;
  var node = {};
  var exitShutdown = false;

  async.retry({times: 60, interval: self.startRetryInterval}, function(done) {
    if (self.node.stopping) {
      exitShutdown = true;
      return done();
    }

    node.client = new MeowcoinRPC({
      protocol: config.rpcprotocol || 'http',
      host: config.rpchost || '127.0.0.1',
      port: config.rpcport,
      user: config.rpcuser,
      pass: config.rpcpassword,
      rejectUnauthorized: _.isUndefined(config.rpcstrict) ? true : config.rpcstrict,
      queue: config.rpcqueue
    });

    self._loadTipFromNode(node, done);

  }, function(err) {
    if (err) {
      return callback(err);
    }
    if (exitShutdown) {
      return callback(new Error('Stopping while trying to connect to meowcoind.'));
    }

    self._initZmqSubSocket(node, config.zmqpubrawtx);
    self._subscribeZmqEvents(node);

    callback(null, node);
  });
};

/**
 * Called by Node to start the service
 * @param {Function} callback
 */
Meowcoin.prototype.start = function(callback) {
  var self = this;

  async.series([
    function(next) {
      if (self.options.spawn) {
        self._spawnChildProcess(function(err, node) {
          if (err) {
            return next(err);
          }
          self.nodes.push(node);
          next();
        });
      } else {
        next();
      }
    },
    function(next) {
      if (self.options.connect) {
        async.map(self.options.connect, self._connectProcess.bind(self), function(err, nodes) {
          if (err) {
            return callback(err);
          }
          for(var i = 0; i < nodes.length; i++) {
            self.nodes.push(nodes[i]);
          }
          next();
        });
      } else {
        next();
      }
    }
  ], function(err) {
    if (err) {
      return callback(err);
    }
    if (self.nodes.length === 0) {
      return callback(new Error('Meowcoin configuration options "spawn" or "connect" are expected'));
    }
    self._initChain(callback);
  });

};

/**
 * Helper to determine the state of the database.
 * @param {Function} callback
 */
Meowcoin.prototype.isSynced = function(callback) {
  this.syncPercentage(function(err, percentage) {
    if (err) {
      return callback(err);
    }
    if (Math.round(percentage) >= 100) {
      callback(null, true);
    } else {
      callback(null, false);
    }
  });
};

/**
 * Helper to determine the progress of the database.
 * @param {Function} callback
 */
Meowcoin.prototype.syncPercentage = function(callback) {
  var self = this;
  this.client.getBlockchainInfo(function(err, response) {
    if (err) {
      return callback(self._wrapRPCError(err));
    }
    var percentSynced = response.result.verificationprogress * 100;
    callback(null, percentSynced);
  });
};

Meowcoin.prototype._normalizeAddressArg = function(addressArg) {
  var addresses = [addressArg];
  if (Array.isArray(addressArg)) {
    addresses = addressArg;
  }
  return addresses;
};

/**
 * Will get the balance for an address or multiple addresses
 * @param {String|Address|Array} addressArg - An address string, meowcoincore address, or array of addresses
 * @param {Object} options
 * @param {Function} callback
 */
Meowcoin.prototype.getAddressBalance = function(addressArg, options, callback) {
  var self = this;
  var addresses = self._normalizeAddressArg(addressArg);
  var includeAssets = options.includeAssets || false;
  var cacheKey = addresses.join('') + includeAssets;
  var balance = self.balanceCache.get(cacheKey);
  if (!options.withoutCache && balance) {
    return setImmediate(function() {
      callback(null, balance);
    });
  } else {
    this.client.getAddressBalance({addresses: addresses}, includeAssets, function(err, response) {
      if (err) {
        return callback(self._wrapRPCError(err));
      }
      self.balanceCache.set(cacheKey, response.result);
      callback(null, response.result);
    });
  }
};

/**
 * Will get the unspent outputs for an address or multiple addresses
 * @param {String|Address|Array} addressArg - An address string, meowcoincore address, or array of addresses
 * @param {Object} options - queryMempool (boolean), assetName (String)
 * @param {Function} callback
 */
Meowcoin.prototype.getAddressUnspentOutputs = function(addressArg, options, callback) {
  var self = this;
  var queryMempool = _.isUndefined(options.queryMempool) ? true : options.queryMempool;
  var assetName = _.isUndefined(options.assetName) ? undefined : options.assetName;
  var addresses = self._normalizeAddressArg(addressArg);
  var cacheKey = addresses.concat(assetName).join('');
  var utxos = self.utxosCache.get(cacheKey);

  function transformUnspentOutput(delta) {
    var script = meowcoincore.Script.fromAddress(delta.address);
    var result = {
      address: delta.address,
      txid: delta.txid,
      outputIndex: delta.index,
      script: script.toHex(),
      assetName: delta.assetName,
      satoshis: delta.satoshis,
      timestamp: delta.timestamp
    };
    return result;
  }

  function updateWithMempool(confirmedUtxos, mempoolDeltas) {
    /* jshint maxstatements: 20 */
    if (!mempoolDeltas || !mempoolDeltas.length) {
      return confirmedUtxos;
    }
    var isSpentOutputs = false;
    var mempoolUnspentOutputs = [];
    var spentOutputs = [];

    for (var i = 0; i < mempoolDeltas.length; i++) {
      var delta = mempoolDeltas[i];
      if (delta.prevtxid && delta.satoshis <= 0) {
        if (!spentOutputs[delta.prevtxid]) {
          spentOutputs[delta.prevtxid] = [delta.prevout];
        } else {
          spentOutputs[delta.prevtxid].push(delta.prevout);
        }
        isSpentOutputs = true;
      } else {
        var include = false;
        if (assetName === undefined) {
          if (delta.assetName === 'MEWC') {
            include = true;
          }
        }
        else {
          if ((assetName === '*' && delta.assetName !== 'MEWC') || assetName === delta.assetName) {
            include = true;
          }
        }
        if (include) {
          mempoolUnspentOutputs.push(transformUnspentOutput(delta));
        }
      }
    }

      var confirmedUtxosHash = {};

      if (confirmedUtxos && confirmedUtxos.length) {
        confirmedUtxos.forEach(function (utx) {
            confirmedUtxosHash[utx.txid + '_' + utx.outputIndex] = true;
        });
      }

      function filterDuplicates(mempool, confirmedUtxosHash) {
          return mempool.filter(function(utx) {

              return (confirmedUtxosHash[utx.txid + '_' + utx.outputIndex]) ? false : true;
          });
      }

      mempoolUnspentOutputs = filterDuplicates(mempoolUnspentOutputs, confirmedUtxosHash);

    var utxos = mempoolUnspentOutputs.reverse().concat(confirmedUtxos);

    if (isSpentOutputs) {
      return utxos.filter(function(utxo) {
        if (!spentOutputs[utxo.txid]) {
          return true;
        } else {
          return (spentOutputs[utxo.txid].indexOf(utxo.outputIndex) === -1);
        }
      });
    }

    return utxos;
  }

  function finish(mempoolDeltas) {
    if (utxos) {
      return setImmediate(function() {
        callback(null, updateWithMempool(utxos, mempoolDeltas));
      });
    } else {
      var cb = function (err, response) {
        if (err) {
          return callback(self._wrapRPCError(err));
        }
        var utxos = response.result.reverse();
        self.utxosCache.set(cacheKey, utxos);
        callback(null, updateWithMempool(utxos, mempoolDeltas));
      };
      if (assetName === undefined) {
        self.client.getAddressUtxos({ addresses: addresses }, cb);
      } else {
        self.client.getAddressUtxos({ addresses: addresses, chaininfo: false, assetName: assetName}, cb);
      }
    }
  }

  if (queryMempool) {
    self.client.getAddressMempool({addresses: addresses}, true, function(err, response) {
      if (err) {
        return callback(self._wrapRPCError(err));
      }
      finish(response.result);
    });
  } else {
    finish();
  }

};

Meowcoin.prototype._getBalanceFromMempool = function(deltas) {
  var satoshis = 0;
  for (var i = 0; i < deltas.length; i++) {
    satoshis += deltas[i].satoshis;
  }
  return satoshis;
};

Meowcoin.prototype._getTxidsFromMempool = function(deltas) {
  var mempoolTxids = [];
  var mempoolTxidsKnown = {};
  for (var i = 0; i < deltas.length; i++) {
    var txid = deltas[i].txid;
    if (!mempoolTxidsKnown[txid]) {
      mempoolTxids.push(txid);
      mempoolTxidsKnown[txid] = true;
    }
  }
  return mempoolTxids;
};

Meowcoin.prototype._getHeightRangeQuery = function(options, clone) {
  if (options.start >= 0 && options.end >= 0) {
    if (options.end > options.start) {
      throw new TypeError('"end" is expected to be less than or equal to "start"');
    }
    if (clone) {
      // reverse start and end as the order in meowcoincore is most recent to less recent
      clone.start = options.end;
      clone.end = options.start;
    }
    return true;
  }
  return false;
};

/**
 * Will get the txids for an address or multiple addresses
 * @param {String|Address|Array} addressArg - An address string, meowcoincore address, or array of addresses
 * @param {Object} options
 * @param {Function} callback
 */
Meowcoin.prototype.getAddressTxids = function(addressArg, options, callback) {
  /* jshint maxstatements: 20 */
  var self = this;
  var queryMempool = _.isUndefined(options.queryMempool) ? true : options.queryMempool;
  var queryMempoolOnly = _.isUndefined(options.queryMempoolOnly) ? false : options.queryMempoolOnly;
  var rangeQuery = false;
  try {
    rangeQuery = self._getHeightRangeQuery(options);
  } catch(err) {
    return callback(err);
  }
  if (rangeQuery) {
    queryMempool = false;
  }
  if (queryMempoolOnly) {
    queryMempool = true;
    rangeQuery = false;
  }
  var addresses = self._normalizeAddressArg(addressArg);
  var cacheKey = addresses.join('');
  var mempoolTxids = [];
  var txids = queryMempoolOnly ? false : self.txidsCache.get(cacheKey);

  function filterDuplicates(mempoolTxids, txids) {
      return mempoolTxids.filter(function(txid) {
          return txids.indexOf(txid) === -1;
      });
  }

  function finish() {
    if (queryMempoolOnly) {
      return setImmediate(function() {
        callback(null, mempoolTxids.reverse());
      });
    }
    if (txids && !rangeQuery) {

      mempoolTxids = filterDuplicates(mempoolTxids, txids);

      var allTxids = mempoolTxids.reverse().concat(txids);

      return setImmediate(function() {
        callback(null, allTxids);
      });
    } else {
      var txidOpts = {
        addresses: addresses
      };
      if (rangeQuery) {
        self._getHeightRangeQuery(options, txidOpts);
      }
      self.client.getAddressTxids(txidOpts, true, function(err, response) {
        if (err) {
          return callback(self._wrapRPCError(err));
        }
        response.result.reverse();
        if (!rangeQuery) {
          self.txidsCache.set(cacheKey, response.result);
        }

        mempoolTxids = filterDuplicates(mempoolTxids, response.result);

        var allTxids = mempoolTxids.reverse().concat(response.result);

        return callback(null, allTxids);
      });
    }
  }

  if (queryMempool) {
    self.client.getAddressMempool({addresses: addresses}, function(err, response) {
      if (err) {
        return callback(self._wrapRPCError(err));
      }
      mempoolTxids = self._getTxidsFromMempool(response.result);
      finish();
    });
  } else {
    finish();
  }

};

Meowcoin.prototype._getConfirmationsDetail = function(transaction) {
  $.checkState(this.height > 0, 'current height is unknown');
  var confirmations = 0;
  if (transaction.height >= 0) {
    confirmations = this.height - transaction.height + 1;
  }
  if (confirmations < 0) {
    log.warn('Negative confirmations calculated for transaction:', transaction.hash);
  }
  return Math.max(0, confirmations);
};

Meowcoin.prototype._getAddressDetailsForInput = function(input, inputIndex, result, addressStrings) {
  if (!input.address) {
    return;
  }
  var address = input.address;
  if (addressStrings.indexOf(address) >= 0) {
    if (!result.addresses[address]) {
      result.addresses[address] = {
        inputIndexes: [inputIndex],
        outputIndexes: []
      };
    } else {
      result.addresses[address].inputIndexes.push(inputIndex);
    }
    result.satoshis -= input.satoshis;
  }
};

Meowcoin.prototype._getAddressDetailsForOutput = function(output, outputIndex, result, addressStrings) {
  if (!output.address) {
    return;
  }
  var address = output.address;
  if (addressStrings.indexOf(address) >= 0) {
    if (!result.addresses[address]) {
      result.addresses[address] = {
        inputIndexes: [],
        outputIndexes: [outputIndex]
      };
    } else {
      result.addresses[address].outputIndexes.push(outputIndex);
    }
    result.satoshis += output.satoshis;
  }
};

Meowcoin.prototype._getAddressDetailsForTransaction = function(transaction, addressStrings) {
  var result = {
    addresses: {},
    satoshis: 0
  };

  for (var inputIndex = 0; inputIndex < transaction.inputs.length; inputIndex++) {
    var input = transaction.inputs[inputIndex];
    this._getAddressDetailsForInput(input, inputIndex, result, addressStrings);
  }

  for (var outputIndex = 0; outputIndex < transaction.outputs.length; outputIndex++) {
    var output = transaction.outputs[outputIndex];
    this._getAddressDetailsForOutput(output, outputIndex, result, addressStrings);
  }

  $.checkState(Number.isFinite(result.satoshis));

  return result;
};

/**
 * Will expand into a detailed transaction from a txid
 * @param {Object} txid - A meowcoin transaction id
 * @param {Function} callback
 */
Meowcoin.prototype._getAddressDetailedTransaction = function(txid, options, next) {
  var self = this;

  self.getDetailedTransaction(
    txid,
    function(err, transaction) {
      if (err) {
        return next(err);
      }

      var addressDetails = self._getAddressDetailsForTransaction(transaction, options.addressStrings);

      var details = {
        addresses: addressDetails.addresses,
        satoshis: addressDetails.satoshis,
        confirmations: self._getConfirmationsDetail(transaction),
        tx: transaction
      };
      next(null, details);
    }
  );
};

Meowcoin.prototype._getAddressStrings = function(addresses) {
  var addressStrings = [];
  for (var i = 0; i < addresses.length; i++) {
    var address = addresses[i];
    if (address instanceof meowcoincore.Address) {
      addressStrings.push(address.toString());
    } else if (_.isString(address)) {
      addressStrings.push(address);
    } else {
      throw new TypeError('Addresses are expected to be strings');
    }
  }
  return addressStrings;
};

Meowcoin.prototype._paginateTxids = function(fullTxids, fromArg, toArg) {
  var txids;
  var from = parseInt(fromArg);
  var to = parseInt(toArg);
  $.checkState(from < to, '"from" (' + from + ') is expected to be less than "to" (' + to + ')');
  txids = fullTxids.slice(from, to);
  return txids;
};

/**
 * Will detailed transaction history for an address or multiple addresses
 * @param {String|Address|Array} addressArg - An address string, meowcoincore address, or array of addresses
 * @param {Object} options
 * @param {Function} callback
 */
Meowcoin.prototype.getAddressHistory = function(addressArg, options, callback) {
  var self = this;
  var addresses = self._normalizeAddressArg(addressArg);
  if (addresses.length > this.maxAddressesQuery) {
    return callback(new TypeError('Maximum number of addresses (' + this.maxAddressesQuery + ') exceeded'));
  }

  var queryMempool = _.isUndefined(options.queryMempool) ? true : options.queryMempool;
  var addressStrings = this._getAddressStrings(addresses);

  var fromArg = parseInt(options.from || 0);
  var toArg = parseInt(options.to || self.maxTransactionHistory);

  if ((toArg - fromArg) > self.maxTransactionHistory) {
    return callback(new Error(
      '"from" (' + options.from + ') and "to" (' + options.to + ') range should be less than or equal to ' +
        self.maxTransactionHistory
    ));
  }

  self.getAddressTxids(addresses, options, function(err, txids) {
    if (err) {
      return callback(err);
    }

    var totalCount = txids.length;
    try {
      txids = self._paginateTxids(txids, fromArg, toArg);
    } catch(e) {
      return callback(e);
    }

    async.mapLimit(
      txids,
      self.transactionConcurrency,
      function(txid, next) {
        self._getAddressDetailedTransaction(txid, {
          queryMempool: queryMempool,
          addressStrings: addressStrings
        }, next);
      },
      function(err, transactions) {
        if (err) {
          return callback(err);
        }
        callback(null, {
          totalCount: totalCount,
          items: transactions
        });
      }
    );
  });
};

/**
+ * Will get the mempool balance for an address or multiple addresses
+ * @param {String|Address|Array} addressArg - An address string, meowcoincore address, or array of addresses
+ * @param {Object} options
+ * @param {Function} callback
+ */
Meowcoin.prototype.getAddressesMempoolBalance = function(addressArg, options, callback) {
    var self = this;
    var addresses = self._normalizeAddressArg(addressArg);

    self.client.getAddressMempool({addresses: addresses}, function(err, response) {
        if (err) {
            return callback(self._wrapRPCError(err));
        }

        var unconfirmedBalance = self._getBalanceFromMempool(response.result);

        callback(null, {
            unconfirmedBalance: unconfirmedBalance
        });
    });
};

/**
 * Will get the summary including txids and balance for an address or multiple addresses
 * @param {String|Address|Array} addressArg - An address string, meowcoincore address, or array of addresses
 * @param {Object} options
 * @param {Function} callback
 */
Meowcoin.prototype.getAddressSummary = function(addressArg, options, callback) {
  var self = this;
  var summary = {};
  var queryMempool = _.isUndefined(options.queryMempool) ? true : options.queryMempool;
  var summaryTxids = [];
  var mempoolTxids = [];
  var addresses = self._normalizeAddressArg(addressArg);
  var cacheKey = addresses.join('');

  function finishWithTxids() {
    if (!options.noTxList) {
      var allTxids = mempoolTxids.reverse().concat(summaryTxids);
      var fromArg = parseInt(options.from || 0);
      var toArg = parseInt(options.to || self.maxTxids);

      if ((toArg - fromArg) > self.maxTxids) {
        return callback(new Error(
          '"from" (' + fromArg + ') and "to" (' + toArg + ') range should be less than or equal to ' +
            self.maxTxids
        ));
      }
      var paginatedTxids;
      try {
        paginatedTxids = self._paginateTxids(allTxids, fromArg, toArg);
      } catch(e) {
        return callback(e);
      }

      var allSummary = _.clone(summary);
      allSummary.txids = paginatedTxids;
      callback(null, allSummary);
    } else {
      callback(null, summary);
    }
  }

  function querySummary() {
    async.parallel([
      function getTxList(done) {
        self.getAddressTxids(addresses, {queryMempool: false}, function(err, txids) {
          if (err) {
            return done(err);
          }
          summaryTxids = txids;
          summary.appearances = txids.length;
          done();
        });
      },
      function getBalance(done) {
        self.getAddressBalance(addresses, Object.assign({}, options, {"includeAssets": true}), function(err, data) {
          if (err) {
            return done(err);
          }
          var balances = {};
          for (var i = 0; i < data.length; i++) {
            var bal = {};
            bal.totalReceived = data[i].received;
            bal.totalSpent = data[i].received - data[i].balance;
            bal.balance = data[i].balance;
            balances[data[i].assetName] = bal;
            if (data[i].assetName == "MEWC") {
              summary.totalReceived = data[i].received;
              summary.totalSpent = data[i].received - data[i].balance;
              summary.balance = data[i].balance;
            }
          }
          summary.balances = balances;
          done();
        });
      },
      function getTags(done) {
        self.listTagsForAddress(addresses, function(err, data) {
          if (err) {
            return done(err);
          }
          summary.tags = data;
          done();
        });
      },
      function getFrozen(done) {
        self.listAddressFrozen(addresses, function(err, data) {
          if (err) {
            return done(err);
          }
          summary.frozen = data;
          done();
        });
      },
      function getMempool(done) {
        if (!queryMempool) {
          return done();
        }
        self.client.getAddressMempool({'addresses': addresses}, function(err, response) {
          if (err) {
            return done(self._wrapRPCError(err));
          }
          mempoolTxids = self._getTxidsFromMempool(response.result);
          summary.unconfirmedAppearances = mempoolTxids.length;
          summary.unconfirmedBalance = self._getBalanceFromMempool(response.result);
          done();
        });
      },
    ], function(err) {
      if (err) {
        return callback(err);
      }
      self.summaryCache.set(cacheKey, summary);
      finishWithTxids();
    });
  }

  if (options.noTxList) {
    var summaryCache = self.summaryCache.get(cacheKey);
    if (summaryCache) {
      callback(null, summaryCache);
    } else {
      querySummary();
    }
  } else {
    querySummary();
  }

};

Meowcoin.prototype._maybeGetBlockHash = function(blockArg, callback) {
  var self = this;
  if (_.isNumber(blockArg) || (blockArg.length < 40 && /^[0-9]+$/.test(blockArg))) {
    self._tryAllClients(function(client, done) {
      client.getBlockHash(blockArg, function(err, response) {
        if (err) {
          return done(self._wrapRPCError(err));
        }
        done(null, response.result);
      });
    }, callback);
  } else {
    callback(null, blockArg);
  }
};

/**
 * Will retrieve a block as a Node.js Buffer
 * @param {String|Number} block - A block hash or block height number
 * @param {Function} callback
 */
Meowcoin.prototype.getRawBlock = function(blockArg, callback) {
  // TODO apply performance patch to the RPC method for raw data
  var self = this;

  function queryBlock(err, blockhash) {
    if (err) {
      return callback(err);
    }
    self._tryAllClients(function(client, done) {
      self.client.getBlock(blockhash, false, function(err, response) {
        if (err) {
          return done(self._wrapRPCError(err));
        }
        var buffer = Buffer.from(response.result, 'hex');
        self.rawBlockCache.set(blockhash, buffer);
        done(null, buffer);
      });
    }, callback);
  }

  var cachedBlock = self.rawBlockCache.get(blockArg);
  if (cachedBlock) {
    return setImmediate(function() {
      callback(null, cachedBlock);
    });
  } else {
    self._maybeGetBlockHash(blockArg, queryBlock);
  }
};

Meowcoin.prototype.getJsonBlock = function(blockArg, callback) {
    var self = this;

    function queryBlock(err, blockhash) {
        if (err) {
            return callback(err);
        }
        var cachedBlock = self.blockJsonCache.get(blockhash);
        if (cachedBlock) {
            return setImmediate(function() {
                callback(null, cachedBlock);
            });
        } else {
            self._tryAllClients(function(client, done) {
                client.getBlock(blockhash, true, function(err, response) {

                    if (err) {
                        return done(self._wrapRPCError(err));
                    }

                    var result = response.result;

                    self.blockJsonCache.set(blockhash, result);

                    done(null, result);
                });
            }, callback);
        }
    }

    self._maybeGetBlockHash(blockArg, queryBlock);
};

/**
 * Similar to getBlockHeader but will include a list of txids
 * @param {String|Number} block - A block hash or block height number
 * @param {Function} callback
 */
Meowcoin.prototype.getBlockOverview = function(blockArg, callback) {
  var self = this;

  function queryBlock(err, blockhash) {
    if (err) {
      return callback(err);
    }
    var cachedBlock = self.blockOverviewCache.get(blockhash);
    if (cachedBlock) {
      return setImmediate(function() {
        callback(null, cachedBlock);
      });
    } else {
      self._tryAllClients(function(client, done) {
        client.getBlock(blockhash, true, function(err, response) {
          if (err) {
            return done(self._wrapRPCError(err));
          }
          var result = response.result;
          var blockOverview = {
            hash: result.hash,
            version: result.version,
            confirmations: result.confirmations,
            height: result.height,
            chainWork: result.chainwork,
            prevHash: result.previousblockhash,
            nextHash: result.nextblockhash,
            merkleRoot: result.merkleroot,
            time: result.time,
            medianTime: result.mediantime,
            nonce: result.nonce,
            bits: result.bits,
            difficulty: result.difficulty,
            txids: result.tx
          };
          self.blockOverviewCache.set(blockhash, blockOverview);
          done(null, blockOverview);
        });
      }, callback);
    }
  }

  self._maybeGetBlockHash(blockArg, queryBlock);
};

/**
 * Will retrieve a block as a Meowcoincore object
 * @param {String|Number} block - A block hash or block height number
 * @param {Function} callback
 */
Meowcoin.prototype.getBlock = function(blockArg, callback) {
  // TODO apply performance patch to the RPC method for raw data
  var self = this;

  function queryBlock(err, blockhash) {
    if (err) {
      return callback(err);
    }
    var cachedBlock = self.blockCache.get(blockhash);
    if (cachedBlock) {
      return setImmediate(function() {
        callback(null, cachedBlock);
      });
    } else {
      self._tryAllClients(function(client, done) {
        client.getBlock(blockhash, false, function(err, response) {
          if (err) {
            return done(self._wrapRPCError(err));
          }
          var blockObj = meowcoincore.Block.fromString(response.result);
          self.blockCache.set(blockhash, blockObj);
          done(null, blockObj);
        });
      }, callback);
    }
  }

  self._maybeGetBlockHash(blockArg, queryBlock);
};

/**
 * Will retrieve an array of block hashes within a range of timestamps
 * @param {Number} high - The more recent timestamp in seconds
 * @param {Number} low - The older timestamp in seconds
 * @param {Function} callback
 */
Meowcoin.prototype.getBlockHashesByTimestamp = function(high, low, options, callback) {
  var self = this;
  if (_.isFunction(options)) {
    callback = options;
    options = {};
  }
  self.client.getBlockHashes(high, low, options, function(err, response) {
    if (err) {
      return callback(self._wrapRPCError(err));
    }
    callback(null, response.result);
  });
};

/**
 * Will return the block index information, the output will have the format:
 * {
 *   hash: '0000000000000a817cd3a74aec2f2246b59eb2cbb1ad730213e6c4a1d68ec2f6',
 *   confirmations: 5,
 *   height: 828781,
 *   chainWork: '00000000000000000000000000000000000000000000000ad467352c93bc6a3b',
 *   prevHash: '0000000000000504235b2aff578a48470dbf6b94dafa9b3703bbf0ed554c9dd9',
 *   nextHash: '00000000000000eedd967ec155f237f033686f0924d574b946caf1b0e89551b8'
 *   version: 536870912,
 *   merkleRoot: '124e0f3fb5aa268f102b0447002dd9700988fc570efcb3e0b5b396ac7db437a9',
 *   time: 1462979126,
 *   medianTime: 1462976771,
 *   nonce: 2981820714,
 *   bits: '1a13ca10',
 *   difficulty: 847779.0710240941,
 * }
 * @param {String|Number} block - A block hash or block height
 * @param {Function} callback
 */
Meowcoin.prototype.getBlockHeader = function(blockArg, callback) {
  var self = this;

  function queryHeader(err, blockhash) {
    if (err) {
      return callback(err);
    }
    self._tryAllClients(function(client, done) {
      client.getBlockHeader(blockhash, function(err, response) {
        if (err) {
          return done(self._wrapRPCError(err));
        }
        var result = response.result;
        var header = {
          hash: result.hash,
          version: result.version,
          confirmations: result.confirmations,
          height: result.height,
          chainWork: result.chainwork,
          prevHash: result.previousblockhash,
          nextHash: result.nextblockhash,
          merkleRoot: result.merkleroot,
          time: result.time,
          medianTime: result.mediantime,
          nonce: result.nonce,
          bits: result.bits,
          difficulty: result.difficulty
        };
        done(null, header);

      });
    }, callback);
  }

  self._maybeGetBlockHash(blockArg, queryHeader);
};

/**
 * Will estimate the fee per kilobyte.
 * @param {Number} blocks - The number of blocks for the transaction to be confirmed.
 * @param {Function} callback
 */
Meowcoin.prototype.estimateFee = function(blocks, callback) {
  var self = this;
  this.client.estimateFee(blocks, function(err, response) {
    if (err) {
      return callback(self._wrapRPCError(err));
    }
    callback(null, response.result);
  });
};

Meowcoin.prototype.estimateSmartFee = function(blocks, conservative, callback) {
  var self = this;
  this.client.estimateSmartFee(blocks, conservative ? 'CONSERVATIVE' : 'ECONOMICAL', function(err, response) {
    if (err) {
      return callback(self._wrapRPCError(err));
    }
    var result;
    if (response.result.errors != null) {
      result = -1; // note - this happens only on start with insufficient data
    } else {
      result = response.result.feerate;
    }
    callback(null, result);
  });
};


/**
 * Will add a transaction to the mempool and relay to connected peers
 * @param {String|Transaction} transaction - The hex string of the transaction
 * @param {Object=} options
 * @param {Boolean=} options.allowAbsurdFees - Enable large fees
 * @param {Function} callback
 */
Meowcoin.prototype.sendTransaction = function(tx, options, callback) {
  var self = this;
  var allowAbsurdFees = false;
  if (_.isFunction(options) && _.isUndefined(callback)) {
    callback = options;
  } else if (_.isObject(options)) {
    allowAbsurdFees = options.allowAbsurdFees;
  }

  this.client.sendRawTransaction(tx, allowAbsurdFees, function(err, response) {
    if (err) {
      return callback(self._wrapRPCError(err));
    }

    if (typeof self.options.sendTxLog === 'string') {
      fs.appendFile(self.options.sendTxLog, tx + '\n', function(error) {
        if (error) {
          // error on logging tx -> write to error log, but still return success to user
          console.error(error);
        }
        callback(null, response.result);
      });
    } else {
      callback(null, response.result);
    }
  });

};

/**
 * Will get a transaction as a Node.js Buffer. Results include the mempool.
 * @param {String} txid - The transaction hash
 * @param {Function} callback
 */
Meowcoin.prototype.getRawTransaction = function(txid, callback) {
  var self = this;
  var tx = self.rawTransactionCache.get(txid);
  if (tx) {
    return setImmediate(function() {
      callback(null, tx);
    });
  } else {
    self._tryAllClients(function(client, done) {
      client.getRawTransaction(txid, function(err, response) {
        if (err) {
          return done(self._wrapRPCError(err));
        }
        var buffer = Buffer.from(response.result, 'hex');
        self.rawTransactionCache.set(txid, buffer);
        done(null, buffer);
      });
    }, callback);
  }
};

/**
+ * Will get a transaction as a Node.js Buffer. Results include the mempool.
+ * @param {String} txid - The transaction hash
+ * @param {Function} callback
+ */
Meowcoin.prototype.getJsonRawTransaction = function(txid, callback) {
  var self = this;
  var tx = self.rawJsonTransactionCache.get(txid);
  if (tx) {
    return setImmediate(function() {
      callback(null, tx);
    });
  } else {
    self._tryAllClients(function(client, done) {
      client.getRawTransaction(txid, 1, function(err, response) {

        if (err) {
          return done(self._wrapRPCError(err));
        }

        self.rawJsonTransactionCache.set(txid, response.result);
        done(null, response.result);
      });
    }, callback);
  }
};

/**
 * Will get a transaction as a Meowcoincore Transaction. Results include the mempool.
 * @param {String} txid - The transaction hash
 * @param {Boolean} queryMempool - Include the mempool
 * @param {Function} callback
 */
Meowcoin.prototype.getTransaction = function(txid, callback) {
  var self = this;
  var tx = self.transactionCache.get(txid);
  if (tx) {
    return setImmediate(function() {
      callback(null, tx);
    });
  } else {
    self._tryAllClients(function(client, done) {
      client.getRawTransaction(txid, function(err, response) {
        if (err) {
          return done(self._wrapRPCError(err));
        }
        var tx = Transaction();
        tx.fromString(response.result);
        self.transactionCache.set(txid, tx);
        done(null, tx);
      });
    }, callback);
  }
};

/**
 * Will get a detailed view of a transaction including addresses, amounts and fees.
 *
 * Example result:
 * {
 *   blockHash: '000000000000000002cd0ba6e8fae058747d2344929ed857a18d3484156c9250',
 *   height: 411462,
 *   blockTimestamp: 1463070382,
 *   version: 1,
 *   hash: 'de184cc227f6d1dc0316c7484aa68b58186a18f89d853bb2428b02040c394479',
 *   locktime: 411451,
 *   coinbase: true,
 *   inputs: [
 *     {
 *       prevTxId: '3d003413c13eec3fa8ea1fe8bbff6f40718c66facffe2544d7516c9e2900cac2',
 *       outputIndex: 0,
 *       sequence: 123456789,
 *       script: [hexString],
 *       scriptAsm: [asmString],
 *       address: '1LCTmj15p7sSXv3jmrPfA6KGs6iuepBiiG',
 *       satoshis: 771146
 *     }
 *   ],
 *   outputs: [
 *     {
 *       satoshis: 811146,
 *       script: '76a914d2955017f4e3d6510c57b427cf45ae29c372c99088ac',
 *       scriptAsm: 'OP_DUP OP_HASH160 d2955017f4e3d6510c57b427cf45ae29c372c990 OP_EQUALVERIFY OP_CHECKSIG',
 *       address: '1LCTmj15p7sSXv3jmrPfA6KGs6iuepBiiG',
 *       spentTxId: '4316b98e7504073acd19308b4b8c9f4eeb5e811455c54c0ebfe276c0b1eb6315',
 *       spentIndex: 1,
 *       spentHeight: 100
 *     }
 *   ],
 *   inputSatoshis: 771146,
 *   outputSatoshis: 811146,
 *   feeSatoshis: 40000
 * };
 *
 * @param {String} txid - The hex string of the transaction
 * @param {Function} callback
 */
Meowcoin.prototype.getDetailedTransaction = function(txid, callback) {
  var self = this;
  var tx = self.transactionDetailedCache.get(txid);

  function addInputsToTx(tx, result) {
    tx.inputs = [];
    tx.inputSatoshis = 0;
    for(var inputIndex = 0; inputIndex < result.vin.length; inputIndex++) {
      var input = result.vin[inputIndex];
      if (!tx.coinbase) {
        tx.inputSatoshis += input.valueSat;
      }
      var script = null;
      var scriptAsm = null;
      if (input.scriptSig) {
        script = input.scriptSig.hex;
        scriptAsm = input.scriptSig.asm;
      } else if (input.coinbase) {
        script = input.coinbase;
      }
      tx.inputs.push({
        prevTxId: input.txid || null,
        outputIndex: _.isUndefined(input.vout) ? null : input.vout,
        script: script,
        scriptAsm: scriptAsm || null,
        sequence: input.sequence,
        address: input.address || null,
        satoshis: _.isUndefined(input.valueSat) ? null : input.valueSat
      });
    }
  }

  function addOutputsToTx(tx, result) {
    tx.outputs = [];
    tx.outputSatoshis = 0;
    for(var outputIndex = 0; outputIndex < result.vout.length; outputIndex++) {
      var out = result.vout[outputIndex];
      tx.outputSatoshis += out.valueSat;
      var address = null;
      if (out.scriptPubKey && out.scriptPubKey.addresses && out.scriptPubKey.addresses.length === 1) {
        address = out.scriptPubKey.addresses[0];
      }
      var transformedOut = {
        satoshis: out.valueSat,
        script: out.scriptPubKey.hex,
        scriptAsm: out.scriptPubKey.asm,
        spentTxId: out.spentTxId,
        spentIndex: out.spentIndex,
        spentHeight: out.spentHeight,
        address: address,
      };
      // assets
      if (Asset.isAssetScriptType(out.scriptPubKey.type) && out.scriptPubKey.asset) {
        transformedOut.assetType = out.scriptPubKey.type;
        transformedOut.asset = out.scriptPubKey.asset;
      }
      tx.outputs.push(transformedOut);
    }
  }

  if (tx) {

    return setImmediate(function() {
      callback(null, tx);
    });

  } else {

    return self._tryAllClients(function(client, done) {

      return async.waterfall([
        function (callback) {

          return client.getRawTransaction(txid, 1, function(err, response) {

              if (err) {
                  return callback(err);
                  // return done(self._wrapRPCError(err));
              }

              var result = response.result;

              // returns vsize for segwit-positive coins,
              // regular size if segwit is disbled
              var size = result.vsize == null ? result.size : result.vsize;
              var tx = {
                  hex: result.hex,
                  blockHash: result.blockhash,
                  height: result.height ? result.height : -1,
                  blockTimestamp: result.time,
                  version: result.version,
                  hash: txid,
                  locktime: result.locktime,
                  size: size,
              };

              if (result.vin[0] && result.vin[0].coinbase) {
                  tx.coinbase = true;
              }

              addInputsToTx(tx, result);
              addOutputsToTx(tx, result);

              if (!tx.coinbase) {
                  tx.feeSatoshis = tx.inputSatoshis - tx.outputSatoshis;
              } else {
                  tx.feeSatoshis = 0;
              }

              return callback(null, tx);
              // done(null, tx);
          });

      }, function(tx, callback) {
          if (tx.height !== -1) {
            return callback(null, tx);
          }

          return self.client.getMempoolEntry(txid, function(err, response) {

            if (err && err.code !== -5) {
              return callback(err, tx);
            }

            if (err && err.code === -5) {
              return callback(null, tx);
            }

            var txInfo = response.result;

            if (txInfo && txInfo.time) {
              tx.receivedTime = txInfo.time;
            }

            return callback(null, tx);

          });
      }], function (err, tx) {

          if (err) {
              return done(self._wrapRPCError(err));
          }

          self.transactionDetailedCache.set(txid, tx);

          return done(null, tx);
      });


    }, callback);
  }
};

/**
 * Will get the best block hash for the chain.
 * @param {Function} callback
 */
Meowcoin.prototype.getBestBlockHash = function(callback) {
  var self = this;
  this.client.getBestBlockHash(function(err, response) {
    if (err) {
      return callback(self._wrapRPCError(err));
    }
    callback(null, response.result);
  });
};

/**
 * Will give the txid and inputIndex that spent an output
 * @param {Function} callback
 */
Meowcoin.prototype.getSpentInfo = function(options, callback) {
  var self = this;
  this.client.getSpentInfo(options, function(err, response) {
    if (err && err.code === -5) {
      return callback(null, {});
    } else if (err) {
      return callback(self._wrapRPCError(err));
    }
    callback(null, response.result);
  });
};

/**
 * This will return information about the database in the format:
 * {
 *   version: 110000,
 *   protocolVersion: 70002,
 *   walletversion: 130000,
 *   balance: 0.00000000,
 *   blocks: 151,
 *   timeOffset: 0,
 *   connections: 0,
 *   difficulty: 4.6565423739069247e-10,
 *   testnet: false,
 *   keypoololdest: 1489485291,
 *   keypoolsize: 101,
 *   network: 'testnet',
 *   paytxfee: 0.00000000,
 *   relayFee: 1000,
 *   errors: ''
 * }
 * @param {Function} callback
 */
Meowcoin.prototype.getInfo = function(callback) {
  var self = this;
  this.client.getInfo(function(err, response) {
    if (err) {
      return callback(self._wrapRPCError(err));
    }
    self.client.getNetworkInfo(function(err, netResponse) {

      if (err) {
        return callback(self._wrapRPCError(err));
      }
      var result = response.result;
      var netResult = netResponse.result;
      var info = {
        version: result.version,
        protocolVersion: result.protocolversion,
        walletversion: result.walletversion,
        balance: result.balance,
        blocks: result.blocks,
        timeOffset: result.timeoffset,
        connections: result.connections,
        proxy: result.proxy,
        difficulty: result.difficulty,
        testnet: result.testnet,
        keypoololdest: result.keypoololdest,
        keypoolsize: result.keypoolsize,
        paytxfee: result.paytxfee,
        relayFee: result.relayfee,
        errors: result.errors,
        network: self.node.getNetworkName(),
        subversion: netResult.subversion,
        localServices: netResult.localservices,
        reward: self.getBlockReward(result.blocks)
      };
      callback(null, info);
    });
  });
};

Meowcoin.prototype.generateBlock = function(num, callback) {
  var self = this;
  this.client.generate(num, function(err, response) {
    if (err) {
      return callback(self._wrapRPCError(err));
    }
    callback(null, response.result);
  });
};

/**
 * Called by Node to stop the service.
 * @param {Function} callback
 */
Meowcoin.prototype.stop = function(callback) {
  if (this.spawn && this.spawn.process) {
    var exited = false;
    this.spawn.process.once('exit', function(code) {
      if (!exited) {
        exited = true;
        if (code !== 0) {
          var error = new Error('meowcoind spawned process exited with status code: ' + code);
          error.code = code;
          return callback(error);
        } else {
          return callback();
        }
      }
    });
    this.spawn.process.kill('SIGINT');
    setTimeout(function() {
      if (!exited) {
        exited = true;
        return callback(new Error('meowcoind process did not exit'));
      }
    }, this.shutdownTimeout).unref();
  } else {
    callback();
  }
};

Meowcoin.prototype.getBlockReward = function(height) {
  var halvings = Math.floor(height / 2100000);
  // Force block reward to zero when right shift is undefined.
  if (halvings >= 64) {
    return 0;
  }

  // Subsidy is cut in half every 2,100,000 blocks which will occur approximately every 4 years.
  var subsidy = new BN(5000 * 1e8);
  subsidy = subsidy.shrn(halvings);

  return parseInt(subsidy.toString(10));
};

/**
 * @param {String} asset - Name of an asset.  Trailing '*' is treated as wildcard.
 * @param {Boolean} verbose - False returns just a list of asset names.  True returns map of name to metadata.
 * @param {Number} size - The size the result set will be truncated to.
 * @param {Number} skip - The number of results to skip over before adding to the result set.  Only valid if size is > 0.
 * @param {Function} callback
 */
 Meowcoin.prototype.listAssets = function(asset, verbose, size, skip, callback) {
  var self = this;

  this.client.listAssets(asset, verbose, size, skip, function(err, response) {
    if (err) {
      return callback(self._wrapRPCError(err));
    }
    callback(null, response.result);
  });
};

Meowcoin.prototype.listGlobalFrozen = function(callback) {
  var self = this;

  this.client.listGlobalRestrictions(function(err, response) {
    if (err) {
      return callback(self._wrapRPCError(err));
    }
    callback(null, response.result);
  });
};

Meowcoin.prototype.getVerifierString = function(asset, callback) {
  var self = this;

  asset = asset.startsWith("$") ? asset : "$" + asset;

  this.client.getVerifierString(asset, function(err, response) {
    if (err) {
      return callback(self._wrapRPCError(err));
    }
    callback(null, response.result);
  });
};

Meowcoin.prototype.listAddressesForTag = function(asset, callback) {
  var self = this;

  asset = asset.startsWith("#") ? asset : "#" + asset;

  this.client.listAddressesForTag(asset, function(err, response) {
    if (err) {
      return callback(self._wrapRPCError(err));
    }
    callback(null, response.result);
  });  
};

Meowcoin.prototype.checkVerifier = function(verifier, callback) {
  var self = this;

  this.client.isValidVerifierString(verifier, function(err, response) {
    if (err) {
      return callback(self._wrapRPCError(err));
    }
    callback(null, response.result);
  });
};

Meowcoin.prototype.listTagsForAddress = function(address, callback) {
  var self = this;

  this.client.listTagsForAddress(address, function(err, response) {
    if (err) {
      return callback(self._wrapRPCError(err));
    }
    callback(null, response.result);
  });
};

Meowcoin.prototype.listAddressFrozen = function(address, callback) {
  var self = this;

  this.client.listAddressRestrictions(address, function(err, response) {
    if (err) {
      return callback(self._wrapRPCError(err));
    }
    callback(null, response.result);
  });
};

/**
 * @param {Number} minConf - The minimum confirmations to filter
 * @param {Number} maxConf - The maximum confirmations to filter
 * @param {Array} addresses - A array of quantum addresses to filter
 * @param {Function} callback
 */
Meowcoin.prototype.listUnspent = function(minConf, maxConf, addresses, callback) {
    var self = this;

    this.client.listUnspent(minConf, maxConf, addresses, function(err, response) {
        if (err) {
            return callback(self._wrapRPCError(err));
        }
        callback(null, response.result);
    });
};

/**
 * @param {Function} callback
 */

/**
 *
 * @param {Function} callback
 * @return {*}
 */
Meowcoin.prototype.getMiningInfo = function(callback) {
    var self = this;
    this.client.getMiningInfo(function(err, response) {
		if (err) {
			return callback(self._wrapRPCError(err));
		}
		var result = response.result;
		var info = {
			difficulty: result.difficulty,
			networkhashps: result.networkhashps
		};
		callback(null, info);
    });
};
Meowcoin.prototype.getNetworkHash = function(height, callback) {
    var self = this;
        var cachedBlock = self.netHashCache.get(height);
        if (cachedBlock) {
            return setImmediate(function() {
                callback(null, cachedBlock);
            });
        } else {
            this.client.getNetworkHashps(120, height, function(err, response) {
                if (err) {
                    return callback(self._wrapRPCError(err));
                }
                  var result = response.result;

                  self.netHashCache.set(height, result);

                  callback(null, result);
            });
        }
};

Meowcoin.prototype.getPeerInfo = function(callback) {
    var self = this;
    this.client.getPeerInfo(function(err, response) {
		if (err) {
			return callback(self._wrapRPCError(err));
		}
		var result = response;

		callback(null, result);
    });
};

module.exports = Meowcoin;
