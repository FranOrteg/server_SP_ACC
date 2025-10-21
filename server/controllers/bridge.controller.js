// controllers/bridge.controller.js

const transfer = require('../services/transfer.service');
const sp = require('../services/sharepoint.service');
const acc = require('../services/acc.service');

async function spToAcc(req, res, next) {
  try {
    const src = { ...req.query, ...(req.body || {}) };
    const { driveId, itemId, projectId, folderId, fileName, destPath, onConflict = 'version' } = src;

    if (!driveId || !itemId || !projectId || (!folderId && !destPath)) {
      return res.status(400).json({ error: 'driveId, itemId, projectId y (folderId o destPath) son obligatorios' });
    }

    // Validar que el item es un fichero
    const meta = await sp.getItemMeta(driveId, itemId);
    if (!meta?.file) {
      return res.status(400).json({ error: 'itemId no es un fichero (o no existe en el drive indicado)' });
    }

    // Resolver carpeta destino por ruta si viene destPath
    let destFolderId = folderId;
    if (!destFolderId && destPath) {
      destFolderId = await acc.ensureFolderByPath(projectId, destPath);
    }

    const result = await transfer.copySharePointItemToAcc({
      driveId,
      itemId,
      projectId,
      folderId: destFolderId,
      fileName,
      onConflict // version | skip | rename
    });
    res.json(result);
  } catch (e) { next(e); }
}

async function spTreeToAcc(req, res, next) {
  try {
    const src = { ...req.query, ...(req.body || {}) };
    const { driveId, itemId, projectId, folderId, destPath, mode = 'upsert' } = src;
    const dryRun = String(src.dryRun || '').toLowerCase() === 'true';

    if (!driveId || !itemId || !projectId || (!folderId && !destPath)) {
      return res.status(400).json({ error: 'driveId, itemId, projectId y (folderId o destPath) son obligatorios' });
    }

    // Resolver carpeta objetivo
    let targetFolderId = folderId;
    if (!targetFolderId && destPath) {
      targetFolderId = await acc.ensureFolderByPath(projectId, destPath);
    }

    const log = [];
    const result = await transfer.copySpTreeToAcc({
      driveId,
      itemId,
      projectId,
      targetFolderId,
      mode,   // upsert | skip | rename
      dryRun,
      onLog: (m) => log.push(m)
    });

    res.json({ ...result, log });
  } catch (e) { next(e); }
}

module.exports = { spToAcc, spTreeToAcc };
