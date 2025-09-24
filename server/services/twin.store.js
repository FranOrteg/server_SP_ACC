// services/twin.store.js

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const FILE = path.join(DATA_DIR, 'twins.json');

function _ensure() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(FILE)) fs.writeFileSync(FILE, JSON.stringify({ list: [] }, null, 2));
}

function _load() {
  _ensure();
  return JSON.parse(fs.readFileSync(FILE, 'utf8'));
}
function _save(db) {
  fs.writeFileSync(FILE, JSON.stringify(db, null, 2));
}

// upsert twin by twinId
function put(twin) {
  const db = _load();
  const i = db.list.findIndex(x => x.twinId === twin.twinId);
  if (i >= 0) db.list[i] = { ...db.list[i], ...twin };
  else db.list.push(twin);
  _save(db);
  return twin;
}

function get(twinId) {
  const db = _load();
  return db.list.find(x => x.twinId === twinId) || null;
}

function all() {
  const db = _load();
  return db.list.slice();
}

module.exports = { put, get, all };
