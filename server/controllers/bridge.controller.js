const { copySpItemToAcc } = require('../services/transfer.service');

async function spToAcc(req, res, next) {
  try {
    const { driveId, itemId, projectId, folderId, fileName } = req.body;
    // req.user.credentials => token 3-legged ACC
    const result = await copySpItemToAcc({
      sp: { driveId, itemId },
      accCtx: { credentials: req.user.credentials, projectId, folderId, fileName }
    });
    res.json({ status: 'queued-or-done', detail: result });
  } catch (e) { next(e); }
}

module.exports = { spToAcc };
