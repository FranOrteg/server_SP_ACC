// services/audit.service.js
const fs = require('fs');
const path = require('path');

const { listSpSegmentMappedToAcc } = require('./sp.segment.inventory');
const { listSiteFlat } = require('./sp.inventory');
const { listAccFlat } = require('./acc.inventory');
const { buildDiff } = require('./audit.diff');

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

const spSvc = require('./sharepoint.service');
const { resolveAccFolderPath } = require('./acc.path');
const { listAccSubtreeFlat, findSubfolderByName } = require('./acc.inventory');

async function auditSpToAcc({ siteId, projectId, since, dryRun = true, hashPolicy = 'auto',
    driveId, itemId, accFolderId, mtimePolicy = 'informational',
    mtimeSkewSec = 120 }) {
    const reportId = rid();
    const startedAt = new Date().toISOString();

    console.log('[AUDIT] start', { projectId, siteId, driveId, itemId, accFolderId, since, hashPolicy });

    let spList;
    let accList;

    if (driveId && itemId && accFolderId) {
        // --- Inventario SP (segmento mapeado) ---
        spList = await listSpSegmentMappedToAcc({ driveId, itemId, projectId, accFolderId, since });
        console.log('[AUDIT] spList ready:', spList.length);

        // --- Calcular subárbol ACC equivalente ---
        // 1) ¿era raíz de biblioteca?
        const rootMeta = await spSvc.getItemMeta(driveId, itemId);
        const treatAsRoot = !!(rootMeta?.folder && (spSvc.isDocLibRoot(rootMeta) || spSvc.isDriveRoot(rootMeta)));
        const siteName = await spSvc.getSiteNameForItem(driveId, itemId);

        // 2) Resolver path base en ACC para accFolderId
        const accRootPath = await resolveAccFolderPath(projectId, accFolderId); // p.ej. "/Project Files/09 SP"

        // 3) Encontrar el folderId de inicio en ACC:
        //    accFolderId / siteName [ / rootMeta.name si NO es raíz de biblioteca ]
        let startFolderId = accFolderId;

        // bajar a <siteName>
        const siteFolderId = await findSubfolderByName(projectId, startFolderId, siteName);
        if (!siteFolderId) {
            console.log('[AUDIT][ACC] siteName folder no existe aún:', siteName, '→ subárbol vacío');
            accList = []; // nada en ACC; todo saldrá MISSING_IN_ACC
        } else {
            startFolderId = siteFolderId;

            if (!treatAsRoot) {
                const rootNameFolderId = await findSubfolderByName(projectId, startFolderId, rootMeta?.name);
                if (rootNameFolderId) startFolderId = rootNameFolderId;
                else {
                    console.log('[AUDIT][ACC] subcarpeta root.name no existe aún:', rootMeta?.name, '→ subárbol vacío');
                    accList = [];
                }
            }

            if (!accList) {
                // 4) Listar solo esa rama
                const startPath = treatAsRoot
                    ? `${accRootPath}/${siteName}`
                    : `${accRootPath}/${siteName}/${rootMeta?.name}`;
                accList = await listAccSubtreeFlat(projectId, startFolderId, { startPath, withMeta: true });
            }
        }

        console.log('[AUDIT] accList ready (subtree):', accList.length);
    } else {
        // --- Modo site completo (puede tardar si el proyecto es grande) ---
        spList = await listSiteFlat(siteId, { since });
        console.log('[AUDIT] spList ready (site):', spList.length);
        accList = await listAccFlat(projectId);
        console.log('[AUDIT] accList ready (full):', accList.length);
    }

    const items = buildDiff(spList, accList, hashPolicy, { mtimePolicy, mtimeSkewSec });

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
        source: { type: 'sharepoint', siteId, driveId, itemId },
        target: { type: 'acc', projectId, accFolderId },
        params: { dryRun, since, hashPolicy, mtimePolicy, mtimeSkewSec, versionPolicy: 'skipIfSameHash' },
        startedAt, finishedAt, summary, items
    };

    const jsonPath = path.join(DATA_DIR, `${reportId}.json`);
    const csvPath = path.join(DATA_DIR, `${reportId}.csv`);
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
