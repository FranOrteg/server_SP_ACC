// controllers/bridge.controller.js
const transfer = require('../services/transfer.service');

async function spToAcc(req, res, next) {
  try {
    const { driveId, itemId, projectId, folderId, fileName } = req.query;
    if (!driveId || !itemId || !projectId || !folderId) {
      return res.status(400).json({ error: 'driveId, itemId, projectId y folderId son obligatorios' });
    }
    const result = await transfer.copySharePointItemToAcc({ driveId, itemId, projectId, folderId, fileName });
    res.json(result);
  } catch (e) { next(e); }
}

module.exports = { spToAcc };
