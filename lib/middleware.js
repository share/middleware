var Transform = require('stream').Transform;
var async = require('async');

var UserAgent = require('./useragent');

module.exports = Middleware;

// This object contains the livedb middleware exposes helper methods for
// userAgent to call in to it.
function Middleware(backend) {
  if (!(this instanceof Middleware)) return new Middleware(backend);

  // The livedb instance we wrap
  this.backend = backend;
  
  // Map from event name (or '') to a list of middleware.
  this.methods = {'':[]};
  this.docFilters = [];
  this.opFilters = [];
};

// Return a new useragent with the livedb methods available.
Middleware.prototype.as = function(session) {
  return new UserAgent(this, session);
};

/** Add middleware to an action. The action is optional (if not specified, the
 * middleware fires on every action).
 */
Middleware.prototype.use = function(action, middleware) {
  if (typeof action !== 'string') {
    middleware = action;
    action = '';
  }

  if (action === 'fetch' || action === 'subscribe') {
    throw new Error("fetch and subscribe middleware not implemented - add 'bulk fetch' or 'bulk subscribe' instead");
  }

  var methods = this.methods[action];
  if (!methods) methods = this.methods[action] = [];

  methods.push(middleware);
};

/** Add a function to filter all data going to the current client */
Middleware.prototype.filter = function(fn) {
  this.docFilters.push(fn);
};

Middleware.prototype.filterOps = function(fn) {
  this.opFilters.push(fn);
};


// ****** Internal methods for triggering middleware from useragent.js

/**
 * Helper to wrap eachSeries on the data. Data is modified in place.
 */
Middleware.prototype._runFilters = function(filters, collection, docName, data, callback) {
  var self = this;
  async.eachSeries(filters, function(filter, next) {
    filter.call(self, collection, docName, data, next);
  }, function(error) {
    callback(error, error ? null : data);
  });
};

Middleware.prototype.runDocFilters = function(collection, docName, data, callback) {
  return this._runFilters(this.docFilters, collection, docName, data, callback);
};

Middleware.prototype.runOpFilters = function(collection, docName, ops, callback) {
  return this._runFilters(this.opFilters, collection, docName, ops, callback);
};

// This is only used by bulkFetch, but its enough logic that I prefer to
// separate it out.
//
// Its basically async.each() over the map of input data
// data is a map from collection name -> doc name -> data.
Middleware.prototype.runBulkDocFilters = function(data, callback) {
  var work = 1;
  var done = function() {
    work--;
    if (work === 0 && callback) callback(null, data);
  }

  for (var cName in data) {
    for (var docName in data[cName]) {
      work++;
      this.runDocFilters(cName, docName, data[cName][docName], function(err) {
        if (err && callback) {
          callback(err);
          callback = null;
        }

        done();
      });
    }
  }

  done();
};

/**
 * Filter the data passed through the stream with `runOpFilters()`.
 *
 * Returns a new stream that let's us only read these messages from stream which
 * where not filtered by `this.runOpFilters(collection, docName, message)`. If the
 * filter chain calls an error we read a `{error: 'description'}` message from the
 * stream.
 *
 * This is used by subscribe and transitively by bulkSubscribe.
 */
Middleware.prototype.wrapOpStream = function(collection, docName, stream) {
  var middleware = this;
  var passthrough = new Transform({objectMode:true});

  passthrough._transform = transform;
  function transform(data, encoding, callback) {
    middleware.runOpFilters(collection, docName, [data], function(err, data) {
      passthrough.push(err ? {error: err} : data[0]);
      callback();
    });
  };

  passthrough.destroy = destroyPassthrough;
  function destroyPassthrough() {
    stream.destroy();
  };

  stream.pipe(passthrough);
  return passthrough;
};


/**
 * Helper to apply `wrapOpStream()` to each stream in a bulk request.
 *
 * `streams` is a map `collection -> docName -> stream`. It returns the same map
 * with the streams wrapped.
 */
Middleware.prototype.wrapOpStreams = function(streams) {
  for (var cName in streams) {
    for (var docName in streams[cName]) {
      streams[cName][docName] = this.wrapOpStream(cName, docName, streams[cName][docName]);
    }
  }
  return streams;
};

// Helper to filter query result sets
Middleware.prototype.filterQueryResults = function(collection, results, callback) {
  // The filter function is asyncronous. We can run all of the query results in parallel.
  var middleware = this;
  async.each(results, function(data, innerCb) {
    middleware.runDocFilters(collection, data.docName, data, innerCb);
  }, function(error) {
    callback(error, results);
  });
};


/**
 * Passes request through the methods stack
 *
 * Extensions may modify the request object. After all middlewares have been
 * invoked we call `callback` with `null` and the modified request.
 * If one of the methods resturns an error the callback is called with that
 * error.
 */
Middleware.prototype.runMethod = function(request, callback) {
  // Copying the triggers we'll fire so they don't get edited while we iterate.
  var middlewares = (this.methods[request.action] || []).concat(this.methods['']);
  var backend = this.backend;

  var next = function() {
    // I'm passing backend directly to the callback to make it harder to make
    // mistakes in the useragent code (where backend is used directly without
    // calling .runMethod() first).
    if (!middlewares.length)
      return callback ? callback(null, backend, request) : undefined;

    // Slightly slower than middleware[i++] but cleaner.
    var middleware = middlewares.shift();

    // The callback is optional in middleware - if its not specified, next() is
    // called automatically, syncronously after the middleware runs.
    if (middleware.length === 1) {
      middleware(request);
      next();
    } else {
      middleware(request, function(err) {
        if (err) return callback ? callback(err) : undefined;

        next();
      });
    }
  };

  next();
};

/**
 * Builds a request, passes it through the middleware's extension stack for the
 * action and calls callback with the request.
 */
Middleware.prototype.trigger = function(agent, action, collection, docName, request, callback) {
  if (typeof request === 'function') {
    callback = request;
    request = {};
  }

  request.agent = agent;
  request.action = action;
  if (collection) request.collection = collection;
  if (docName) request.docName = docName;
  request.backend = this.backend;

  // process.nextTick because the client assumes that it is receiving messages
  // asynchronously and if you have a syncronous stream, we need to force it to
  // be asynchronous.
  var self = this;
  process.nextTick(function() {
    self.runMethod(request, callback);
  });
};

