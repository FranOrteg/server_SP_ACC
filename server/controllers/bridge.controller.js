// controllers/bridge.controller.js

const transfer = require('../services/transfer.service');
const sp = require('../services/sharepoint.service');

async function spToAcc(req, res, next) {
  try {
    const src = { ...req.query, ...(req.body || {}) };
    const { driveId, itemId, projectId, folderId, fileName } = src;

    if (!driveId || !itemId || !projectId || !folderId) {
      return res.status(400).json({ error: 'driveId, itemId, projectId y folderId son obligatorios' });
    }

    // 👇 comprueba que itemId es un fichero (no carpeta)
    const meta = await sp.getItemMeta(driveId, itemId);
    if (!meta?.file) {
      return res.status(400).json({ error: 'itemId no es un fichero (o no existe en el drive indicado)' });
    }

    const result = await transfer.copySharePointItemToAcc({ driveId, itemId, projectId, folderId, fileName });
    res.json(result);
  } catch (e) { next(e); }
}

async function spTreeToAcc(req, res, next) {
  try {
    const src = { ...req.query, ...(req.body || {}) };
    const { driveId, itemId, projectId, folderId, mode = 'upsert' } = src;
    const dryRun = String(src.dryRun || '').toLowerCase() === 'true';

    if (!driveId || !itemId || !projectId || !folderId) {
      return res.status(400).json({ error: 'driveId, itemId, projectId y folderId son obligatorios' });
    }

    const log = [];
    const result = await transfer.copySpTreeToAcc({
      driveId,
      itemId,
      projectId,
      targetFolderId: folderId,
      mode,
      dryRun,
      onLog: (m) => log.push(m)
    });

    res.json({ ...result, log });
  } catch (e) { next(e); }
}

module.exports = { 
  spToAcc, 
  spTreeToAcc 
};
