// services/repair.service.js
const fs = require('fs');
const os = require('os');
const path = require('path');
const axios = require('axios');
const { graphGet, graphGetStream } = require('../clients/graphClient');
const acc = require('./acc.service');
const { getReport } = require('./audit.service');

const TMP = path.join(os.tmpdir(), 'spacc');
if (!fs.existsSync(TMP)) fs.mkdirSync(TMP, { recursive: true });

async function downloadSpItem(driveId, itemId) {
  // intentamos vía /content (Graph hace 302 a SP y axios sigue)
  try {
    const resp = await graphGetStream(`/drives/${encodeURIComponent(driveId)}/items/${encodeURIComponent(itemId)}/content`);
    const tmp = path.join(TMP, `${itemId}-${Date.now()}`);
    await new Promise((res, rej) => {
      const ws = fs.createWriteStream(tmp);
      resp.data.pipe(ws);
      resp.data.on('error', rej);
      ws.on('finish', () => res());
    });
    return tmp;
  } catch (e) {
    // fallback: @microsoft.graph.downloadUrl
    const { data: meta } = await graphGet(`/drives/${encodeURIComponent(driveId)}/items/${encodeURIComponent(itemId)}`);
    const url = meta?.['@microsoft.graph.downloadUrl'];
    if (!url) throw e;
    const r = await axios.get(url, { responseType: 'stream' });
    const tmp = path.join(TMP, `${itemId}-${Date.now()}`);
    await new Promise((res, rej) => {
      const ws = fs.createWriteStream(tmp);
      r.data.pipe(ws);
      r.data.on('error', rej);
      ws.on('finish', () => res());
    });
    return tmp;
  }
}

function splitPath(p) {
  const segs = String(p || '').split('/').filter(Boolean);
  const fileName = segs.pop();
  const folderPath = '/' + segs.join('/');
  return { folderPath, fileName };
}

async function uploadToAcc(projectId, folderId, fileName, localFile) {
  const storageUrn = await acc.createStorage(projectId, folderId, fileName);
  await acc.uploadFileToStorage(storageUrn, localFile, { projectId });
  const existing = await acc.findItemByName(projectId, folderId, fileName);
  if (!existing) await acc.createItem(projectId, folderId, fileName, storageUrn);
  else await acc.createVersion(projectId, existing.id, fileName, storageUrn);
}

async function repairFromReport(reportId, { siteId, projectId, includeStates = ['MISSING_IN_ACC','SIZE_MISMATCH','HASH_MISMATCH'], maxConcurrency = 4, driveId } = {}) {
  const rep = getReport(reportId);
  if (!rep) throw new Error(`reportId ${reportId} no encontrado`);

  // driveId preferente (del body); si no, usa el del report; si no, el default del site.
  let useDriveId = driveId || rep?.source?.driveId || null;
  if (!useDriveId) {
    if (!siteId) throw new Error('Para reparar sin driveId en el reporte, pasa siteId y usaré su drive por defecto');
    const { data: drive } = await graphGet(`/sites/${encodeURIComponent(siteId)}/drive?$select=id`);
    useDriveId = drive?.id;
  }
  if (!useDriveId) throw new Error('No pude resolver driveId');

  const targets = rep.items.filter(i => includeStates.includes(i.state));
  let idx = 0, ok = 0, fail = 0;
  const errors = [];
  const N = Math.max(1, Number(maxConcurrency || 4));

  async function worker() {
    for (;;) {
      const it = targets[idx++];
      if (!it) break;
      try {
        const { folderPath, fileName } = splitPath(it.path);
        const folderId = await acc.ensureFolderByPath(projectId, folderPath);
        const tmp = await downloadSpItem(useDriveId, it.src.id);
        await uploadToAcc(projectId, folderId, fileName, tmp);
        try { fs.unlinkSync(tmp); } catch (_) {}
        ok++;
      } catch (e) {
        fail++;
        errors.push({ path: it.path, error: e?.message || String(e) });
      }
    }
  }

  await Promise.all(Array.from({ length: N }, () => worker()));
  return { total: targets.length, ok, fail, errors };
}

module.exports = { repairFromReport };
