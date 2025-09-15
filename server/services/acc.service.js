// services/acc.service.js
const fs = require('fs');
const axios = require('axios');
const aps = require('../clients/apsClient');

/* ------------------------------ listar hubs/proyectos ------------------------------ */

async function listHubs() {
  return await aps.apiGet('/project/v1/hubs');
}

async function listProjects(hubId, { all = false, limit = 50 } = {}) {
  const base = `/project/v1/hubs/${encodeURIComponent(hubId)}/projects`;
  if (!all) return await aps.apiGet(`${base}?page[limit]=${limit}`);

  let url = `${base}?page[limit]=${limit}`;
  let out = [];
  let firstPage;
  for (;;) {
    const page = await aps.apiGet(url);
    if (!firstPage) firstPage = page;
    out = out.concat(page.data || []);
    const next = page.links && page.links.next && page.links.next.href;
    if (!next) return { ...firstPage, data: out };
    url = next.replace('https://developer.api.autodesk.com', '');
  }
}

/* ------------------------------ top folders proyecto ------------------------------ */

async function listTopFolders(hubId, projectId) {
  const path = `/project/v1/hubs/${encodeURIComponent(hubId)}/projects/${encodeURIComponent(projectId)}/topFolders`;
  return await aps.apiGet(path);
}

/* ------------------------------ contenidos carpeta ------------------------------ */

async function listFolderContents(projectId, folderId, { all = false, limit = 200 } = {}) {
  const base = `/data/v1/projects/${encodeURIComponent(projectId)}/folders/${encodeURIComponent(folderId)}/contents`;
  if (!all) return await aps.apiGet(`${base}?page[limit]=${limit}`);

  let url = `${base}?page[limit]=${limit}`;
  let included = [];
  let data = [];
  let firstPage;
  for (;;) {
    const page = await aps.apiGet(url);
    if (!firstPage) firstPage = page;
    data = data.concat(page.data || []);
    included = included.concat(page.included || []);
    const next = page.links && page.links.next && page.links.next.href;
    if (!next) return { ...firstPage, data, included };
    url = next.replace('https://developer.api.autodesk.com', '');
  }
}

/* ------------------------------ carpetas: ensure / find ------------------------------ */

async function findChildByName(projectId, parentFolderId, name) {
  const existing = await listFolderContents(projectId, parentFolderId, { all: true, limit: 200 });
  return (existing.data || []).find(e =>
    (e.type === 'folders' || e.type === 'items') &&
    ((e.attributes?.displayName || e.attributes?.name || '').toLowerCase() === name.toLowerCase())
  ) || null;
}

async function ensureFolder(projectId, parentFolderId, name) {
  const found = await findChildByName(projectId, parentFolderId, name);
  if (found && found.type === 'folders') return found.id;

  const payload = {
    jsonapi: { version: '1.0' },
    data: {
      type: 'folders',
      attributes: { name },
      relationships: {
        parent: { data: { type: 'folders', id: parentFolderId } }
      }
    }
  };
  const created = await aps.apiPost(`/data/v1/projects/${encodeURIComponent(projectId)}/folders`, payload);
  return created?.data?.id;
}

/* ------------------------------ almacenamiento/objetos ------------------------------ */

async function createStorage(projectId, folderId, fileName) {
  const body = {
    jsonapi: { version: '1.0' },
    data: {
      type: 'objects',
      attributes: { name: fileName },
      relationships: {
        target: { data: { type: 'folders', id: folderId } }
      }
    }
  };
  const res = await aps.apiPost(`/data/v1/projects/${encodeURIComponent(projectId)}/storage`, body);
  // res.data.id => "urn:adsk.objects:os.object:wip.dm.prod/<guid>/<filename>"
  return res?.data?.id;
}

function parseStorageUrn(storageUrn) {
  const m = /^urn:adsk\.objects:os\.object:([^/]+)\/(.+)$/.exec(storageUrn);
  if (!m) throw new Error(`Storage URN inválido: ${storageUrn}`);
  return { bucketKey: m[1], objectName: m[2] };
}

async function uploadFileToStorage(storageUrn, localFilePath) {
  const { bucketKey, objectName } = parseStorageUrn(storageUrn);
  const accessToken = await aps.getAccessToken(); // requiere patch en apsClient.js (abajo)

  const size = fs.statSync(localFilePath).size;
  const stream = fs.createReadStream(localFilePath);

  const url = `https://developer.api.autodesk.com/oss/v2/buckets/${encodeURIComponent(bucketKey)}/objects/${encodeURIComponent(objectName)}`;
  const { status } = await axios.put(url, stream, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/octet-stream',
      'Content-Length': size
    },
    maxBodyLength: Infinity,
    maxContentLength: Infinity
  });
  if (status < 200 || status >= 300) throw new Error(`Fallo subiendo a OSS (${status})`);
}

/* ------------------------------ items/versions ------------------------------ */

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
  ensureFolder,
  findChildByName,
  createStorage,
  uploadFileToStorage,
  findItemByName,
  createItem,
  createVersion,
  parseStorageUrn
};
