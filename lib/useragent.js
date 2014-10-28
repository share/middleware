var EventEmitter = require('events').EventEmitter;

/**
 * Provides access to the backend of `middleware`.
 *
 * Create a user agent accessing a share middleware
 *
 *   userAgent = new UserAgent(middleware)
 *
 * The user agent exposes the following API to communicate asynchronously with
 * the share instances backend.
 * - submit (submit)
 * - fetch (fetch)
 * - subscribe (subscribe)
 * - getOps (get ops)
 * - query (query)
 * - queryFetch (query)
 *
 *
 * Middleware
 * ----------
 * Each of the API methods also triggers an action (given in brackets) on the
 * share middleware. This enables middleware to modifiy the requests and results
 * By default the request passed to the middleware contains the properties
 * - action
 * - agent
 * - backend
 * - collection
 * - docName
 * The `collection` and `docName` properties are only set if applicable. In
 * addition each API method extends the request object with custom properties.
 * These are documented with the methods.
 *
 *
 * Filters
 * -------
 * The documents provided by the `fetch`, `query` and `queryFetch` methods are
 * filtered with the share middleware's `docFilters`.
 *
 *   middleware.filter(function(collection, docName, docData, next) {
 *     if (docName == "mario") {
 *       docData.greeting = "It'se me: Mario";
 *       next();
 *     } else {
 *       next("Document not found!");
 *     }
 *   });
 *   userAgent.fetch('people', 'mario', function(error, data) {
 *     data.greeting; // It'se me
 *   });
 *   userAgent.fetch('people', 'peaches', function(error, data) {
 *     error == "Document not found!";
 *   });
 *
 * In a filter `this` is the user agent.
 *
 * Similarily we can filter the operations that a client can see
 *
 *   middleware.filterOps(function(collection, docName, opData, next) {
 *     if (opData.op == 'cheat')
 *       next("Not on my watch!");
 *     else
 *       next();
 *     }
 *   });
 *
 */
var UserAgent = function(middleware) {
  if (!(this instanceof UserAgent)) return new UserAgent(middleware);

  this.middleware = middleware;
  //this.backend = middleware.backend;

  this.connectTime = new Date();

  this._connectCalled = false;
};

module.exports = UserAgent;


// Helper wrapper around Middleware.trigger.
UserAgent.prototype._trigger = function(action, collection, docName, request, callback) {
  // This is a weird place to put this check, but its called at the start of
  // all the functions below.
  if (action !== 'connect' && !this._connectCalled)
    throw Error("UserAgent did not trigger connect before calling method " + action);

  this.middleware.trigger(this, action, collection, docName, request, callback);
};

// This is the one method which doesn't exist in livedb's API. It must be
// called on every useragent before any other methods.
UserAgent.prototype.connect = function(stream, initialReq, callback) {
  var agent = this;
  agent._trigger('connect', null, null, {stream:stream, initialReq:initialReq}, function(err) {
    if (!err) agent._connectCalled = true;
    callback(err);
  });
};

/**
 * Fetch current snapshot of a document
 *
 * Triggers the `fetch` action. The actual fetch is performed with collection
 * and docName from the middleware request.
 */
UserAgent.prototype.fetch = function(collection, docName, callback) {
  var agent = this;

  agent._trigger('fetch', collection, docName, function(err, backend, action) {
    if (err) return callback(err);
    collection = action.collection;
    docName = action.docName;

    backend.fetch(collection, docName, function(err, data) {
      if (err) return callback(err);
      if (data) {
        agent.middleware.runDocFilters(collection, docName, data, callback);
      } else {
        callback(null, data);
      }
    });
  });
};

var bulkFetchRequestsEmpty = function(requests) {
  for (var cName in requests) {
    if (requests[cName].length) return false;
  }
  return true;
};

// requests is a map from collection -> [docName]
UserAgent.prototype.bulkFetch = function(requests, callback) {
  var agent = this;

  // TODO: Make this work with 'fetch' middleware too.

  agent._trigger('bulk fetch', null, null, {requests:requests}, function(err, backend, action) {
    if (err) return callback(err);
    requests = action.requests;

    if (bulkFetchRequestsEmpty(requests)) return callback(null, {});

    backend.bulkFetch(requests, function(err, data) {
      if (err) return callback(err);

      agent.middleware.runBulkDocFilters(data, callback);
    });
  });
};


/**
 * Get all operations on this document with version in [start, end).
 *
 * Tiggers `get ops` action with requst
 *   { start: start, end: end }
 */
UserAgent.prototype.getOps = function(collection, docName, start, end, callback) {
  var agent = this;

  agent._trigger('get ops', collection, docName, {start:start, end:end}, function(err, backend, action) {
    if (err) return callback(err);

    backend.getOps(action.collection, action.docName, start, end, function(err, results) {
      if (err) return callback(err);

      agent.middleware.runOpFilters(collection, docName, results, callback);
    });
  });
};

/**
 * Get stream of operations for a document.
 *
 * On success it resturns a readable stream of operations for this document.
 *
 * Triggers the `subscribe` action with request
 *   { version: version }
 */
UserAgent.prototype.subscribe = function(collection, docName, version, callback) {
  var agent = this;

  agent._trigger('subscribe', collection, docName, {version:version}, function(err, backend, action) {
    if (err) return callback(err);

    collection = action.collection;
    docName = action.docName;
    version = action.version;

    backend.subscribe(collection, docName, version, function(err, stream) {
       callback(err, err ? null : agent.middleware.wrapOpStream(collection, docName, stream));
    });
  });
};

// requests is a map from cName -> docName -> version.
UserAgent.prototype.bulkSubscribe = function(requests, callback) {
  var agent = this;

  // TODO: make this call subscribe middleware too.

  // Use a bulk subscribe to check everything in one go.
  agent._trigger('bulk subscribe', null, null, {requests:requests}, function(err, backend, action) {
    if (err) return callback(err);
    requests = action.requests;

    backend.bulkSubscribe(requests, function(err, streams) {
      callback(err, err ? null : agent.middleware.wrapOpStreams(streams));
    });
  });
};

// This function bothers me somehow, and I'm not sure if I should get rid of it
// or what. Its basically just a convenience method, with new sources of bugs.
UserAgent.prototype.fetchAndSubscribe = function(collection, docName, callback) {
  var agent = this;

  agent._trigger('fetch', collection, docName, function(err, backend, action) {
    if (err) return callback(err);
    agent._trigger('subscribe', action.collection, action.docName, function(err, backend, action) {
      if (err) return callback(err);

      collection = action.collection;
      docName = action.docName;

      backend.fetchAndSubscribe(action.collection, action.docName, function(err, data, stream) {
        if (err) return callback(err);

        agent.middleware.runDocFilters(collection, docName, data, function (err, data) {
          if (err) return callback(err);

          var wrappedStream = agent.middleware.wrapOpStream(collection, docName, stream);
          callback(null, data, wrappedStream);
        });
      });
    });
  });
};


/**
 * Submits an operation.
 *
 * On success it returns the version and the operation.
 *
 * Triggers the `submit` action with request
 *   { opData: opData, channelPrefix: null }
 * and the `after submit` action with the request
 *   { opData: opData, snapshot: modifiedSnapshot }
 */
UserAgent.prototype.submit = function(collection, docName, opData, options, callback) {
  if (typeof options === 'function') {
    callback = options;
    options = {};
  }

  var agent = this;
  agent._trigger('submit', collection, docName, {opData: opData, channelPrefix:null}, function(err, backend, action) {
    if (err) return callback(err);

    collection = action.collection;
    docName = action.docName;
    opData = action.opData;
    options.channelPrefix = action.channelPrefix;

    //if (!opData.preValidate) opData.preValidate = agent.middleware.preValidate;
    //if (!opData.validate) opData.validate = agent.middleware.validate;

    backend.submit(collection, docName, opData, options, function(err, v, ops, snapshot) {
      if (err) return callback(err);
      agent._trigger('after submit', collection, docName, {opData: opData, snapshot: snapshot}, function(err) {
        callback(err, v, ops);
      });
    });
  });
};

/**
 * Execute a query and fetch matching documents.
 *
 * The result is an array of the matching documents. Each document has in
 * addtion the `docName` property set to its name.
 *
 * Triggers the `query` action with the request
 *   { query: query, fetch: true, options: options }
 */
UserAgent.prototype.queryFetch = function(collection, query, options, callback) {
  var agent = this;
  // Should we emit 'query' or 'query fetch' here?
  agent._trigger('query', collection, null, {query:query, fetch:true, options: options}, function(err, backend, action) {
    if (err) return callback(err);

    collection = action.collection;
    query = action.query;

    backend.queryFetch(collection, query, options, function(err, results, extra) {
      if (err) return callback(err);

      if (results) {
        agent.middleware.filterQueryResults(collection, results, function (err, results) {
          if (err) return callback(err);
          callback(null, results, extra);
        });
      } else {
        callback(null, results, extra);
      }
    });
  });
};


/**
 * Get an event emitter for the query
 *
 * The returned emitter fires 'diff' event every time the result of the query
 * changes. In addition the emitter has a `data` property containing the initial
 * result for the query.
 *
 * Triggers the `query` action with the request
 *   { query: query, options: options }
 */
UserAgent.prototype.query = function(collection, query, options, callback) {
  var agent = this;
  agent._trigger('query', collection, null, {query:query, options:options}, function(err, backend, action) {
    if (err) return callback(err);

    collection = action.collection;
    query = action.query;

    //console.log('query', query, options);
    backend.query(collection, query, options, function(err, emitter) {
      if (err) return callback(err);
      agent.middleware.filterQueryResults(collection, emitter.data, function (err, data) {
        if (err) return callback(err);
        // Wrap the query result event emitter
        var wrapped = new EventEmitter();
        wrapped.data = emitter.data;
        wrapped.extra = emitter.extra; // Can't filter this data. BE CAREFUL!

        wrapped.destroy = function() { emitter.destroy(); };

        emitter.on('diff', function(diffs) {
          async.each(diffs, function(diff, next) {
            if (diff.type === 'insert')
              agent.middleware.filterQueryResults(collection, diff.values, next);
            else
              next();
          }, function(error) {
            if (error)
              wrapped.emit('error', error);
            else
              wrapped.emit('diff', diffs);
          });
        });

        emitter.on('extra', function(extra) {
          wrapped.emit('extra', extra);
        });

        callback(null, wrapped);
      });

    });
  });
};

