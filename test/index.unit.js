'use strict';

var should = require('chai').should();

describe('Index Exports', function() {
  it('will export meowcoincore-lib', function() {
    var meowcoincore = require('../');
    should.exist(meowcoincore.lib);
    should.exist(meowcoincore.lib.Transaction);
    should.exist(meowcoincore.lib.Block);
  });
});
