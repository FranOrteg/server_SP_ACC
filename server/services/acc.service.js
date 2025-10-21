// services/acc.service.js
const fs = require('fs');
const axios = require('axios');
const aps = require('../clients/apsClient');
const { sleep } = require('../clients/apsClient');
const { mk } = require('../helpers/logger');
const log = mk('DM');

// --- HELPERS ID FORMATO 'b.{guid}' ---
function ensureB(id) {
  if (!id) return id;
  return String(id).startsWith('b.') ? id : `b.${id}`;
}

function assertDocIdsOrThrow({ hubIdDM, projectIdDM }) {
  const RE_B = /^b\.[0-9a-f-]{36}$/i;
  if (hubIdDM && !RE_B.test(hubIdDM)) throw new Error(`hubIdDM inválido: ${hubIdDM} (esperado 'b.{accountGuid}')`);
  if (projectIdDM && !RE_B.test(projectIdDM)) throw new Error(`projectIdDM inválido: ${projectIdDM} (esperado 'b.{projectGuid}')`);
}

// --- LISTAR ---
async function listHubs() {
  return await aps.apiGet('/project/v1/hubs');
}

async function listProjects(hubId, { all = false, limit = 50 } = {}) {
  if (!hubId) throw new Error('hubId es obligatorio');
  const base = `/project/v1/hubs/${encodeURIComponent(hubId)}/projects`;
  if (!all) return await aps.apiGet(`${base}?page[limit]=${limit}`);
  let url = `${base}?page[limit]=${limit}`;
  const out = [];
  for (; ;) {
    const page = await aps.apiGet(url);
    if (Array.isArray(page.data)) out.push(...page.data);
    const next = page.links?.next?.href;
    if (!next) return { ...page, data: out };
    url = next.replace('https://developer.api.autodesk.com', '');
  }
}

async function listTopFolders(hubId, projectId) {
  if (!hubId || !projectId) throw new Error('hubId y projectId son obligatorios');
  const u = `/project/v1/hubs/${encodeURIComponent(hubId)}/projects/${encodeURIComponent(projectId)}/topFolders`;
  return await aps.apiGet(u);
}

// --- CONTENIDOS CARPETA ---
async function listFolderContents(projectId, folderId, { all = false, limit = 200 } = {}) {
  const base = `/data/v1/projects/${encodeURIComponent(projectId)}/folders/${encodeURIComponent(folderId)}/contents`;
  if (!all) return await aps.apiGet(`${base}?page[limit]=${limit}`);
  let url = `${base}?page[limit]=${limit}`;
  const included = [];
  const data = [];
  for (; ;) {
    const page = await aps.apiGet(url);
    if (Array.isArray(page.data)) data.push(...page.data);
    if (Array.isArray(page.included)) included.push(...page.included);
    const next = page.links?.next?.href;
    if (!next) return { ...page, data, included };
    url = next.replace('https://developer.api.autodesk.com', '');
  }
}

// --- FOLDERS ---
async function findChildByName(projectId, parentFolderId, name) {
  const page = await listFolderContents(projectId, parentFolderId, { all: true, limit: 200 });
  const child = (page.data || []).find(d => {
    const n = (d.attributes?.displayName || d.attributes?.name || '').trim().toLowerCase();
    return n === name.trim().toLowerCase();
  });
  return child || null;
}

async function ensureFolder(projectId, parentFolderId, name) {
  const existing = await findChildByName(projectId, parentFolderId, name);
  if (existing && existing.type === 'folders') {
    return { id: existing.id, created: false };
  }

  const body = {
    jsonapi: { version: '1.0' },
    data: {
      type: 'folders',
      attributes: {
        name,
        extension: { type: 'folders:autodesk.bim360:Folder', version: '1.0' }
      },
      relationships: {
        parent: { data: { type: 'folders', id: parentFolderId } }
      }
    }
  };

  try {
    const created = await aps.apiPost(`/data/v1/projects/${encodeURIComponent(projectId)}/folders`, body);
    return { id: created.data?.id, created: true };
  } catch (err) {
    const status = err?.response?.status;
    if (status === 409) {
      await aps.sleep(600);
      const again = await findChildByName(projectId, parentFolderId, name);
      if (again && again.type === 'folders') {
        return { id: again.id, created: false };
      }
    }
    throw err;
  }
}

// --- STORAGE + UPLOAD ---
async function createStorage(projectId, folderId, fileName) {
  const body = {
    jsonapi: { version: '1.0' },
    data: {
      type: 'objects',
      attributes: { name: fileName },
      relationships: { target: { data: { type: 'folders', id: folderId } } }
    }
  };
  const res = await aps.apiPost(`/data/v1/projects/${encodeURIComponent(projectId)}/storage`, body);
  return res.data?.id;
}

function parseStorageUrn(storageUrn) {
  const m = /^urn:adsk\.objects:os\.object:([^/]+)\/(.+)$/.exec(storageUrn);
  if (!m) throw new Error(`Storage URN inválido: ${storageUrn}`);
  return { bucketKey: m[1], objectName: m[2] };
}

// --- STORAGE + UPLOAD (Signed S3 Upload para ACC/WIP) ---
async function uploadFileToStorage(storageUrn, localFilePath, opts = {}) {
  const { bucketKey, objectName } = parseStorageUrn(storageUrn);
  const size = fs.statSync(localFilePath).size;

  // Scoped uploads requieren el contexto real del proyecto
  if (!opts.projectId) {
    throw new Error('uploadFileToStorage: falta projectId (requerido para signeds3upload?scoped=true)');
  }
  const { hubId, hubRegion } = await getTopFoldersByProjectId(opts.projectId, { preferHubId: opts.preferHubId });
  const region = (hubRegion || process.env.APS_REGION || 'US').toUpperCase();


  console.log('[UPLOAD] storageUrn:', storageUrn);
  console.log('[UPLOAD] hubId:', hubId, 'region:', region);
  console.log('[UPLOAD] bucket:', bucketKey, 'objectKey:', objectName, 'size:', size);

  const base = `/oss/v2/buckets/${encodeURIComponent(bucketKey)}/objects/${encodeURIComponent(objectName)}/signeds3upload?scoped=true`;

  // INIT
  let init;
  try {
    const initUrl = `${base}&firstPart=1&parts=1`;
    console.log('[UPLOAD] GET', initUrl);
    init = await aps.apiGet(initUrl, { headers: { 'x-ads-region': region, 'x-ads-hub-id': hubId } });
  } catch (e) {
    console.log('[UPLOAD] GET init failed, trying POST-init… reason:', e?.response?.data || e?.message);
    const body = { contentType: 'application/octet-stream', contentLength: size };
    init = await aps.apiPost(base, body, { headers: { 'x-ads-region': region, 'x-ads-hub-id': hubId } });
  }

  console.log('[UPLOAD][init] raw resp keys:', Object.keys(init || {}));
  const uploadKey = init.uploadKey || init.data?.uploadKey || init.result?.uploadKey;
  const urls = init.urls || init.data?.urls || init.result?.urls;
  const uploadUrl = Array.isArray(urls) ? (urls[0]?.url || urls[0]) : (urls?.[0]?.url || urls?.uploadUrl);
  if (!uploadKey || !uploadUrl) throw new Error(`[signeds3upload:init] respuesta inesperada: ${JSON.stringify(init)}`);

  console.log('[UPLOAD][init] uploadKey:', uploadKey);
  console.log('[UPLOAD][init] uploadUrl:', String(uploadUrl).slice(0, 120) + '…');

  const stream = fs.createReadStream(localFilePath);
  const putRes = await axios.put(uploadUrl, stream, {
    headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': size },
    maxBodyLength: Infinity,
    maxContentLength: Infinity,
    timeout: 0
  });
  console.log('[UPLOAD][s3] status:', putRes.status);

  const completeBody = { uploadKey };
  console.log('[UPLOAD] POST', base, 'body:', completeBody);
  const fin = await aps.apiPost(base, completeBody, { headers: { 'x-ads-region': region, 'x-ads-hub-id': hubId } });
  console.log('[UPLOAD][complete] ok. keys:', Object.keys(fin || {}));

  await sleep(300);
  return { ok: true, region, uploadKey };
}

// --- ARCHIVOS ---
async function findItemByName(projectId, folderId, fileName) {
  const page = await listFolderContents(projectId, folderId, { all: true, limit: 200 });
  const item = (page.data || []).find(d =>
    d.type === 'items' &&
    (d.attributes?.displayName || '').toLowerCase() === fileName.toLowerCase()
  );
  return item || null;
}

function normalizeName(name) {
  try { return String(name || '').normalize('NFC'); } catch { return name; }
}

async function createItem(projectId, folderId, fileName, storageUrn) {
  const safe = normalizeName(fileName);
  const body = {
    jsonapi: { version: '1.0' },
    data: {
      type: 'items',
      attributes: {
        displayName: safe,
        extension: { type: 'items:autodesk.bim360:File', version: '1.0' }
      },
      relationships: {
        tip: { data: { type: 'versions', id: '1' } },
        parent: { data: { type: 'folders', id: folderId } }
      }
    },
    included: [{
      type: 'versions',
      id: '1',
      attributes: {
        name: safe,
        extension: { type: 'versions:autodesk.bim360:File', version: '1.0' }
      },
      relationships: {
        storage: { data: { type: 'objects', id: storageUrn } }
      }
    }]
  };

  return await aps.apiPost(
    `/data/v1/projects/${encodeURIComponent(projectId)}/items`,
    body,
    { headers: { 'Content-Type': 'application/vnd.api+json' } }
  );
}

async function createVersion(projectId, itemId, fileName, storageUrn) {
  const safe = normalizeName(fileName);
  const body = {
    jsonapi: { version: '1.0' },
    data: {
      type: 'versions',
      attributes: {
        name: safe,
        extension: { type: 'versions:autodesk.bim360:File', version: '1.0' }
      },
      relationships: {
        item: { data: { type: 'items', id: itemId } },
        storage: { data: { type: 'objects', id: storageUrn } }
      }
    }
  };

  return await aps.apiPost(
    `/data/v1/projects/${encodeURIComponent(projectId)}/versions`,
    body,
    { headers: { 'Content-Type': 'application/vnd.api+json' } }
  );
}

// -------------------- PROVISIONING UTILS --------------------

// Cache de hubs y de mapeo proyecto→hub para acelerar siguientes llamadas
let HUBS_CACHE = null;
const PROJECT_HUB_CACHE = new Map(); // key: projectIdDM('b.{guid}'), val: { hubId, hubRegion }

// Registro de “waiters” para de-dupe por proyecto
const PROV_REGISTRY = new Map(); // key: projectIdDM, val: Promise<boolean>

function _rememberProjectHub(projectIdDM, hubId, hubRegion) {
  if (!projectIdDM || !hubId) return;
  PROJECT_HUB_CACHE.set(projectIdDM, { hubId, hubRegion });
}

// --- REGION + HUB UTILS ---
async function getTopFoldersByProjectId(projectId, opts = {}) {
  const { quiet = false, preferHubId = null } = opts;

  const projectIdDM = ensureB(projectId);
  assertDocIdsOrThrow({ projectIdDM });

  // ¿lo tenemos cacheado?
  const cached = PROJECT_HUB_CACHE.get(projectIdDM);
  if (cached) {
    try {
      const url = `/project/v1/hubs/${encodeURIComponent(cached.hubId)}/projects/${encodeURIComponent(projectIdDM)}/topFolders`;
      const tf = await aps.apiGet(url, { meta: { provisioning: true } });
      return { hubId: cached.hubId, topFolders: tf.data || [], hubRegion: cached.hubRegion || 'US' };
    } catch (e) {
      // si falla el cache, seguimos con el flujo normal
    }
  }

  // 1) obtener hubs (en caché)
  if (!HUBS_CACHE) {
    const hubsResp = await aps.apiGet('/project/v1/hubs', { meta: { provisioning: true } });
    HUBS_CACHE = hubsResp?.data || [];
  }
  const hubs = Array.isArray(HUBS_CACHE) ? [...HUBS_CACHE] : [];

  // 2) si nos pasan un hub preferido, anteponerlo
  if (preferHubId) {
    const prefer = ensureB(preferHubId);
    const idx = hubs.findIndex(h => h.id === prefer);
    if (idx > 0) hubs.unshift(hubs.splice(idx, 1)[0]);
  }

  // 3) probar hub por hub hasta que uno responda
  for (const h of hubs) {
    const hubIdDM = h.id;
    try {
      assertDocIdsOrThrow({ hubIdDM });

      const url = `/project/v1/hubs/${encodeURIComponent(hubIdDM)}/projects/${encodeURIComponent(projectIdDM)}/topFolders`;
      const tf = await aps.apiGet(url, { meta: { provisioning: true } });

      const hubRegion =
        (h?.attributes?.extension?.data?.region ||
          h?.attributes?.region || 'US').toUpperCase();

      // cacheamos el match para acelerar siguientes llamadas
      _rememberProjectHub(projectIdDM, hubIdDM, hubRegion);

      return { hubId: hubIdDM, topFolders: tf.data || [], hubRegion };
    } catch (e) {
      const status = e?.response?.status;
      if (status === 404) continue; // aún no existe en ese hub
      const code = e?.response?.data?.errors?.[0]?.code;
      if (status === 400 && code === 'BIM360DM_ERROR') {
        if (!quiet) await aps.sleep(300);
        continue;
      }
      // otros errores: probar siguiente hub
      continue;
    }
  }

  throw new Error(`No se pudo resolver hub/topFolders para projectId ${projectIdDM}`);
}

// --- Espera a que el proyecto exista en DM (tras activar Docs) ---
// De-duplica por projectIdDM, usa backoff exponencial + jitter y milestones de log.
async function waitUntilDmProjectExists(hubIdDM, projectIdDM, opts = {}) {
  const {
    timeoutMs = 90_000,
    initialDelayMs = 700,
    maxDelayMs = 3_500,
    factor = 1.7,
    jitterMs = 200,
    silentRetries = true,
    onRetry = null,
    preferHubId = null // 👈 nuevo: prioriza este hub en la resolución
  } = opts;

  const pid = ensureB(projectIdDM);
  const prefer = ensureB(preferHubId || hubIdDM);

  assertDocIdsOrThrow({ projectIdDM: pid });

  // de-dup: si ya hay un waiter en marcha, reusar
  if (PROV_REGISTRY.has(pid)) return PROV_REGISTRY.get(pid);

  const waiter = (async () => {
    const t0 = Date.now();
    let attempt = 0;
    let delay = initialDelayMs;

    // Milestone de inicio (una sola línea)
    if (!silentRetries) {
      log.info('iniciando aprovisionamiento DM', { projectId: pid, preferHubId: prefer });
    }

    while (Date.now() - t0 < timeoutMs) {
      attempt++;
      try {
        // Intenta resolver topFolders (es la prueba “fuerte” de que DM ya está listo)
        await getTopFoldersByProjectId(pid, { quiet: true, preferHubId: prefer });
        // listo
        const dur = Date.now() - t0;
        log.info('aprovisionamiento DM completado', { projectId: pid, durationMs: dur });
        return true;
      } catch (_) {
        if (typeof onRetry === 'function') onRetry(attempt, Math.ceil(timeoutMs / Math.max(1, delay)));
        // milestones cada ~2s para no inundar logs
        if (!silentRetries && attempt % 3 === 1) {
          log.debug('aprovisionamiento DM en progreso', { attempt, elapsedMs: Date.now() - t0 });
        }
        const jitter = Math.floor((Math.random() * 2 - 1) * jitterMs); // [-jitterMs, +jitterMs]
        await sleep(Math.max(250, Math.min(maxDelayMs, delay + jitter)));
        delay = Math.min(maxDelayMs, Math.floor(delay * factor));
      }
    }

    throw new Error(`DM provisioning timeout (${pid})`);
  })();

  PROV_REGISTRY.set(pid, waiter);
  try {
    return await waiter;
  } finally {
    // liberar la entrada: si otra llamada llega más tarde, volverá a crear su waiter
    PROV_REGISTRY.delete(pid);
  }
}

// Devuelve el 'Project Files' folderId del proyecto (buscando en topFolders)
async function getProjectFilesFolderId(projectId, opts = {}) {
  const { hubId, topFolders } = await getTopFoldersByProjectId(projectId, opts);
  const pf = (topFolders || []).find(f =>
    (f.attributes?.displayName || f.attributes?.name || '').toLowerCase() === 'project files'
  );
  if (!pf) throw new Error(`No se encontró "Project Files" en projectId ${projectId} (hubId ${hubId})`);
  return pf.id;
}

// Normaliza ruta (acepta "/Archivos de proyecto" o "/Project Files")
function normalizeRoot(seg) {
  const s = (seg || '').trim().toLowerCase();
  return (s === 'archivos de proyecto' || s === 'project files') ? 'Project Files' : seg;
}

// Busca/crea una carpeta por ruta absoluta bajo Project Files.
async function ensureFolderByPath(projectId, path) {
  if (!path?.startsWith('/')) throw new Error('path debe empezar por "/"');

  const parts = path.split('/').filter(Boolean);
  if (!parts.length) throw new Error('path inválido');

  parts[0] = normalizeRoot(parts[0]);
  if (parts[0] !== 'Project Files') {
    throw new Error('La ruta debe empezar por "/Project Files" (o "/Archivos de proyecto")');
  }

  let currentId = await getProjectFilesFolderId(projectId);
  for (let i = 1; i < parts.length; i++) {
    const name = parts[i];

    const page = await listFolderContents(projectId, currentId, { all: true, limit: 200 });
    const child = (page.data || []).find(d =>
      d.type === 'folders' &&
      ((d.attributes?.displayName || d.attributes?.name || '').trim().toLowerCase() === name.trim().toLowerCase())
    );

    if (child) {
      currentId = child.id;
    } else {
      const { id: newId } = await ensureFolder(projectId, currentId, name);
      currentId = newId;
    }
  }
  return currentId;
}

module.exports = {
  ensureB,
  listHubs,
  listProjects,
  listTopFolders,
  listFolderContents,
  findChildByName,
  ensureFolder,
  createStorage,
  uploadFileToStorage,
  findItemByName,
  createItem,
  createVersion,
  parseStorageUrn,
  getProjectFilesFolderId,
  ensureFolderByPath,
  getTopFoldersByProjectId,
  waitUntilDmProjectExists
};
