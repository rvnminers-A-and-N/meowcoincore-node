'use strict';

var createError = require('errno').create;

var MeowcoincoreNodeError = createError('MeowcoincoreNodeError');

var RPCError = createError('RPCError', MeowcoincoreNodeError);

module.exports = {
  Error: MeowcoincoreNodeError,
  RPCError: RPCError
};
