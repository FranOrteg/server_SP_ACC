// services/acc.service.js
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const mime = require('mime-types');
const aps = require('../clients/apsClient');

/* ----------------------------- LISTADOS BÁSICOS ----------------------------- */

async function listHubs() {
  return await aps.apiGet('/project/v1/hubs');
}

async function listProjects(hubId, { all = false, limit = 50 } = {}) {
  const base = `/project/v1/hubs/${encodeURIComponent(hubId)}/projects`;
  if (!all) return await aps.apiGet(`${base}?page[limit]=${limit}`);

  let url = `${base}?page[limit]=${limit}`;
  let out = [];
  for (;;) {
    const page = await aps.apiGet(url);
    out = out.concat(page.data || []);
    const next = page.links && page.links.next && page.links.next.href;
    if (!next) return { ...page, data: out };
    url = next.replace('https://developer.api.autodesk.com', '');
  }
}

async function listTopFolders(projectId) {
  return await aps.apiGet(`/data/v1/projects/${encodeURIComponent(projectId)}/topFolders`);
}

async function listFolderContents(projectId, folderId, { all = false, limit = 200 } = {}) {
  const base = `/data/v1/projects/${encodeURIComponent(projectId)}/folders/${encodeURIComponent(folderId)}/contents`;
  if (!all) return await aps.apiGet(`${base}?page[limit]=${limit}`);

  let url = `${base}?page[limit]=${limit}`;
  let included = [];
  let data = [];
  for (;;) {
    const page = await aps.apiGet(url);
    data = data.concat(page.data || []);
    included = included.concat(page.included || []);
    const next = page.links && page.links.next && page.links.next.href;
    if (!next) return { ...page, data, included };
    url = next.replace('https://developer.api.autodesk.com', '');
  }
}

/* ----------------------- FOLDERS (ENCONTRAR / CREAR) ----------------------- */

async function findChildByName(projectId, parentFolderId, name) {
  const page = await listFolderContents(projectId, parentFolderId, { all: true, limit: 200 });
  const node = (page.data || []).find(d =>
    (d.type === 'folders' || d.type === 'items') &&
    (d.attributes?.displayName || '').toLowerCase() === String(name).toLowerCase()
  );
  return node || null;
}

async function ensureFolder(projectId, parentFolderId, name) {
  const existing = await findChildByName(projectId, parentFolderId, name);
  if (existing && existing.type === 'folders') return existing.id;

  const body = {
    jsonapi: { version: '1.0' },
    data: {
      type: 'folders',
      attributes: { name },
      relationships: {
        parent: { data: { type: 'folders', id: parentFolderId } }
      }
    }
  };
  const created = await aps.apiPost(`/data/v1/projects/${encodeURIComponent(projectId)}/folders`, body);
  return created?.data?.id;
}

/* ------------------------- STORAGE & SUBIDA A OSS -------------------------- */

function parseStorageUrn(urn) {
  const m = /^urn:adsk\.objects:os\.object:([^/]+)\/(.+)$/.exec(urn || '');
  if (!m) throw new Error(`Storage URN inválido: ${urn}`);
  return { bucketKey: m[1], objectName: m[2] };
}

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
  return res?.data?.id; // "urn:adsk.objects:os.object:wip.dm.prod/<guid>/<filename>"
}

async function uploadFileToStorage(storageUrn, localFilePath) {
  const { bucketKey, objectName } = parseStorageUrn(storageUrn);
  const token = await aps.ensureAccessToken();
  if (!token) throw new Error('No hay token de APS activo para subir a OSS');

  const stat = fs.statSync(localFilePath);
  const stream = fs.createReadStream(localFilePath);
  const contentType = mime.lookup(localFilePath) || 'application/octet-stream';

  const encodedObject = objectName.split('/').map(encodeURIComponent).join('/');
  const url = `https://developer.api.autodesk.com/oss/v2/buckets/${encodeURIComponent(bucketKey)}/objects/${encodedObject}`;

  const { status, data } = await axios.put(url, stream, {
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': contentType,
      'Content-Length': stat.size
    },
    maxBodyLength: Infinity,
    maxContentLength: Infinity,
  });
  if (status < 200 || status >= 300) throw new Error(`Fallo subiendo a OSS (${status})`);
  return data;
}

/* --------------------------- ITEMS / VERSIONES ---------------------------- */

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
        relationships: { storage: { data: { type: 'objects', id: storageUrn } } }
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
