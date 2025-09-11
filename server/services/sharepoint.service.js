const { graphGet, graphGetStream, graphPost } = require('../clients/graphClient');
const { pipeline } = require('node:stream/promises');
const fs = require('fs');
const path = require('path');

// Lista drives (bibliotecas) de un sitio
async function listSiteDrives(siteId) {
  const { data } = await graphGet(`/sites/${siteId}/drives`);
  return data.value || [];
}

// Lista items de una carpeta por path
async function listFolderByPath(driveId, folderPath = '') {
  const safe = folderPath ? `:/` + encodeURI(folderPath) + `:/children` : `/root/children`;
  const { data } = await graphGet(`/drives/${driveId}${safe}`);
  return data.value || [];
}

// Descarga archivo a /tmp
async function downloadItemToTmp(driveId, itemId) {
  const res = await graphGetStream(`/drives/${driveId}/items/${itemId}/content`);
  const tmpFile = path.join('/tmp', `${itemId}-${Date.now()}`);
  await pipeline(res.data, fs.createWriteStream(tmpFile));
  return tmpFile;
}

// Crear upload session (para >4MB) y subir en chunks
async function createUploadSession(driveId, parentItemIdOrRoot, fileName) {
  const url = parentItemIdOrRoot === 'root'
    ? `/drives/${driveId}/root:/${encodeURIComponent(fileName)}:/createUploadSession`
    : `/drives/${driveId}/items/${parentItemIdOrRoot}:/${encodeURIComponent(fileName)}:/createUploadSession`;
  const { data } = await graphPost(url, { item: { '@microsoft.graph.conflictBehavior': 'replace' } });
  return data.uploadUrl;
}

module.exports = {
  listSiteDrives,
  listFolderByPath,
  downloadItemToTmp,
  createUploadSession
};
