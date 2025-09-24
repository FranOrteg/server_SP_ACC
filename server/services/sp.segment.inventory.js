// services/sp.segment.inventory.js
const { graphGet } = require('../clients/graphClient');
const sp = require('./sharepoint.service');
const { resolveAccFolderPath } = require('./acc.path');

/**
 * Lista plana de archivos bajo (driveId,itemId) y mapea las rutas al
 * destino ACC real: <accRootPath>/<siteName>[/<root.name si NO es doclib root>]/…
 */
async function listSpSegmentMappedToAcc({ driveId, itemId, projectId, accFolderId, since }) {
  if (!driveId || !itemId) throw new Error('driveId y itemId son obligatorios');
  if (!projectId || !accFolderId) throw new Error('projectId y accFolderId son obligatorios');

  const t0 = Date.now();

  // 1) Metadatos del root + nombre del sitio + path ACC base
  const root = (await graphGet(`/drives/${encodeURIComponent(driveId)}/items/${encodeURIComponent(itemId)}`, { timeout: 60000 })).data;
  if (!root) throw new Error(`SP item ${itemId} no encontrado`);

  const siteName   = await sp.getSiteNameForItem(driveId, itemId);
  const accRootPath = await resolveAccFolderPath(projectId, accFolderId); // p.ej. "/Project Files/09 SP"

  // 2) Prefijo según sea raíz de biblioteca o subcarpeta
  const treatAsRoot = !!(root.folder && (sp.isDocLibRoot(root) || sp.isDriveRoot(root)));
  const prefix = treatAsRoot
    ? `${accRootPath}/${siteName}`
    : `${accRootPath}/${siteName}/${root.name}`;

  const out = [];
  let visited = 0;

  async function listChildrenPaged(itemId) {
    let url = `/drives/${encodeURIComponent(driveId)}/items/${encodeURIComponent(itemId)}/children?$select=id,name,folder,file,size,lastModifiedDateTime`;
    const all = [];
    for (;;) {
      const { data } = await graphGet(url, { timeout: 60000 });
      if (Array.isArray(data.value)) all.push(...data.value);
      const next = data['@odata.nextLink'];
      if (!next) break;
      url = next.replace('https://graph.microsoft.com/v1.0', '');
    }
    return all;
  }

  // ⬇️ Importante: no propagar el nombre del root a basePath
  async function walk(node, basePath, isRoot = false) {
    visited++;
    if (node.folder) {
      const children = await listChildrenPaged(node.id);
      // si es el primer nivel (isRoot=true), NO añadimos node.name a basePath
      const nextBase = isRoot ? basePath
        : (basePath ? `${basePath}/${node.name}` : (node.name || ''));
      for (const ch of children) {
        await walk(ch, nextBase, false);
      }
    } else {
      const relBase = (basePath || '').replace(/^\/+/, '');
      const rel = relBase ? `${relBase}/${node.name}` : node.name;
      const pathAcc = cleanPath(`${prefix}/${rel}`);
      const size = node.size || 0;
      const mtime = node.lastModifiedDateTime || null;
      if (!since || (mtime && new Date(mtime) >= new Date(since))) {
        const hash = node.file?.hashes?.sha1Hash ? `sha1:${node.file.hashes.sha1Hash}` : null;
        out.push({ path: pathAcc, size, hash, mtime, id: node.id });
      }
    }
  }

  // arrancamos marcando esRoot=true para no colar "root"
  await walk(root, '', true);

  out.sort((a, b) => a.path.localeCompare(b.path));
  console.log(`[AUDIT][SP] segment mapped -> items=${out.length} visited=${visited} in ${Date.now() - t0}ms prefix="${prefix}"`);
  return out;
}

function cleanPath(p='') {
  try {
    let s = String(p).normalize('NFC').replace(/\\/g,'/').replace(/\/{2,}/g,'/');
    s = s.split('/').map(seg => seg.trim()).join('/');
    if (!s.startsWith('/')) s = '/' + s;
    return s;
  } catch { return p; }
}

module.exports = { listSpSegmentMappedToAcc };
