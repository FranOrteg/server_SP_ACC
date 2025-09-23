// services/audit.service.js
const fs = require('fs');
const path = require('path');
const { listSiteFlat } = require('./sp.inventory');
const { listAccFlat }  = require('./acc.inventory');
const { buildDiff }    = require('./audit.diff');

const DATA_DIR = path.join(__dirname, '..', 'data', 'reports');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

function rid() {
  const ts = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '');
  const r = Math.random().toString(36).slice(2, 6);
  return `rep_${ts}_${r}`;
}

function toCsv(items) {
  const head = 'path,state,src_size,src_hash,src_mtime,dst_size,dst_hash,dst_mtime,action,notes';
  const esc = v => (v == null ? '' : String(v).replace(/"/g, '""'));
  const rows = items.map(it =>
    `"${esc(it.path)}","${esc(it.state)}","${esc(it.src.size)}","${esc(it.src.hash)}","${esc(it.src.mtime)}","${esc(it.dst.size)}","${esc(it.dst.hash)}","${esc(it.dst.mtime)}","${esc(it.action || '')}","${esc(it.notes || '')}"`
  );
  return [head, ...rows].join('\n');
}

async function auditSpToAcc({ siteId, projectId, since, dryRun = true, hashPolicy = 'auto' }) {
  const reportId = rid();
  const startedAt = new Date().toISOString();

  const spList  = await listSiteFlat(siteId, { since });
  const accList = await listAccFlat(projectId);

  const items = buildDiff(spList, accList, hashPolicy);

  const summary = {
    scanned: spList.length,
    ok: items.filter(i => i.state === 'OK').length,
    missingInACC: items.filter(i => i.state === 'MISSING_IN_ACC').length,
    sizeMismatch: items.filter(i => i.state === 'SIZE_MISMATCH').length,
    hashMismatch: items.filter(i => i.state === 'HASH_MISMATCH').length,
    mtimeDrift: items.filter(i => i.state === 'MTIME_DRIFT').length,
    failures: 0,
    bytesSource: spList.reduce((a, b) => a + (b.size || 0), 0),
    bytesTarget: 0,
    tookMs: 0
  };

  const finishedAt = new Date().toISOString();
  summary.tookMs = new Date(finishedAt) - new Date(startedAt);

  const payload = {
    reportId,
    migrationId: null,
    source: { type: 'sharepoint', siteId },
    target: { type: 'acc', projectId },
    params: { dryRun, since, hashPolicy, versionPolicy: 'skipIfSameHash' },
    startedAt, finishedAt, summary, items
  };

  const jsonPath = path.join(DATA_DIR, `${reportId}.json`);
  const csvPath  = path.join(DATA_DIR, `${reportId}.csv`);
  fs.writeFileSync(jsonPath, JSON.stringify(payload, null, 2));
  fs.writeFileSync(csvPath, toCsv(items));

  return { ...payload, downloadUrlCsv: `/api/audit/report/${reportId}/csv` };
}

function getReport(reportId) {
  const p = path.join(DATA_DIR, `${reportId}.json`);
  if (!fs.existsSync(p)) return null;
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function getReportCsvPath(reportId) {
  const p = path.join(DATA_DIR, `${reportId}.csv`);
  return fs.existsSync(p) ? p : null;
}

module.exports = { auditSpToAcc, getReport, getReportCsvPath };
