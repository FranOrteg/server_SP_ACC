// services/acc.inventory.js
const acc = require('./acc.service');
const aps = require('../clients/apsClient');

function pickSize(attrs = {}) {
    // Campos posibles según proyecto/tenant
    return attrs.storageSize
        ?? attrs.extendedData?.storageSize
        ?? attrs.extendedData?.fileSize
        ?? null;
}

async function getItemTipVersionMeta(projectId, itemId) {
    // 1) leer item para obtener el tip version id
    const item = await aps.apiGet(`/data/v1/projects/${encodeURIComponent(projectId)}/items/${encodeURIComponent(itemId)}`);
    const tipId = item?.data?.relationships?.tip?.data?.id;
    if (!tipId) return { size: null, mtime: null, hash: null };

    // 2) leer la versión tip
    const ver = await aps.apiGet(`/data/v1/projects/${encodeURIComponent(projectId)}/versions/${encodeURIComponent(tipId)}`);
    const attrs = ver?.data?.attributes || {};
    const size = pickSize(attrs);
    const mtime = attrs.lastModifiedTime || attrs.createTime || null;

    // Hash: APS no expone hash del objeto en esta API; lo dejamos null (size nos basta)
    return { size: (size != null ? Number(size) : null), mtime, hash: null, tipId };
}

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

/**
 * BFS de un folder concreto: devuelve items con path + meta (opcional)
 * [{ path, size, hash, mtime, urn }]
 */
async function listAccSubtreeFlat(projectId, startFolderId, { startPath, withMeta = false } = {}) {
    const out = [];
    const queue = [{ id: startFolderId, path: startPath || '' }];

    while (queue.length) {
        const { id, path: basePath } = queue.shift();
        const page = await acc.listFolderContents(projectId, id, { all: true, limit: 200 });
        const entries = page?.data || [];

        for (const entry of entries) {
            const name = entry.attributes?.displayName || entry.attributes?.name;
            const childPath = `${basePath}/${name}`;
            if (entry.type === 'folders') {
                queue.push({ id: entry.id, path: childPath });
            } else if (entry.type === 'items') {
                let size = null, mtime = null, hash = null;
                if (withMeta) {
                    try {
                        const meta = await getItemTipVersionMeta(projectId, entry.id);
                        size = meta.size;
                        mtime = meta.mtime;
                        hash = meta.hash;
                    } catch (e) {
                        if (process.env.DEBUG) console.warn('[ACC][meta] falló tip version meta:', e?.response?.status || e?.message);

                    }
                }
                out.push({ path: childPath, size, hash, mtime, urn: entry.id });
            }
        }
    }

    return out.sort((a, b) => a.path.localeCompare(b.path));
}
/**
 * Busca un subfolder por nombre (case-insensitive) bajo un parentFolderId.
 * Devuelve su id o null.
 */
function toNFC(s) { try { return String(s || '').normalize('NFC'); } catch { return String(s || ''); } }

async function findSubfolderByName(projectId, parentFolderId, name) {
    const wanted = String(name || '').normalize('NFC').trim().toLowerCase();
    const page = await acc.listFolderContents(projectId, parentFolderId, { all: true, limit: 200 });
    const match = (page.data || []).find(d => {
        if (d.type !== 'folders') return false;
        const n = String(d.attributes?.displayName || d.attributes?.name || '')
            .normalize('NFC').trim().toLowerCase();
        return n === wanted;
    });
    return match ? match.id : null;
}

module.exports = { listAccFlat, listAccSubtreeFlat, findSubfolderByName };
