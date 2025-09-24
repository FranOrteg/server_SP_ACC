// controllers/audit.controller.js
const { auditSpToAcc, getReport, getReportCsvPath } = require('../services/audit.service');
const { repairFromReport } = require('../services/repair.service');

async function audit(req, res, next) {
  try {
    const {
      siteId, projectId, since, dryRun = 'true', hashPolicy = 'auto',
      driveId, itemId, accFolderId,
      mtimePolicy = 'informational', mtimeSkewSec = '120'
    } = req.query;

    if (!projectId) return res.status(400).json({ error: 'projectId es obligatorio' });
    if (!(driveId && itemId && accFolderId) && !siteId) {
      return res.status(400).json({ error: 'siteId es obligatorio si no pasas driveId+itemId+accFolderId' });
    }

    const rep = await auditSpToAcc({
      siteId, projectId, since,
      dryRun: String(dryRun) !== 'false',
      hashPolicy,
      driveId, itemId, accFolderId,
      mtimePolicy, mtimeSkewSec: Number(mtimeSkewSec) || 120
    });
    res.json(rep);
  } catch (e) { next(e); }
}

async function report(req, res, next) {
  try {
    const r = getReport(req.params.reportId);
    if (!r) return res.status(404).json({ error: 'report not found' });
    res.json(r);
  } catch (e) { next(e); }
}

async function reportCsv(req, res, next) {
  try {
    const p = getReportCsvPath(req.params.reportId);
    if (!p) return res.status(404).json({ error: 'csv not found' });
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${req.params.reportId}.csv"`);
    res.sendFile(p);
  } catch (e) { next(e); }
}

async function repair(req, res, next) {
  try {
    const { reportId, siteId, projectId, includeStates, maxConcurrency, driveId } = req.body || {};
    if (!reportId || !projectId) return res.status(400).json({ error: 'reportId y projectId son obligatorios' });

    const result = await repairFromReport(reportId, {
      siteId, projectId, driveId,
      includeStates: Array.isArray(includeStates) && includeStates.length ? includeStates
        : ['MISSING_IN_ACC','SIZE_MISMATCH','HASH_MISMATCH'],
      maxConcurrency
    });
    res.json({ ok: true, reportId, result });
  } catch (e) { next(e); }
}


module.exports = { audit, report, reportCsv, repair };
