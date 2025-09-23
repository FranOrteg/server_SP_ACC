// services/sp.inventory.js
const { graphGet } = require('../clients/graphClient');

/**
 * Devuelve el driveId por defecto del sitio.
 */
async function getDefaultDriveId(siteId) {
  const { data } = await graphGet(`/sites/${encodeURIComponent(siteId)}/drive`);
  return data?.id;
}

/**
 * Lista recursivamente todos los archivos del drive por defecto del site.
 * Devuelve [{ path, size, hash, mtime, id }]
 */
async function listSiteFlat(siteId, { since } = {}) {
  const driveId = await getDefaultDriveId(siteId);
  if (!driveId) throw new Error(`No se encontró drive por defecto para siteId=${siteId}`);

  // arranca en root
  const { data: root } = await graphGet(`/drives/${encodeURIComponent(driveId)}/root`);
  const out = [];

  async function walk(itemId, prefixPath) {
    let url = `/drives/${encodeURIComponent(driveId)}/items/${encodeURIComponent(itemId)}/children?$select=id,name,folder,file,size,lastModifiedDateTime`;
    for (;;) {
      const { data } = await graphGet(url);
      const list = data?.value || [];
      for (const it of list) {
        const name = it.name || '';
        const path = prefixPath ? `${prefixPath}/${name}` : `/${name}`;
        if (it.folder) {
          await walk(it.id, path);
        } else {
          const size = it.size || 0;
          const hash = it.file?.hashes?.sha1Hash ? `sha1:${it.file.hashes.sha1Hash}` : null;
          const mtime = it.lastModifiedDateTime || null;
          if (!since || (mtime && new Date(mtime) >= new Date(since))) {
            out.push({ path, size, hash, mtime, id: it.id });
          }
        }
      }
      const next = data?.['@odata.nextLink'];
      if (!next) break;
      url = next.replace('https://graph.microsoft.com/v1.0', '');
    }
  }

  await walk(root.id, '');
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

module.exports = { listSiteFlat };
