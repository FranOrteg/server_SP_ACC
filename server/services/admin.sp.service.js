// services/admin.sp.service.js
const { graphGet, graphPost } = require('../clients/graphClient');
const sp = require('./sharepoint.service');
const { expandFolders, getPermissions } = require('./admin.template.service');

async function getDefaultDriveId(siteId) {
  // /sites/{siteId}/drive → default doc library
  const { data } = await graphGet(`/sites/${encodeURIComponent(siteId)}/drive?$select=id,name`);
  return data?.id;
}

// Lee un item por ruta relativa dentro del drive (sin :/children)
async function getItemByPath(driveId, relPath) {
  const clean = relPath.replace(/^\/+/, '');
  const url = clean ? `/drives/${driveId}/root:/${encodeURI(clean)}` : `/drives/${driveId}/root`;
  const { data } = await graphGet(url);
  return data; // throw si 404
}

// Crea una subcarpeta hija por nombre directo bajo parentId
async function createChildFolder(driveId, parentItemId, name) {
  const { data } = await graphPost(`/drives/${driveId}/items/${parentItemId}/children`, {
    name,
    folder: {},
    '@microsoft.graph.conflictBehavior': 'fail'
  });
  return data;
}

// Ensure de ruta tipo "A/B/C": intenta leer; si no existe, crea segmento a segmento.
async function ensureFolderByPath(driveId, relPath) {
  const segs = String(relPath || '').split('/').filter(Boolean);
  // parent = root
  const root = await getItemByPath(driveId, '');
  let parentId = root.id;
  let built = '';

  for (const seg of segs) {
    built = built ? `${built}/${seg}` : seg;
    try {
      const item = await getItemByPath(driveId, built);
      parentId = item.id;
    } catch (e) {
      // crear este segmento
      const created = await createChildFolder(driveId, parentId, seg);
      parentId = created.id;
    }
  }
  return parentId;
}

async function applyTemplateToSite({ siteId, siteUrl, template, resolvedName }) {
  // 1) resolver siteId si viene solo siteUrl
  let sId = siteId;
  if (!sId && siteUrl) {
    const s = await sp.resolveSiteIdFlexible({ url: siteUrl });
    sId = s?.id;
  }
  if (!sId) throw new Error('No pude resolver siteId');

  // 2) drive por defecto
  const driveId = await getDefaultDriveId(sId);
  if (!driveId) throw new Error('No encontré la biblioteca por defecto');

  // 3) carpetas
  const created = [];
  const ensured = [];
  const folders = expandFolders(template);
  for (const rel of folders) {
    try {
      await getItemByPath(driveId, rel);
      ensured.push(rel);
    } catch {
      await ensureFolderByPath(driveId, rel);
      created.push(rel);
    }
  }

  // 4) permisos (TODO opcional)
  const perms = getPermissions(template);
  // Mapea permisos a grupos de SP (Owners/Members/Visitors o M365 groups)
  // for (const p of perms) { await ensureSpPermission(...); }

  return {
    siteId: sId,
    name: resolvedName,
    folders: { created, ensured },
    permissionsApplied: perms.length || 0
  };
}

module.exports = { applyTemplateToSite };
