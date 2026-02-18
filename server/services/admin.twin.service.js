// services/admin.twin.service.js
const fs = require('fs');
const path = require('path');
const acc = require('./acc.service');
const sp = require('./sharepoint.service');
const { graphGet } = require('../clients/graphClient');
const { apiGet } = require('../clients/apsClient');
const db = require('../config/mysql');

const DATA_DIR = path.join(__dirname, '..', 'data');
const FILE = path.join(DATA_DIR, 'twins.json');

function ensureStore() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(FILE)) fs.writeFileSync(FILE, JSON.stringify({ list: [] }, null, 2));
}
function load() { ensureStore(); return JSON.parse(fs.readFileSync(FILE, 'utf8')); }
function save(store) { fs.writeFileSync(FILE, JSON.stringify(store, null, 2)); }

/* Asegura que el Id lleva el prefijo 'b.' */
function ensureB(id) {
  if (!id) return id;
  return id.startsWith('b.') ? id : `b.${id}`;
}

async function saveLink({ twinId, projectId, siteId, templateId, vars, bim360Url }) {
  const store = load();
  const now = new Date().toISOString();
  const computedUrl = bim360Url || `https://acc.autodesk.com/docs/files/projects/${projectId}`;
  
  const rec = {
    twinId,
    acc: {
      projectId,
      hubId: hubId || accountId || null,
      bim360Url: computedUrl
    },
    sp: { siteId },
    templateId,
    vars,
    createdAt: now,
    updatedAt: now
  };
  
  const i = store.list.findIndex(x => x.twinId === twinId);
  if (i >= 0) store.list[i] = { ...store.list[i], ...rec, updatedAt: now }; else store.list.push(rec);
  save(store);
  return rec;
}

async function getStatus(twinId) {
  const store = load();
  const tw = store.list.find(x => x.twinId === twinId);
  if (!tw) return null;

  // Intentar obtener URLs reales desde MySQL (Skylab DB)
  let bim360UrlFromDB = null;
  let webUrlFromDB = null;

  try {
    // Extraer código del proyecto desde twinId (ej: "PRJ-FRMD01-test" -> "FRMD01")
    const labitCode = twinId.replace(/^PRJ-/, '').replace(/-test.*$/, '').replace(/-.*$/, '');

    if (labitCode && db.query) {
      const rows = await db.query(
        'SELECT bim360Url, sharepointUrl FROM projects WHERE FolderLabitCode = ? LIMIT 1',
        [labitCode]
      );

      if (rows && rows.length > 0) {
        bim360UrlFromDB = rows[0].bim360Url || null;
        webUrlFromDB = rows[0].sharepointUrl || null;
      }
    }
  } catch (e) {
    // Silenciar errores de MySQL, usaremos URLs generadas como fallback
    // No loguear en produccion para evitar span en logs
  }

  // ACC
  let accOk = false, accName = null, accErr = null;
  try {
    // Obtener hubId guardado o usar el default
    const rawHubId = tw.acc.hubId || 'b.1bb899d4-8dd4-42d8-aefd-6c0e35acd825';
    const hubId = ensureB(rawHubId);
    
    // ✅ CORREGIDO: projectId DEBE llevar prefijo 'b.' para la API Data Management
    const projectId = ensureB(tw.acc.projectId);
    
    const { data } = await apiGet(`/project/v1/hubs/${hubId}/projects/${projectId}`);
    accOk = !!data;
    accName = data?.data?.attributes?.name || data?.attributes?.name || null;
  } catch (e) {
    accErr = e?.response?.data?.errors?.[0]?.detail 
          || e?.response?.data?.detail 
          || e?.response?.status 
          || e.message;
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

  // Prioridad de URLs: MySQL DB > Twin storage > Generated
  const finalBim360Url = bim360UrlFromDB
    || tw.acc?.bim360Url
    || `https://acc.autodesk.com/docs/files/projects/${tw.acc.projectId}`;

  const finalWebUrl = webUrlFromDB || webUrl;

  const status = (accOk && spOk) ? 'green' : ((accOk || spOk) ? 'amber' : 'red');
  return {
    twinId,
    status,
    acc: {
      ok: accOk,
      projectId: tw.acc.projectId,
      name: accName,
      bim360Url: finalBim360Url,
      error: accErr || null
    },
    sp: { ok: spOk, siteId: tw.sp.siteId, displayName: spName, webUrl: finalWebUrl, error: spErr || null },
    templateId: tw.templateId || null,
    vars: tw.vars || {}
  };
}

async function listLinks() {
  const store = load();
  return { total: store.list.length, list: store.list };
}

module.exports = { saveLink, getStatus, listLinks };
