const fs = require('fs');
const { downloadItemToTmp } = require('./sharepoint.service');
// TODO: implementar upload a ACC (crear storage + subir objeto con ObjectsApi)

async function copySpItemToAcc({ sp: { driveId, itemId }, accCtx }) {
  // 1) Descargar de SharePoint a /tmp
  const tmpPath = await downloadItemToTmp(driveId, itemId);

  try {
    // 2) Crear storage en ACC (projectId, folderId, filename) y subir el fichero (chunks si es grande)
    //    Pseudocódigo:
    // const storageId = await createStorage(credentials, projectId, folderUrn, fileName);
    // await uploadObject(credentials, bucketKeyFromStorage, objectName, fs.createReadStream(tmpPath));
    return { ok: true, tmpPath };
  } finally {
    // Limpieza opcional: fs.unlinkSync(tmpPath);
  }
}

module.exports = { copySpItemToAcc };
