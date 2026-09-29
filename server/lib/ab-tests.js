const db = require('../database');
const { createStore } = require('./ab-store');
const store = createStore(db);
store.syncAll();
store.history = require('./ab-history').createHistory(db);
store.history.importOnce();
module.exports = store;
