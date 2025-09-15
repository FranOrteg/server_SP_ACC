// services/acc.service.js
const aps = require('../clients/apsClient');
const axios = require('axios');
const fs = require('fs');
const mime = require('mime-types');
const { ensureAccessToken } = require('../clients/apsClient');

// const token = await ensureAccessToken();

// Hubs del usuario (ACC/BIM 360)
async function listHubs() {
  return await aps.apiGet('/project/v1/hubs');
}

// Proyectos dentro de un hub
async function listProjects(hubId) {
  return await aps.apiGet(`/project/v1/hubs/${hubId}/projects`);
}

// Carpetas raíz de un proyecto
async function listTopFolders(projectId) {
  return await aps.apiGet(`/data/v1/projects/${encodeURIComponent(projectId)}/topFolders`);
}

// Parsear URN de almacenamiento OSS
function parseStorageUrn(urn) {
  // urn:adsk.objects:os.object:<bucketKey>/<objectName>
  const prefix = 'urn:adsk.objects:os.object:';
  if (!urn.startsWith(prefix)) throw new Error(`Storage URN inválido: ${urn}`);
  const path = urn.slice(prefix.length); // "<bucket>/<objectName...>"
  const slash = path.indexOf('/');
  const bucketKey = path.slice(0, slash);
  const objectName = path.slice(slash + 1); // puede incluir /
  return { bucketKey, objectName };
}

async function createStorage(projectId, folderId, fileName) {
  const body = {
    data: {
      type: 'objects',
      attributes: { name: fileName },
      relationships: {
        target: { data: { type: 'folders', id: folderId } }
      }
    }
  };
  return await aps.apiPost(`/data/v1/projects/${encodeURIComponent(projectId)}/storage`, body);
}

async function uploadFileToStorage(storageUrn, filePath) {
  const { bucketKey, objectName } = parseStorageUrn(storageUrn);
  const stat = fs.statSync(filePath);
  const stream = fs.createReadStream(filePath);
  const contentType = mime.lookup(filePath) || 'application/octet-stream';

  // ¡ojo! codificar cada segmento del objectName
  const encodedObject = objectName.split('/').map(encodeURIComponent).join('/');

  const { access_token } = await require('../clients/apsClient').exchangeCodeForTokens
    ? await require('../clients/apsClient').refreshIfNeeded?.() ?? {}
    : {};

  // Si no tienes acceso al token aquí, usa aps.apiPost con axios config;
  // más simple: llamamos axios con el token obtenido por aps.refreshIfNeeded():
  const tokens = await (async () => {
    // usa una llamada barata para forzar refresh y obtener token actual
    try { await aps.apiGet('/userprofile/v1/users/@me'); } catch(_) {}
    return require('../clients/apsClient').TOKENS || {};
  })();

  const token = tokens.access_token;
  if (!token) throw new Error('No hay token de APS activo para subir a OSS');

  const url = `https://developer.api.autodesk.com/oss/v2/buckets/${bucketKey}/objects/${encodedObject}`;
  const { data } = await axios.put(url, stream, {
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': contentType,
      'Content-Length': stat.size
    },
    maxBodyLength: Infinity,
    maxContentLength: Infinity,
  });
  return data; // info del objeto OSS
}

async function findItemByName(projectId, folderId, fileName) {
  // listado de contenidos de la carpeta (puede paginar; para MVP basta primera página)
  const data = await aps.apiGet(`/data/v1/projects/${encodeURIComponent(projectId)}/folders/${folderId}/contents`);
  const items = Array.isArray(data?.data) ? data.data : [];
  return items.find(x => x?.attributes?.displayName === fileName);
}

async function createItem(projectId, folderId, storageUrn, fileName) {
  const body = {
    data: {
      type: 'items',
      attributes: { displayName: fileName, extension: { type: 'items:autodesk.core:File', version: '1.0' } },
      relationships: {
        tip: { data: { type: 'versions', id: '1' } }, // placeholder
        parent: { data: { type: 'folders', id: folderId } }
      }
    },
    included: [{
      type: 'versions',
      id: '1',
      attributes: { name: fileName, extension: { type: 'versions:autodesk.core:File', version: '1.0' } },
      relationships: {
        storage: { data: { type: 'objects', id: storageUrn } }
      }
    }]
  };
  return await aps.apiPost(`/data/v1/projects/${encodeURIComponent(projectId)}/items`, body);
}

async function createVersion(projectId, itemId, storageUrn, fileName) {
  const body = {
    data: {
      type: 'versions',
      attributes: { name: fileName, extension: { type: 'versions:autodesk.core:File', version: '1.0' } },
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
  // nuevos helpers:
  createStorage,
  uploadFileToStorage,
  findItemByName,
  createItem,
  createVersion,
  parseStorageUrn,
};
