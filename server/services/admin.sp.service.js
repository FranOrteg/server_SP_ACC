// services/admin.sp.service.js

const sp = require('./sharepoint.service');
const { graphGet, graphPost } = require('../clients/graphClient');

async function getDefaultDriveId(siteId) {
  const { data } = await graphGet(`/sites/${encodeURIComponent(siteId)}/drive?$select=id`);
  return data?.id;
}

async function ensureFolderByPath(driveId, folderPath) {
  const segs = String(folderPath || '').split('/').filter(Boolean);
  let baseSegs = [];
  for (const s of segs) {
    baseSegs.push(s);
    const partial = baseSegs.join('/');
    // ¿existe?
    try {
      await sp.getItemByPath(driveId, partial);
    } catch {
      // crear
      await graphPost(`/drives/${encodeURIComponent(driveId)}/root/children`, {
        name: s, folder: {}, '@microsoft.graph.conflictBehavior': 'retain'
      });
    }
  }
}

/**
 * Aplica la plantilla a un sitio SharePoint *existente*:
 * - Detecta drive por defecto
 * - Crea/asegura carpetas en "Documents" (drive root)
 * - (TODO) Aplica permisos según template.permissions
 *
 * Si pasas siteUrl, lo resolvemos a siteId con tu helper.
 */
async function applyTemplateToSite({ siteId, siteUrl, template, resolvedName }) {
  let useSiteId = siteId;
  if (!useSiteId && siteUrl) {
    const resolved = await sp.resolveSiteIdFlexible({ url: siteUrl });
    useSiteId = resolved?.id;
  }
  if (!useSiteId) throw new Error('No pude resolver siteId');

  const driveId = await getDefaultDriveId(useSiteId);
  if (!driveId) throw new Error('No pude obtener driveId del sitio');

  const created = [];
  for (const f of template.folders) {
    const p = '/' + String(f || '').replace(/^\/+/, '').replace(/\/+$/, '');
    await ensureFolderByPath(driveId, p);
    created.push({ path: p, driveId });
  }

  const permApplied = template.permissions.map(p => ({
    group: p.group,
    role: p.role,
    status: 'SKIPPED_TODO'
  }));

  return { siteId: useSiteId, name: resolvedName, created, permissions: permApplied };
}

module.exports = { applyTemplateToSite };
