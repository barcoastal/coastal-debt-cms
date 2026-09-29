const db = require('../database');
const { createStore } = require('./ab-store');
const store = createStore(db);
store.syncAll();
module.exports = store;
