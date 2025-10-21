// services/transfer.service.js
const sp = require('./sharepoint.service');
const acc = require('./acc.service');
const fs = require('fs');

async function copySharePointItemToAcc({ driveId, itemId, projectId, folderId, fileName }) {
  const tmpPath = await sp.downloadItemToTmp(driveId, itemId);

  const meta = await sp.getItemMeta(driveId, itemId);
  const name = fileName || meta.name || (itemId + '.bin');

  try {
    const storageUrn = await acc.createStorage(projectId, folderId, name);
    await acc.uploadFileToStorage(storageUrn, tmpPath, { projectId });

    const existing = await acc.findItemByName(projectId, folderId, name);

    if (existing) {
      const ver = await acc.createVersion(projectId, existing.id, name, storageUrn);
      return { action: 'version', itemId: existing.id, versionId: ver.data?.id, storage: storageUrn };
    } else {
      const created = await acc.createItem(projectId, folderId, name, storageUrn);
      return {
        action: 'item',
        itemId: created.data?.id,
        versionId: (created.included || []).find(i => i.type === 'versions')?.id,
        storage: storageUrn
      };
    }
  } finally {
    try { fs.unlinkSync(tmpPath); } catch {}
  }
}

async function copySpTreeToAcc({
  driveId,
  itemId,
  projectId,
  targetFolderId,
  mode = 'upsert',
  dryRun = false,
  onLog = () => {}
}) {
  const started = Date.now();
  const summary = { foldersCreated: 0, filesUploaded: 0, versionsCreated: 0, skipped: 0, bytesUploaded: 0 };

  // 1) metadatos y nombre del sitio
  const root = await sp.getItemMeta(driveId, itemId);
  if (!root) throw new Error(`SP item ${itemId} no encontrado`);

  const siteName = await sp.getSiteNameForItem(driveId, itemId); // ← **LBKN01**, por ejemplo
  onLog(`📦 sitio SP: ${siteName}`);

  // 2) carpeta del sitio (hermana de otros sitios) bajo la carpeta objetivo
  const siteFolderId = await ensureAccFolder(projectId, targetFolderId, siteName, dryRun, onLog, summary);

  // 3) decidir VOLCAT (contenido directo o subcarpeta)
  if (root.folder) {
    const treatAsRoot = sp.isDocLibRoot(root) || sp.isDriveRoot(root);
    if (treatAsRoot) {
      // Copiamos CONTENIDO de la biblioteca directamente dentro de <siteName>
      onLog(`➡️  copiando contenido de la biblioteca → "${siteName}"`);
      await walkFolder(driveId, root, projectId, siteFolderId, mode, dryRun, onLog, summary);
    } else {
      // Es una subcarpeta concreta: creamos (o usamos) ese subfolder DENTRO del sitio
      const subId = await ensureAccFolder(projectId, siteFolderId, root.name, dryRun, onLog, summary);
      onLog(`➡️  copiando carpeta "${root.name}" dentro de "${siteName}"`);
      await walkFolder(driveId, root, projectId, subId, mode, dryRun, onLog, summary);
    }
  } else {
    // Un archivo suelto: lo ponemos en la carpeta del sitio
    onLog(`➡️  copiando archivo "${root.name}" dentro de "${siteName}"`);
    await copyOneFile(driveId, root, projectId, siteFolderId, mode, dryRun, onLog, summary);
  }

  return { ok: true, summary, tookMs: Date.now() - started };
}

// BFS recursivo con tolerancia a fallos (reinstala la función que faltaba)
async function walkFolder(driveId, spFolder, projectId, destFolderId, mode, dryRun, onLog, summary) {
  const children = await sp.listChildrenByItem(driveId, spFolder.id);
  for (const child of children) {
    if (child.folder) {
      const subId = await ensureAccFolder(projectId, destFolderId, child.name, dryRun, onLog, summary);
      await walkFolder(driveId, child, projectId, subId, mode, dryRun, onLog, summary);
    } else {
      try {
        await copyOneFile(driveId, child, projectId, destFolderId, mode, dryRun, onLog, summary);
      } catch (e) {
        summary.errors = (summary.errors || 0) + 1;
        summary.failedFiles = summary.failedFiles || [];
        summary.failedFiles.push({ name: child.name, id: child.id, reason: e?.response?.status || e.message });
        onLog(`❌ fallo en ${child.name} (${child.id}) -> ${e?.response?.status || e.message}. Continuo…`);
      }
    }
  }
}


async function ensureAccFolder(projectId, parentFolderId, name, dryRun, onLog, summary) {
  onLog(`📁 ensure folder: ${name} under ${parentFolderId}`);
  if (dryRun) return parentFolderId;

  // comprobación rápida antes de crear
  const exists = await acc.findChildByName(projectId, parentFolderId, name);
  if (exists && exists.type === 'folders') return exists.id;

  const { id, created } = await acc.ensureFolder(projectId, parentFolderId, name);
  if (created) summary.foldersCreated++;
  return id;
}

async function copyOneFile(driveId, spItem, projectId, destFolderId, mode, dryRun, onLog, summary) {
  const fileName = spItem.name;
  const size = spItem.size || 0;

  // ¿ya existe en ACC?
  const existing = await acc.findItemByName(projectId, destFolderId, fileName);
  console.log(`[XFER][file] name=${fileName} size=${size} destFolderId=${destFolderId} exists=${!!existing}`);

  if (existing && mode === 'skip') {
    onLog(`⏭️  skip (existe): ${fileName}`);
    summary.skipped++;
    return;
  }

  if (dryRun) {
    onLog(`🧪 would upload ${fileName} (${size} bytes) → ${destFolderId} (${existing ? 'new version' : 'new item'})`);
    return;
  }

  const tmpPath = await sp.downloadItemToTmp(driveId, spItem.id);
  console.log(`[XFER][tmp] ${tmpPath}`);

  try {
    const storageUrn = await acc.createStorage(projectId, destFolderId, fileName);
    console.log(`[XFER][storage] ${storageUrn} → ${fileName} size: ${size}`);

    // **pasa projectId para resolver región del hub**
    await acc.uploadFileToStorage(storageUrn, tmpPath, { projectId });

    if (!existing) {
      const created = await acc.createItem(projectId, destFolderId, fileName, storageUrn);
      const newVersionId = (created.included || []).find(i => i.type === 'versions')?.id;
      console.log(`[XFER][item-created] itemId=${created.data?.id} versionId=${newVersionId} name=${fileName} inFolder=${destFolderId}`);
      summary.filesUploaded++;
      onLog(`✅ file OK: ${fileName}`);
    } else {
      const ver = await acc.createVersion(projectId, existing.id, fileName, storageUrn);
      console.log(`[XFER][version-created] itemId=${existing.id} versionId=${ver.data?.id} name=${fileName}`);
      summary.versionsCreated++;
      onLog(`✅ version OK: ${fileName}`);
    }

    summary.bytesUploaded += size;
  } finally {
    try { fs.unlinkSync(tmpPath); } catch {}
  }
}


module.exports = { 
  copySharePointItemToAcc, 
  copySpTreeToAcc 
};
