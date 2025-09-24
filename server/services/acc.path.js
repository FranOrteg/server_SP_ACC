// services/acc.path.js
const aps = require('../clients/apsClient');

/**
 * Sube por la cadena de padres desde folderId hasta "Project Files"
 * y construye el path: "/Project Files/.../Destino"
 */
async function resolveAccFolderPath(projectId, folderId) {
  const segs = [];
  let curId = folderId;
  let guard = 0;

  while (curId && guard++ < 64) {
    const node = await aps.apiGet(`/data/v1/projects/${encodeURIComponent(projectId)}/folders/${encodeURIComponent(curId)}`);
    const name = node?.data?.attributes?.displayName || node?.data?.attributes?.name || '??';
    segs.push(name);

    // ¿hemos llegado al root "Project Files"?
    const low = String(name).trim().toLowerCase();
    if (low === 'project files' || low === 'archivos de proyecto') break;

    // subir al padre
    const parentId = node?.data?.relationships?.parent?.data?.id;
    if (!parentId) break; // safety
    curId = parentId;
  }

  segs.reverse();
  return '/' + segs.join('/');
}

module.exports = { resolveAccFolderPath };
