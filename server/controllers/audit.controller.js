// controllers/audit.controller.js
const { auditSpToAcc, getReport, getReportCsvPath } = require('../services/audit.service');
const { repairFromReport } = require('../services/repair.service');

async function audit(req, res, next) {
  try {
    const { siteId, projectId, since, dryRun = 'true', hashPolicy = 'auto' } = req.query;
    if (!siteId || !projectId) return res.status(400).json({ error: 'siteId y projectId son obligatorios' });
    const rep = await auditSpToAcc({
      siteId, projectId, since,
      dryRun: String(dryRun) !== 'false',
      hashPolicy
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
    const { reportId, siteId, projectId, includeStates, maxConcurrency } = req.body || {};
    if (!reportId || !siteId || !projectId) return res.status(400).json({ error: 'reportId, siteId y projectId son obligatorios' });
    const result = await repairFromReport(reportId, {
      siteId, projectId,
      includeStates: Array.isArray(includeStates) && includeStates.length ? includeStates
        : ['MISSING_IN_ACC','SIZE_MISMATCH','HASH_MISMATCH'],
      maxConcurrency
    });
    res.json({ ok: true, reportId, result });
  } catch (e) { next(e); }
}

module.exports = { audit, report, reportCsv, repair };
