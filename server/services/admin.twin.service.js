// services/admin.twin.service.js
const fs = require('fs');
const path = require('path');
const acc = require('./acc.service');
const sp = require('./sharepoint.service');
const { graphGet } = require('../clients/graphClient');

const DATA_DIR = path.join(__dirname, '..', 'data');
const FILE = path.join(DATA_DIR, 'twins.json');

function ensureStore() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(FILE)) fs.writeFileSync(FILE, JSON.stringify({ list: [] }, null, 2));
}
function load() { ensureStore(); return JSON.parse(fs.readFileSync(FILE, 'utf8')); }
function save(db) { fs.writeFileSync(FILE, JSON.stringify(db, null, 2)); }

async function saveLink({ twinId, projectId, siteId, templateId, vars }) {
  const db = load();
  const now = new Date().toISOString();
  const rec = { twinId, acc: { projectId }, sp: { siteId }, templateId, vars, createdAt: now, updatedAt: now };
  const i = db.list.findIndex(x => x.twinId === twinId);
  if (i >= 0) db.list[i] = { ...db.list[i], ...rec, updatedAt: now }; else db.list.push(rec);
  save(db);
  return rec;
}

async function getStatus(twinId) {
  const db = load();
  const tw = db.list.find(x => x.twinId === twinId);
  if (!tw) return null;

  // ACC
  let accOk = false, accName = null, accErr = null;
  try {
    const info = await acc.getProjectInfo(tw.acc.projectId);
    accOk = !!info;
    accName = info?.data?.attributes?.name || null;
  } catch (e) {
    accErr = e?.response?.status || e.message;
  }

  // SP
  let spOk = false, spName = null, spErr = null, webUrl = null;
  try {
    // p.ej. "labitgroup.sharepoint.com,80f7...f31,b37c..."
    const sid = encodeURIComponent(tw.sp.siteId);
    const { data } = await graphGet(`/sites/${sid}?$select=webUrl,displayName`);
    spOk = !!tw.sp.siteId;
    spName = data?.displayName || null;
    webUrl = data?.webUrl || null;
  } catch (e) {
    spErr = e?.response?.status || e.message;
  }

  const status = (accOk && spOk) ? 'green' : ((accOk || spOk) ? 'amber' : 'red');
  return {
    twinId,
    status,
    acc: { ok: accOk, projectId: tw.acc.projectId, name: accName, error: accErr || null },
    sp:  { ok: spOk, siteId: tw.sp.siteId, displayName: spName, webUrl, error: spErr || null },
    templateId: tw.templateId || null,
    vars: tw.vars || {}
  };
}

async function listLinks() {
  const db = load();
  return { total: db.list.length, list: db.list };
}

module.exports = { saveLink, getStatus, listLinks };
