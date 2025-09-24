// controllers/sync.controller.js

const { auditSpToAcc, getReport } = require('../services/audit.service');
const { repairFromReport } = require('../services/repair.service');

async function syncSegment(req, res, next) {
  try {
    const {
      projectId, driveId, itemId, accFolderId,
      since, hashPolicy = 'auto',
      mtimePolicy = 'ignore',          // rápido por defecto
      mtimeSkewSec = 120,
      withMeta = true,                 // compara tamaños en ACC
      maxConcurrency = 4
    } = { ...req.query, ...(req.body || {}) };

    if (!projectId || !driveId || !itemId || !accFolderId) {
      return res.status(400).json({ error: 'projectId, driveId, itemId y accFolderId son obligatorios' });
    }

    // 1) AUDIT
    const audit = await auditSpToAcc({
      siteId: undefined,
      projectId, since, dryRun: true,
      hashPolicy,
      driveId, itemId, accFolderId,
      mtimePolicy, mtimeSkewSec,
      withMeta // <- pasar internamente hasta acc.inventory si quieres
    });

    const repairStates = ['MISSING_IN_ACC','SIZE_MISMATCH','HASH_MISMATCH'];
    const toFix = audit.items.filter(i => repairStates.includes(i.state)).length;

    let repair = { total: 0, ok: 0, fail: 0, errors: [] };
    if (toFix > 0) {
      repair = await repairFromReport(audit.reportId, {
        projectId,
        driveId,                // usa el del request (o se resolverá en repair si falta)
        includeStates: repairStates,
        maxConcurrency
      });
    }

    return res.json({
      ok: true,
      reportId: audit.reportId,
      auditSummary: audit.summary,
      repaired: repair,
      downloadUrlCsv: audit.downloadUrlCsv
    });
  } catch (e) { next(e); }
}

module.exports = { syncSegment };
