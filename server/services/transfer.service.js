// services/transfer.service.js

const sp = require('./sharepoint.service');
const acc = require('./acc.service');
const fs = require('fs');
const path = require('path');

// Devuelve un nombre disponible si existe colisión (filename, filename (1).ext, filename (2).ext, …)
async function nextAvailableName(projectId, folderId, fileName) {
  const ext = path.extname(fileName);
  const base = path.basename(fileName, ext);
  let n = 0;
  let candidate = fileName;

  // Buscar por nombre exacto
  let exists = await acc.findItemByName(projectId, folderId, candidate);
  while (exists) {
    n += 1;
    candidate = ext
      ? `${base} (${n})${ext}`
      : `${base} (${n})`;
    exists = await acc.findItemByName(projectId, folderId, candidate);
  }
  return candidate;
}

async function copySharePointItemToAcc({ driveId, itemId, projectId, folderId, fileName, onConflict = 'version' }) {
  const tmpPath = await sp.downloadItemToTmp(driveId, itemId);
  const meta = await sp.getItemMeta(driveId, itemId);
  let name = fileName || meta.name || (itemId + '.bin');

  try {
    // conflicto (si existe mismo nombre en carpeta destino)
    const existing = await acc.findItemByName(projectId, folderId, name);
    if (existing) {
      if (onConflict === 'skip') {
        return { action: 'skipped', reason: 'exists', itemId: existing.id, name };
      }
      if (onConflict === 'rename') {
        name = await nextAvailableName(projectId, folderId, name);
      }
      // onConflict === 'version' → seguimos con el mismo nombre
    }

    const storageUrn = await acc.createStorage(projectId, folderId, name);
    await acc.uploadFileToStorage(storageUrn, tmpPath, { projectId });

    if (!existing || onConflict === 'rename') {
      const created = await acc.createItem(projectId, folderId, name, storageUrn);
      return {
        action: 'item',
        itemId: created.data?.id,
        versionId: (created.included || []).find(i => i.type === 'versions')?.id,
        storage: storageUrn,
        name
      };
    } else {
      const ver = await acc.createVersion(projectId, existing.id, name, storageUrn);
      return { action: 'version', itemId: existing.id, versionId: ver.data?.id, storage: storageUrn, name };
    }
  } finally {
    try { fs.unlinkSync(tmpPath); } catch {}
  }
}

/**
 * Pre-escanea el árbol de SharePoint para contar archivos y bytes totales
 * @param {string} driveId - ID del drive de SharePoint
 * @param {Object} folder - Objeto de carpeta raíz
 * @returns {Object} { totalFiles, totalBytes, items[] }
 */
async function prescanSpTree(driveId, folder) {
  const items = [];
  let totalFiles = 0;
  let totalBytes = 0;

  async function scan(parent) {
    const children = await sp.listChildrenByItem(driveId, parent.id);
    for (const child of children) {
      if (child.folder) {
        await scan(child);
      } else {
        totalFiles++;
        totalBytes += child.size || 0;
        items.push({ id: child.id, name: child.name, size: child.size || 0 });
      }
    }
  }

  if (folder.folder) {
    await scan(folder);
  } else {
    totalFiles = 1;
    totalBytes = folder.size || 0;
    items.push({ id: folder.id, name: folder.name, size: folder.size || 0 });
  }

  return { totalFiles, totalBytes, items };
}

async function copySpTreeToAcc({
  driveId,
  itemId,
  projectId,
  targetFolderId,
  mode = 'upsert',  // upsert | skip | rename
  dryRun = false,
  onLog = () => {},
  onProgress = null  // NUEVO: callback de progreso { totalFiles, processedFiles, currentFile, bytesTotal, bytesTransferred }
}) {
  const started = Date.now();
  const summary = { foldersCreated: 0, filesUploaded: 0, versionsCreated: 0, skipped: 0, bytesUploaded: 0 };

  // Contexto de progreso compartido
  const progressCtx = {
    totalFiles: 0,
    totalBytes: 0,
    processedFiles: 0,
    bytesTransferred: 0,
    currentFile: '',
    checkCancellation: onProgress?.checkCancellation || (() => {})
  };

  const root = await sp.getItemMeta(driveId, itemId);
  if (!root) throw new Error(`SP item ${itemId} no encontrado`);

  const siteName = await sp.getSiteNameForItem(driveId, itemId);
  onLog(`📦 sitio SP: ${siteName}`);

  // Pre-escanear para obtener totales (si hay callback de progreso)
  if (onProgress) {
    onLog(`🔍 Pre-escaneando estructura...`);
    const scan = await prescanSpTree(driveId, root);
    progressCtx.totalFiles = scan.totalFiles;
    progressCtx.totalBytes = scan.totalBytes;
    onLog(`📊 Encontrados ${scan.totalFiles} archivos (${formatBytes(scan.totalBytes)})`);
  }

  const siteFolderId = await ensureAccFolder(projectId, targetFolderId, siteName, dryRun, onLog, summary);

  if (root.folder) {
    const treatAsRoot = sp.isDocLibRoot(root) || sp.isDriveRoot(root);
    if (treatAsRoot) {
      onLog(`➡️  copiando contenido de la biblioteca → "${siteName}"`);
      await walkFolder(driveId, root, projectId, siteFolderId, mode, dryRun, onLog, summary, progressCtx, onProgress);
    } else {
      const subId = await ensureAccFolder(projectId, siteFolderId, root.name, dryRun, onLog, summary);
      onLog(`➡️  copiando carpeta "${root.name}" dentro de "${siteName}"`);
      await walkFolder(driveId, root, projectId, subId, mode, dryRun, onLog, summary, progressCtx, onProgress);
    }
  } else {
    onLog(`➡️  copiando archivo "${root.name}" dentro de "${siteName}"`);
    await copyOneFile(driveId, root, projectId, siteFolderId, mode, dryRun, onLog, summary, progressCtx, onProgress);
  }

  // Reportar progreso final
  if (onProgress) {
    onProgress({
      ...progressCtx,
      processedFiles: progressCtx.totalFiles,
      stepProgress: 100
    });
  }

  return { ok: true, summary, tookMs: Date.now() - started };
}

// Helper para formatear bytes
function formatBytes(bytes) {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

async function walkFolder(driveId, spFolder, projectId, destFolderId, mode, dryRun, onLog, summary, progressCtx = null, onProgress = null) {
  const children = await sp.listChildrenByItem(driveId, spFolder.id);
  for (const child of children) {
    // Verificar cancelación
    if (progressCtx?.checkCancellation) {
      progressCtx.checkCancellation();
    }

    if (child.folder) {
      const subId = await ensureAccFolder(projectId, destFolderId, child.name, dryRun, onLog, summary);
      await walkFolder(driveId, child, projectId, subId, mode, dryRun, onLog, summary, progressCtx, onProgress);
    } else {
      try {
        await copyOneFile(driveId, child, projectId, destFolderId, mode, dryRun, onLog, summary, progressCtx, onProgress);
      } catch (e) {
        if (e.message === 'CANCELLED') throw e;
        summary.errors = (summary.errors || 0) + 1;
        summary.failedFiles = summary.failedFiles || [];
        summary.failedFiles.push({ name: child.name, id: child.id, reason: e?.response?.status || e.message });
        onLog(`❌ fallo en ${child.name} (${child.id}) -> ${e?.response?.status || e.message}. Continuo…`);
        // Incrementar progreso aunque falle
        if (progressCtx) {
          progressCtx.processedFiles++;
          progressCtx.bytesTransferred += child.size || 0;
        }
      }
    }
  }
}

async function ensureAccFolder(projectId, parentFolderId, name, dryRun, onLog, summary) {
  onLog(`📁 ensure folder: ${name} under ${parentFolderId}`);
  if (dryRun) return parentFolderId;

  const exists = await acc.findChildByName(projectId, parentFolderId, name);
  if (exists && exists.type === 'folders') return exists.id;

  const { id, created } = await acc.ensureFolder(projectId, parentFolderId, name);
  if (created) summary.foldersCreated++;
  return id;
}

async function copyOneFile(driveId, spItem, projectId, destFolderId, mode, dryRun, onLog, summary, progressCtx = null, onProgress = null) {
  let fileName = spItem.name;
  const size = spItem.size || 0;

  // Actualizar progreso: archivo actual
  if (progressCtx) {
    progressCtx.currentFile = fileName;
    if (onProgress) {
      const stepProgress = progressCtx.totalFiles > 0 
        ? Math.round((progressCtx.processedFiles / progressCtx.totalFiles) * 100) 
        : 0;
      onProgress({
        totalFiles: progressCtx.totalFiles,
        processedFiles: progressCtx.processedFiles,
        currentFile: fileName,
        bytesTotal: progressCtx.totalBytes,
        bytesTransferred: progressCtx.bytesTransferred,
        stepProgress
      });
    }
  }

  const existing = await acc.findItemByName(projectId, destFolderId, fileName);
  console.log(`[XFER][file] name=${fileName} size=${size} destFolderId=${destFolderId} exists=${!!existing}`);

  if (existing) {
    if (mode === 'skip') {
      onLog(`⏭️  skip (existe): ${fileName}`);
      summary.skipped++;
      return;
    }
    if (mode === 'rename') {
      fileName = await nextAvailableName(projectId, destFolderId, fileName);
    }
  }

  if (dryRun) {
    const act = existing && mode !== 'rename' ? 'new version' : (existing ? 'renamed item' : 'new item');
    onLog(`🧪 would upload ${fileName} (${size} bytes) → ${destFolderId} (${act})`);
    return;
  }

  const tmpPath = await sp.downloadItemToTmp(driveId, spItem.id);
  console.log(`[XFER][tmp] ${tmpPath}`);

  try {
    const storageUrn = await acc.createStorage(projectId, destFolderId, fileName);
    console.log(`[XFER][storage] ${storageUrn} → ${fileName} size: ${size}`);
    await acc.uploadFileToStorage(storageUrn, tmpPath, { projectId });

    if (!existing || mode === 'rename') {
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

    // Actualizar progreso después de completar archivo
    if (progressCtx) {
      progressCtx.processedFiles++;
      progressCtx.bytesTransferred += size;
    }
  } finally {
    try { fs.unlinkSync(tmpPath); } catch {}
  }
}

module.exports = { copySharePointItemToAcc, copySpTreeToAcc, prescanSpTree };
