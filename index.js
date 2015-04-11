'use strict';

var Manifest = require('level-manifest')

var Q = require('q')
var __hop = {}.hasOwnProperty

exports = module.exports = install
exports.install = install

function install(db) {
  _install(db, new Manifest(db))
  return db
}

function _install(db, manifest) {
  var methods = manifest.methods
  if (!('close' in methods)) methods.close = { type: 'async' } // hack until level-manifest is updated

  for (var methodName in methods) {
    if (!__hop.call(methods, methodName)) continue

    if (methodName === 'batch') {
      promisifyBatch(db)
      continue
    }

    var method = methods[methodName]
    switch (method.type) {
      case 'async':
        substitute(db, methodName)
        break
      case 'readable':
      case 'writable':
        fromStream(db, methodName)
        break
      case 'object':
        _install(db[methodName], method)
        break
    }
  }

  var sublevels = manifest.sublevels || {}
  for (var sublevelName in sublevels) {
    if (__hop.call(sublevels, sublevelName)) {
      _install(db.sublevels[sublevelName], sublevels[sublevelName])
    }
  }

  if (typeof db.sublevel == 'function') {
    var Sublevel = db.sublevel
    db.sublevel = function(sublevelName) {
      var existing = __hop.call(sublevels, sublevelName)
      var sublevel = Sublevel.apply(this, arguments)
      if (!existing) _install(sublevel, new Manifest(sublevel))
      return sublevel
    }
  }
}

function promisifyBatch(db) {
  var orig = db.batch.bind(db)
  db.batch = function() {
    if (arguments.length) return callSubstitute(this, orig, arguments)
    // TODO: remove throw err when https://github.com/dominictarr/level-hooks/issues/7 is resolved
    else throw new Error('chained form is not supported yet')

    var batch = orig.call(db)
    batch.write = Q.nbind(batch.write, batch)
    return batch
  }
}

function substitute(db, methodName) {
  var orig = db[methodName].bind(db)
  db[methodName] = function() {
    return callSubstitute(this, orig, arguments)
  }
}

function callSubstitute(ctx, orig, args) {
  if (typeof args[args.length - 1] === 'function')
    return orig.apply(ctx, args)
  else
    return Q.nfapply(orig, args)
}

function fromStream(db, methodName) {
  var orig = db[methodName]
  db[methodName] = function() {
    var stream = orig.apply(this, arguments)
    if (typeof stream.then === 'function') return stream

    var defer = Q.defer()
    var failed
    stream.on('data', function(data) {
      defer.notify(data)
    })

    stream.on('error', function(err) {
      failed = true
      defer.reject(err)
    })

    stream.on('close', function() {
      if (!failed) defer.resolve()
    })

    // augment stream with promise API
    var promise = defer.promise
    var pProto = promise.constructor.prototype
    for (var p in pProto) {
      if (__hop.call(pProto, p)) {
        stream[p] = promise[p].bind(promise)
      }
    }

    return stream
  }
}
