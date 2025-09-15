const bridge = require('../services/transfer.service');

async function spToAcc(req, res, next) {
  try {
    const { driveId, itemId, projectId, folderId } = req.body || {};
    if (!driveId || !itemId || !projectId || !folderId) {
      return res.status(400).json({ error: 'driveId, itemId, projectId y folderId son obligatorios' });
    }
    const out = await bridge.copySpItemToAcc({ driveId, itemId, projectId, folderId });
    res.json(out);
  } catch (e) { next(e); }
}

module.exports = { spToAcc };
