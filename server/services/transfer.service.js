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
    await acc.uploadFileToStorage(storageUrn, tmpPath);

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

  const root = await sp.getItemMeta(driveId, itemId);
  if (!root) throw new Error(`SP item ${itemId} no encontrado`);

  let destFolderId = targetFolderId;
  if (root.folder) {
    const rootName = root.name || 'root';
    destFolderId = await ensureAccFolder(projectId, targetFolderId, rootName, dryRun, onLog, summary);
    await walkFolder(driveId, root, projectId, destFolderId, mode, dryRun, onLog, summary);
  } else {
    await copyOneFile(driveId, root, projectId, targetFolderId, mode, dryRun, onLog, summary);
  }

  return { ok: true, summary, tookMs: Date.now() - started };
}

async function walkFolder(driveId, spFolder, projectId, destFolderId, mode, dryRun, onLog, summary) {
  const children = await sp.listChildrenByItem(driveId, spFolder.id);
  for (const child of children) {
    if (child.folder) {
      const subId = await ensureAccFolder(projectId, destFolderId, child.name, dryRun, onLog, summary);
      await walkFolder(driveId, child, projectId, subId, mode, dryRun, onLog, summary);
    } else {
      await copyOneFile(driveId, child, projectId, destFolderId, mode, dryRun, onLog, summary);
    }
  }
}

async function ensureAccFolder(projectId, parentFolderId, name, dryRun, onLog, summary) {
  onLog(`📁 ensure folder: ${name} under ${parentFolderId}`);
  if (dryRun) return parentFolderId;
  const exists = await acc.findChildByName(projectId, parentFolderId, name);
  if (exists && exists.type === 'folders') return exists.id;
  const id = await acc.ensureFolder(projectId, parentFolderId, name);
  summary.foldersCreated++;
  return id;
}

async function copyOneFile(driveId, spItem, projectId, destFolderId, mode, dryRun, onLog, summary) {
  const fileName = spItem.name;
  const size = spItem.size || 0;
  const existing = await acc.findItemByName(projectId, destFolderId, fileName);

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

  try {
    const storageUrn = await acc.createStorage(projectId, destFolderId, fileName);
    await acc.uploadFileToStorage(storageUrn, tmpPath);

    if (!existing) {
      await acc.createItem(projectId, destFolderId, fileName, storageUrn);
      summary.filesUploaded++;
    } else {
      await acc.createVersion(projectId, existing.id, fileName, storageUrn);
      summary.versionsCreated++;
    }

    summary.bytesUploaded += size;
    onLog(`✅ ${existing ? 'version' : 'file'} OK: ${fileName}`);
  } finally {
    try { fs.unlinkSync(tmpPath); } catch {}
  }
}

module.exports = { 
  copySharePointItemToAcc, 
  copySpTreeToAcc 
};
