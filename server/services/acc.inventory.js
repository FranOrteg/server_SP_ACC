// services/acc.inventory.js
const acc = require('./acc.service');

/**
 * Devuelve lista plana bajo Project Files.
 * Por rapidez base: existencia por ruta; (size/hash/mtime) null.
 * [{ path, size, hash, mtime, urn }]
 */
async function listAccFlat(projectId) {
  const tree = await acc.listProjectTree(projectId, { includeItems: true, maxDepth: Infinity });
  const out = [];

  function visit(node) {
    if (node?.type === 'items') {
      out.push({ path: node.path, size: null, hash: null, mtime: null, urn: node.id });
    }
    (node.children || []).forEach(visit);
  }
  (tree.children || []).forEach(visit);

  return out.sort((a, b) => a.path.localeCompare(b.path));
}

module.exports = { listAccFlat };
