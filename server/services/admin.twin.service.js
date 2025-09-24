// services/admin.twin.service.js

const fs = require('fs');
const path = require('path');
const acc = require('./acc.service');
const sp  = require('./sharepoint.service');
const { listAccSubtreeFlat } = require('./acc.inventory');
const templates = require('./admin.template.service');

const DATA_DIR = path.join(__dirname, '..', 'data', 'twins');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
const LINKS = path.join(DATA_DIR, 'links.json');

function readLinks() {
  if (!fs.existsSync(LINKS)) return { links: [] };
  return JSON.parse(fs.readFileSync(LINKS, 'utf8'));
}
function writeLinks(obj) {
  fs.writeFileSync(LINKS, JSON.stringify(obj, null, 2));
}

async function saveLink({ twinId, projectId, siteId, templateId, vars }) {
  const db = readLinks();
  const existing = db.links.find(l => l.twinId === twinId);
  const rec = { twinId, projectId, siteId, templateId, vars, createdAt: new Date().toISOString() };
  if (existing) Object.assign(existing, rec);
  else db.links.push(rec);
  writeLinks(db);
  return rec;
}

async function listLinks() {
  const db = readLinks();
  return db.links;
}

async function getStatus(twinId) {
  const db = readLinks();
  const link = db.links.find(l => l.twinId === twinId);
  if (!link) return null;

  const tpl = await templates.loadTemplate(link.templateId);
  if (!tpl) return { twinId, status: 'template-not-found' };

  // ACC: comprobamos existencia de rutas declaradas
  const accRoot = '/Project Files';
  const neededAcc = tpl.folders.map(f => `${accRoot}/${f}`);
  const accTree = await listAccSubtreeFlat(link.projectId, await acc.ensureFolderByPath(link.projectId, accRoot), { startPath: accRoot, withMeta: false });
  const accPaths = new Set(accTree.map(x => x.path.replace(/\/+$/, '')));
  const accMissing = neededAcc.filter(p => !accPaths.has(p));

  // SP: idem en drive root del sitio
  const site = await sp.resolveSiteIdFlexible({ url: undefined, hostname: undefined, path: undefined, /* usamos helpers abajo */ });
  // usamos helper de sp.service para encontrar driveId
  const { data: drv } = await sp.graphGet(`/sites/${encodeURIComponent(link.siteId)}/drive?$select=id`).catch(() => ({ data: {} }));
  const driveId = drv?.id;
  const spMissing = [];
  if (driveId) {
    // comprobamos cada folder
    for (const f of tpl.folders) {
      try {
        await sp.getItemByPath(driveId, f);
      } catch {
        spMissing.push('/' + f.replace(/^\/+/, ''));
      }
    }
  } else {
    spMissing.push('__drive__');
  }

  const ok = accMissing.length === 0 && spMissing.length === 0;
  return {
    twinId,
    projectId: link.projectId,
    siteId: link.siteId,
    templateId: link.templateId,
    ok,
    accMissing,
    spMissing
  };
}

module.exports = { saveLink, listLinks, getStatus };
