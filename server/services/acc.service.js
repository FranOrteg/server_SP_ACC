// services/acc.service.js
const fs = require('fs');
const axios = require('axios');
const aps = require('../clients/apsClient');

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
  if (existing && existing.type === 'folders') return existing.id;

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
  const created = await aps.apiPost(`/data/v1/projects/${encodeURIComponent(projectId)}/folders`, body);
  return created.data?.id;
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
  return res.data?.id; // urn:adsk.objects:os.object:wip.dm.prod/<guid>/<filename>
}

function parseStorageUrn(storageUrn) {
  const m = /^urn:adsk\.objects:os\.object:([^/]+)\/(.+)$/.exec(storageUrn);
  if (!m) throw new Error(`Storage URN inválido: ${storageUrn}`);
  return { bucketKey: m[1], objectName: m[2] };
}

async function uploadFileToStorage(storageUrn, localFilePath) {
  const { bucketKey, objectName } = parseStorageUrn(storageUrn);
  const accessToken = await aps.getAccessToken();

  const size = fs.statSync(localFilePath).size;
  const stream = fs.createReadStream(localFilePath);

  const url = `https://developer.api.autodesk.com/oss/v2/buckets/${encodeURIComponent(bucketKey)}/objects/${encodeURIComponent(objectName)}`;
  const { data, status } = await axios.put(url, stream, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/octet-stream',
      'Content-Length': size
    },
    maxBodyLength: Infinity,
    maxContentLength: Infinity
  });

  if (status < 200 || status >= 300) throw new Error(`Fallo subiendo a OSS (${status})`);
  return data;
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

async function createItem(projectId, folderId, fileName, storageUrn) {
  const body = {
    jsonapi: { version: '1.0' },
    data: {
      type: 'items',
      attributes: {
        displayName: fileName,
        extension: { type: 'items:autodesk.bim360:File', version: '1.0' }
      },
      relationships: {
        tip: { data: { type: 'versions', id: '1' } },
        parent: { data: { type: 'folders', id: folderId } }
      }
    },
    included: [
      {
        type: 'versions',
        id: '1',
        attributes: {
          name: fileName,
          extension: { type: 'versions:autodesk.bim360:File', version: '1.0' }
        },
        relationships: {
          storage: { data: { type: 'objects', id: storageUrn } }
        }
      }
    ]
  };
  return await aps.apiPost(`/data/v1/projects/${encodeURIComponent(projectId)}/items`, body);
}

async function createVersion(projectId, itemId, fileName, storageUrn) {
  const body = {
    jsonapi: { version: '1.0' },
    data: {
      type: 'versions',
      attributes: {
        name: fileName,
        extension: { type: 'versions:autodesk.bim360:File', version: '1.0' }
      },
      relationships: {
        item: { data: { type: 'items', id: itemId } },
        storage: { data: { type: 'objects', id: storageUrn } }
      }
    }
  };
  return await aps.apiPost(`/data/v1/projects/${encodeURIComponent(projectId)}/versions`, body);
}

module.exports = {
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
  parseStorageUrn
};
