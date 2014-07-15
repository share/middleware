# Livedb Middleware

> Note: This module is a work in progress. Its not ready for use yet.

This module wraps the livedb API with a set of functions which have an
identical API. The wrapped functions inject calls to your code before calling
livedb.

You can use this to implement all sorts of features on top of livedb, for example:

- Custom access control
- Annotate operations in the database with user information
- Add polling guards to operations, etc
- By default racer lets clients send arbitrary queries. Using this library, you
can make clients only send a query name + parameters, then on the server
replace queries with their expanded form for the database.

## Middlewares

There are three different places you can register middleware:

- Regular livedb operations, which are:
  - **submit operation**: Called when any user make a change to any document
  - **fetch / bulk fetch**: Called when a user requests a set of named documents
  - **get ops**: Called when a client explicitly fetches operations
  - **subscribe / bulk subscribe**: Called when a client subscribes to a set of documents
  - **query**: Called when the client sends a query to the backend
- A client's view of all document snapshots
- A client's view of all operations from other peers

Middleware can make arbitrary changes to the request before the request is sent to the backend


## User agents

Its extremely common to want to associate data to a user session, and have that
data stick around for subsequent user requests. Middleware provides a useragent
object for each persistent stream which you can attach arbitrary data to.



