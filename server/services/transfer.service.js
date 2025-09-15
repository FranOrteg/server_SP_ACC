const sp = require('./sharepoint.service');
const acc = require('./acc.service');

async function copySpItemToAcc({ driveId, itemId, projectId, folderId }) {
  // 1) SP: metadatos y descarga temporal
  const meta = await sp.getItemMeta(driveId, itemId); // { name, size, ... }
  const tmpFile = await sp.downloadItemToTmp(driveId, itemId);

  // 2) ACC: crear storage y subir objeto a OSS
  const storage = await acc.createStorage(projectId, folderId, meta.name);
  const storageUrn = storage?.data?.id;
  if (!storageUrn) throw new Error('No se pudo crear storage en ACC');

  await acc.uploadFileToStorage(storageUrn, tmpFile);

  // 3) ACC: crear item o nueva versión
  const existing = await acc.findItemByName(projectId, folderId, meta.name);
  if (!existing) {
    const created = await acc.createItem(projectId, folderId, storageUrn, meta.name);
    return { action: 'created:item', item: created?.data, meta };
  } else {
    const version = await acc.createVersion(projectId, existing.id, storageUrn, meta.name);
    return { action: 'created:version', version: version?.data, meta };
  }
}

module.exports = { copySpItemToAcc };
