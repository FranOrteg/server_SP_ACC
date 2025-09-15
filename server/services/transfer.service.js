// services/transfer.service.js
const sp = require('./sharepoint.service');
const acc = require('./acc.service');
const fs = require('fs');

async function copySharePointItemToAcc({ driveId, itemId, projectId, folderId, fileName }) {
  // 1) Descarga a /tmp
  const tmpPath = await sp.downloadItemToTmp(driveId, itemId);

  // 2) Si no me pasan nombre, lo inferimos del webUrl o del propio itemId
  const name = fileName || (itemId + '.bin');

  try {
    // 3) Storage + OSS
    const storageUrn = await acc.createStorage(projectId, folderId, name);
    await acc.uploadFileToStorage(storageUrn, tmpPath);

    // 4) ¿Existe ya el item?
    const existing = await acc.findItemByName(projectId, folderId, name);

    if (existing) {
      // 4b) Nueva versión
      const ver = await acc.createVersion(projectId, existing.id, name, storageUrn);
      return {
        action: 'version',
        itemId: existing.id,
        versionId: ver.data?.id,
        storage: storageUrn
      };
    } else {
      // 4a) Crear item (v1)
      const created = await acc.createItem(projectId, folderId, name, storageUrn);
      return {
        action: 'item',
        itemId: created.data?.id,
        versionId: (created.included || []).find(i => i.type === 'versions')?.id,
        storage: storageUrn
      };
    }
  } finally {
    // 5) Limpieza
    try { fs.unlinkSync(tmpPath); } catch {}
  }
}

module.exports = { copySharePointItemToAcc };
