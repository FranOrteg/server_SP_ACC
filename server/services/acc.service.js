// services/acc.service.js
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const aps = require('../clients/apsClient');

// --- LISTAR (ya lo tenías) ---
async function listHubs() {
  return await aps.apiGet('/project/v1/hubs');
}

async function listProjects(hubId, { all = false, limit = 50 } = {}) {
  const base = `/project/v1/hubs/${encodeURIComponent(hubId)}/projects`;
  if (!all) return await aps.apiGet(`${base}?page[limit]=${limit}`);
  // paginación
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
  return await aps.apiGet(`/project/v1/hubs/${encodeURIComponent(projectId.split('.')[1])}/projects/${encodeURIComponent(projectId)}/topFolders`);
}

// --- CONTENIDOS DE UNA CARPETA (para búsquedas locales) ---
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

// --- CREA STORAGE PARA UN ARCHIVO EN UNA CARPETA ---
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
  return res.data && res.data.id;
}

// --- PARSEA EL URN DE STORAGE PARA OBTENER BUCKET Y OBJECT ---
function parseStorageUrn(storageUrn) {
  // urn:adsk.objects:os.object:<bucketKey>/<objectName>
  const m = /^urn:adsk\.objects:os\.object:([^/]+)\/(.+)$/.exec(storageUrn);
  if (!m) throw new Error(`Storage URN inválido: ${storageUrn}`);
  return { bucketKey: m[1], objectName: m[2] };
}

// --- SUBE EL BINARIO A OSS (PUT) ---
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
      // 'x-ads-region': 'US' // no es necesario si el bucket es wip.dm.prod; para EMEA sería wip.dm.emea
    },
    maxBodyLength: Infinity,
    maxContentLength: Infinity,
  });

  if (status < 200 || status >= 300) throw new Error(`Fallo subiendo a OSS (${status})`);
  return data; // metadata del objeto
}

// --- BUSCA SI YA EXISTE UN ITEM CON ESE NOMBRE EN LA CARPETA ---
async function findItemByName(projectId, folderId, fileName) {
  // El filtro por nombre no siempre está soportado, así que listamos y filtramos en memoria.
  const page = await listFolderContents(projectId, folderId, { all: true, limit: 200 });
  const item = (page.data || []).find(d =>
    d.type === 'items' &&
    (d.attributes?.displayName || '').toLowerCase() === fileName.toLowerCase()
  );
  return item || null;
}

// --- CREA ITEM (primera versión) ---
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

// --- CREA NUEVA VERSIÓN DE UN ITEM EXISTENTE ---
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
  createStorage,
  uploadFileToStorage,
  findItemByName,
  createItem,
  createVersion,
  parseStorageUrn
};
