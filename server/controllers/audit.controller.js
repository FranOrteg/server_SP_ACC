// controllers/audit.controller.js
const { auditSpToAcc, getReport, getReportCsvPath } = require('../services/audit.service');
const { repairFromReport } = require('../services/repair.service');
const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data', 'reports');

async function listReports(req, res, next) {
    try {
        const files = fs.readdirSync(DATA_DIR)
            .filter(f => f.endsWith('.json'))
            .map(f => ({
                reportId: f.replace(/\.json$/, ''),
                file: f,
                mtime: fs.statSync(path.join(DATA_DIR, f)).mtimeMs
            }))
            .sort((a, b) => b.mtime - a.mtime)
            .slice(0, 50);
        res.json({ total: files.length, reports: files });
    } catch (e) { next(e); }
}

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

async function reAudit(req, res, next) {
    try {
        const { reportId } = req.params;
        const prev = getReport(reportId);
        if (!prev) return res.status(404).json({ error: 'report not found' });

        const { source, target, params } = prev;
        const rep = await auditSpToAcc({
            siteId: source.siteId,
            projectId: target.projectId,
            since: params.since,
            dryRun: true,
            hashPolicy: params.hashPolicy,
            driveId: source.driveId,
            itemId: source.itemId,
            accFolderId: target.accFolderId
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
                : ['MISSING_IN_ACC', 'SIZE_MISMATCH', 'HASH_MISMATCH'],
            maxConcurrency
        });
        res.json({ ok: true, reportId, result });
    } catch (e) { next(e); }
}


module.exports = { audit, report, reportCsv, repair, listReports, reAudit };
