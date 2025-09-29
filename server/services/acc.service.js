// services/acc.service.js
const fs = require('fs');
const axios = require('axios');
const aps = require('../clients/apsClient');
const { sleep } = require('../clients/apsClient');

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
  for (;;) {
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
  for (;;) {
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

  let region = (process.env.APS_REGION || 'US').toUpperCase();
  let hubId = null;
  if (opts.projectId) {
    try {
      const { hubId: h, hubRegion } = await getTopFoldersByProjectId(opts.projectId);
      hubId = h;
      region = (hubRegion || region).toUpperCase();
    } catch (_) {}
  }

  console.log('[UPLOAD] storageUrn:', storageUrn);
  console.log('[UPLOAD] hubId:', hubId, 'region:', region);
  console.log('[UPLOAD] bucket:', bucketKey, 'objectKey:', objectName, 'size:', size);

  const base = `/oss/v2/buckets/${encodeURIComponent(bucketKey)}/objects/${encodeURIComponent(objectName)}/signeds3upload?scoped=true`;

  // INIT
  let init;
  try {
    const initUrl = `${base}&firstPart=1&parts=1`;
    console.log('[UPLOAD] GET', initUrl);
    init = await aps.apiGet(initUrl, { headers: { 'x-ads-region': region } });
  } catch (e) {
    console.log('[UPLOAD] GET init failed, trying POST-init… reason:', e?.response?.data || e?.message);
    const body = { contentType: 'application/octet-stream', contentLength: size };
    init = await aps.apiPost(base, body, { headers: { 'x-ads-region': region } });
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
  const fin = await aps.apiPost(base, completeBody, { headers: { 'x-ads-region': region } });
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

// --- util: intenta encontrar el hub que contiene un projectId ---
async function findHubForProject(projectId) {
  const hubsResp = await aps.apiGet('/project/v1/hubs');
  const hubs = (hubsResp?.data || []).map(h => h.id);

  for (const hubId of hubs) {
    try {
      await aps.apiGet(`/project/v1/hubs/${encodeURIComponent(hubId)}/projects/${encodeURIComponent(projectId)}`);
      return hubId;
    } catch (e) {
      const status = e?.response?.status;
      if (status === 404) continue;
      throw e;
    }
  }
  throw new Error(`projectId ${projectId} no encontrado en ninguno de los hubs accesibles`);
}

// --- construir árbol recursivo ---
async function listProjectTree(projectId, { includeItems = false, maxDepth = Infinity } = {}) {
  const { hubId, topFolders } = await getTopFoldersByProjectId(projectId);

  const root = { projectId, hubId, type: 'project', name: `project:${projectId}`, children: [] };

  const queue = [];
  for (const tf of topFolders) {
    const node = {
      id: tf.id,
      type: tf.type,
      name: tf.attributes?.displayName || tf.attributes?.name,
      path: `/${tf.attributes?.displayName || tf.attributes?.name}`,
      children: []
    };
    root.children.push(node);
    queue.push({ node, depth: 1 });
  }

  while (queue.length) {
    const { node, depth } = queue.shift();
    if (depth > maxDepth) continue;

    const page = await listFolderContents(projectId, node.id, { all: true, limit: 200 });
    const entries = page?.data || [];

    for (const entry of entries) {
      const isFolder = entry.type === 'folders';
      const display = entry.attributes?.displayName || entry.attributes?.name;
      const child = { id: entry.id, type: entry.type, name: display, path: `${node.path}/${display}` };

      if (isFolder) {
        child.children = [];
        node.children.push(child);
        queue.push({ node: child, depth: depth + 1 });
      } else {
        if (includeItems) node.children.push(child);
      }
    }
  }

  return root;
}

// Devuelve el 'Project Files' folderId del proyecto (buscando en topFolders)
async function getProjectFilesFolderId(projectId) {
  const { hubId, topFolders } = await getTopFoldersByProjectId(projectId);
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

// --- Espera a que el proyecto exista en DM (tras activar Docs) ---
async function waitUntilDmProjectExists(hubId, projectId, {
  timeoutMs = 180_000,
  initialDelay = 500,
  maxDelay = 6_000,
  factor = 1.8
} = {}) {
  if (!hubId || !projectId) throw new Error('waitUntilDmProjectExists: hubId y projectId son obligatorios');

  const hubIdDM = ensureB(hubId);
  const projectIdDM = ensureB(projectId);
  assertDocIdsOrThrow({ hubIdDM, projectIdDM });

  const started = Date.now();
  let delay = initialDelay;

  while (Date.now() - started < timeoutMs) {
    try {
      const list = await aps.apiGet(`/project/v1/hubs/${encodeURIComponent(hubIdDM)}/projects?page[limit]=50`);
      if (Array.isArray(list?.data) && list.data.some(p => p.id === projectIdDM)) return true;

      await aps.apiGet(`/project/v1/hubs/${encodeURIComponent(hubIdDM)}/projects/${encodeURIComponent(projectIdDM)}/topFolders`);
      return true;
    } catch (e) {
      const st = e?.response?.status;
      const code = e?.response?.data?.errors?.[0]?.code;
      const transient = st === 404 || st === 503 || (st === 400 && code === 'BIM360DM_ERROR');
      if (transient) {
        await aps.sleep(delay);
        delay = Math.min(Math.floor(delay * factor), maxDelay);
        continue;
      }
      throw e;
    }
  }
  throw new Error('Timeout esperando aprovisionamiento de Docs en Data Management');
}

// --- REGION + HUB UTILS ---
async function getTopFoldersByProjectId(projectId) {
  const projectIdDM = ensureB(projectId);
  assertDocIdsOrThrow({ projectIdDM });

  const hubs = await aps.apiGet('/project/v1/hubs');

  for (const h of (hubs.data || [])) {
    const hubIdDM = h.id;
    try {
      assertDocIdsOrThrow({ hubIdDM });

      const u = `/project/v1/hubs/${encodeURIComponent(hubIdDM)}/projects/${encodeURIComponent(projectIdDM)}/topFolders`;
      const tf = await aps.apiGet(u);

      const hubRegion =
        (h?.attributes?.extension?.data?.region ||
         h?.attributes?.region ||
         'US').toUpperCase();

      return { hubId: hubIdDM, topFolders: tf.data || [], hubRegion };
    } catch (e) {
      const status = e?.response?.status;
      const code   = e?.response?.data?.errors?.[0]?.code;
      const detail = (e?.response?.data?.errors?.[0]?.detail || '').toLowerCase();

      if (status === 404) continue;
      if (status === 400 && (code === 'BIM360DM_ERROR' || /got invalid data for project/i.test(detail))) {
        await aps.sleep(1000);
        continue;
      }
      continue;
    }
  }

  throw new Error(`No se pudo resolver hub/topFolders para projectId ${projectIdDM}`);
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
  listProjectTree,
  getProjectFilesFolderId,
  ensureFolderByPath,
  getTopFoldersByProjectId,
  waitUntilDmProjectExists
};
