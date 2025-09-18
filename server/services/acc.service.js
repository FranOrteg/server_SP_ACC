// services/acc.service.js
const fs = require('fs');
const axios = require('axios');
const aps = require('../clients/apsClient');

// --- LISTAR ---
async function listHubs() {
  return await aps.apiGet('/project/v1/hubs');
}

async function listProjects(hubId, { all = false, limit = 50 } = {}) {
  if (!hubId) throw new Error('hubId es obligatorio');
  const base = `/project/v1/hubs/${encodeURIComponent(hubId)}/projects`;
  if (!all) return await aps.apiGet(`${base}?page[limit]=${limit}`);
  let url = `${base}?page[limit]=${limit}`;
  const out = [];
  for (;;) {
    const page = await aps.apiGet(url);
    if (Array.isArray(page.data)) out.push(...page.data);
    const next = page.links?.next?.href;
    if (!next) return { ...page, data: out };
    url = next.replace('https://developer.api.autodesk.com', '');
  }
}

async function listTopFolders(hubId, projectId) {
  if (!hubId || !projectId) throw new Error('hubId y projectId son obligatorios');
  const u = `/project/v1/hubs/${encodeURIComponent(hubId)}/projects/${encodeURIComponent(projectId)}/topFolders`;
  return await aps.apiGet(u);
}

// --- CONTENIDOS CARPETA ---
async function listFolderContents(projectId, folderId, { all = false, limit = 200 } = {}) {
  const base = `/data/v1/projects/${encodeURIComponent(projectId)}/folders/${encodeURIComponent(folderId)}/contents`;
  if (!all) return await aps.apiGet(`${base}?page[limit]=${limit}`);
  let url = `${base}?page[limit]=${limit}`;
  const included = [];
  const data = [];
  for (;;) {
    const page = await aps.apiGet(url);
    if (Array.isArray(page.data)) data.push(...page.data);
    if (Array.isArray(page.included)) included.push(...page.included);
    const next = page.links?.next?.href;
    if (!next) return { ...page, data, included };
    url = next.replace('https://developer.api.autodesk.com', '');
  }
}

// --- FOLDERS ---
async function findChildByName(projectId, parentFolderId, name) {
  const page = await listFolderContents(projectId, parentFolderId, { all: true, limit: 200 });
  const child = (page.data || []).find(d => {
    const n = (d.attributes?.displayName || d.attributes?.name || '').trim().toLowerCase();
    return n === name.trim().toLowerCase();
  });
  return child || null;
}

async function ensureFolder(projectId, parentFolderId, name) {
  const existing = await findChildByName(projectId, parentFolderId, name);
  if (existing && existing.type === 'folders') return existing.id;

  const body = {
    jsonapi: { version: '1.0' },
    data: {
      type: 'folders',
      attributes: {
        name,
        extension: { type: 'folders:autodesk.bim360:Folder', version: '1.0' }
      },
      relationships: {
        parent: { data: { type: 'folders', id: parentFolderId } }
      }
    }
  };
  const created = await aps.apiPost(`/data/v1/projects/${encodeURIComponent(projectId)}/folders`, body);
  return created.data?.id;
}

// --- STORAGE + UPLOAD ---
async function createStorage(projectId, folderId, fileName) {
  const body = {
    jsonapi: { version: '1.0' },
    data: {
      type: 'objects',
      attributes: { name: fileName },
      relationships: { target: { data: { type: 'folders', id: folderId } } }
    }
  };
  const res = await aps.apiPost(`/data/v1/projects/${encodeURIComponent(projectId)}/storage`, body);
  return res.data?.id; // urn:adsk.objects:os.object:wip.dm.prod/<guid>/<filename>
}

function parseStorageUrn(storageUrn) {
  const m = /^urn:adsk\.objects:os\.object:([^/]+)\/(.+)$/.exec(storageUrn);
  if (!m) throw new Error(`Storage URN inválido: ${storageUrn}`);
  return { bucketKey: m[1], objectName: m[2] };
}

async function uploadFileToStorage(storageUrn, localFilePath) {
  const { bucketKey, objectName } = parseStorageUrn(storageUrn);
  const accessToken = await aps.getAppAccessToken();

  const size = fs.statSync(localFilePath).size;
  const stream = fs.createReadStream(localFilePath);

  const url = `https://developer.api.autodesk.com/oss/v2/buckets/${encodeURIComponent(bucketKey)}/objects/${encodeURIComponent(objectName)}`;
  const { data, status } = await axios.put(url, stream, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/octet-stream',
      'Content-Length': size
    },
    maxBodyLength: Infinity,
    maxContentLength: Infinity
  });

  if (status < 200 || status >= 300) throw new Error(`Fallo subiendo a OSS (${status})`);
  return data;
}

// --- ARCHIVOS ---
async function findItemByName(projectId, folderId, fileName) {
  const page = await listFolderContents(projectId, folderId, { all: true, limit: 200 });
  const item = (page.data || []).find(d =>
    d.type === 'items' &&
    (d.attributes?.displayName || '').toLowerCase() === fileName.toLowerCase()
  );
  return item || null;
}

async function createItem(projectId, folderId, fileName, storageUrn) {
  const body = {
    jsonapi: { version: '1.0' },
    data: {
      type: 'items',
      attributes: {
        displayName: fileName,
        extension: { type: 'items:autodesk.bim360:File', version: '1.0' }
      },
      relationships: {
        tip: { data: { type: 'versions', id: '1' } },
        parent: { data: { type: 'folders', id: folderId } }
      }
    },
    included: [
      {
        type: 'versions',
        id: '1',
        attributes: {
          name: fileName,
          extension: { type: 'versions:autodesk.bim360:File', version: '1.0' }
        },
        relationships: {
          storage: { data: { type: 'objects', id: storageUrn } }
        }
      }
    ]
  };
  return await aps.apiPost(`/data/v1/projects/${encodeURIComponent(projectId)}/items`, body);
}

async function createVersion(projectId, itemId, fileName, storageUrn) {
  const body = {
    jsonapi: { version: '1.0' },
    data: {
      type: 'versions',
      attributes: {
        name: fileName,
        extension: { type: 'versions:autodesk.bim360:File', version: '1.0' }
      },
      relationships: {
        item: { data: { type: 'items', id: itemId } },
        storage: { data: { type: 'objects', id: storageUrn } }
      }
    }
  };
  return await aps.apiPost(`/data/v1/projects/${encodeURIComponent(projectId)}/versions`, body);
}

// --- util: intenta encontrar el hub que contiene un projectId ---
async function findHubForProject(projectId) {
  const hubsResp = await aps.apiGet('/project/v1/hubs');
  const hubs = (hubsResp?.data || []).map(h => h.id);

  for (const hubId of hubs) {
    try {
      // Si el proyecto no está en ese hub, Autodesk devuelve 404
      await aps.apiGet(`/project/v1/hubs/${encodeURIComponent(hubId)}/projects/${encodeURIComponent(projectId)}`);
      return hubId; // encontrado
    } catch (e) {
      const status = e?.response?.status;
      if (status === 404) continue; // prueba el siguiente hub
      // Otros códigos: propaga (403/401/etc.)
      throw e;
    }
  }
  throw new Error(`projectId ${projectId} no encontrado en ninguno de los hubs accesibles`);
}

// --- obtener top folders usando solo projectId (auto hub) ---
async function getTopFoldersByProjectId(projectId) {
  const hubId = await findHubForProject(projectId);
  const u = `/project/v1/hubs/${encodeURIComponent(hubId)}/projects/${encodeURIComponent(projectId)}/topFolders`;
  const resp = await aps.apiGet(u);
  // Normalmente vienen 2: Project Files y Plans
  return { hubId, topFolders: resp?.data || [] };
}

// --- construir árbol recursivo ---
async function listProjectTree(projectId, { includeItems = false, maxDepth = Infinity } = {}) {
  const { hubId, topFolders } = await getTopFoldersByProjectId(projectId);

  // Nodo raíz “virtual” que agrupa los top folders
  const root = {
    projectId,
    hubId,
    type: 'project',
    name: `project:${projectId}`,
    children: []
  };

  // BFS para no reventar la pila en proyectos grandes
  const queue = [];
  for (const tf of topFolders) {
    const node = {
      id: tf.id,
      type: tf.type,                 // 'folders'
      name: tf.attributes?.displayName || tf.attributes?.name,
      path: `/${tf.attributes?.displayName || tf.attributes?.name}`,
      children: []
    };
    root.children.push(node);
    queue.push({ node, depth: 1 });
  }

  while (queue.length) {
    const { node, depth } = queue.shift();
    if (depth > maxDepth) continue;

    // Lista contenidos de la carpeta
    const page = await listFolderContents(projectId, node.id, { all: true, limit: 200 });
    const entries = page?.data || [];

    for (const entry of entries) {
      const isFolder = entry.type === 'folders';
      const display = entry.attributes?.displayName || entry.attributes?.name;
      const child = {
        id: entry.id,
        type: entry.type, // 'folders' | 'items'
        name: display,
        path: `${node.path}/${display}`
      };

      // Si es carpeta, la encolamos para seguir bajando
      if (isFolder) {
        child.children = [];
        node.children.push(child);
        queue.push({ node: child, depth: depth + 1 });
      } else {
        // 'items': solo añadimos si includeItems=true
        if (includeItems) node.children.push(child);
      }
    }
  }

  return root;
}


// Devuelve el 'Project Files' folderId del proyecto (buscando en topFolders)
async function getProjectFilesFolderId(projectId) {
  const { hubId, topFolders } = await getTopFoldersByProjectId(projectId);
  const pf = (topFolders || []).find(f =>
    (f.attributes?.displayName || f.attributes?.name || '').toLowerCase() === 'project files'
  );
  if (!pf) throw new Error(`No se encontró "Project Files" en projectId ${projectId} (hubId ${hubId})`);
  return pf.id;
}

// Normaliza ruta (acepta "/Archivos de proyecto" o "/Project Files")
function normalizeRoot(seg) {
  const s = (seg || '').trim().toLowerCase();
  return (s === 'archivos de proyecto' || s === 'project files') ? 'Project Files' : seg;
}

// Busca/crea una carpeta por ruta absoluta bajo Project Files.
// path p.ej: "/Project Files/09 SP" o "/Archivos de proyecto/09 SP"
async function ensureFolderByPath(projectId, path) {
  if (!path?.startsWith('/')) throw new Error('path debe empezar por "/"');

  const parts = path.split('/').filter(Boolean);
  if (!parts.length) throw new Error('path inválido');

  // Aceptamos ambos idiomas para el primer segmento
  parts[0] = normalizeRoot(parts[0]);

  if (parts[0] !== 'Project Files') {
    throw new Error('La ruta debe empezar por "/Project Files" (o "/Archivos de proyecto")');
  }

  let currentId = await getProjectFilesFolderId(projectId);
  for (let i = 1; i < parts.length; i++) {
    const name = parts[i];
    // ¿existe ya?
    const page = await listFolderContents(projectId, currentId, { all: true, limit: 200 });
    const child = (page.data || []).find(d =>
      d.type === 'folders' &&
      ((d.attributes?.displayName || d.attributes?.name || '').trim().toLowerCase() === name.trim().toLowerCase())
    );
    if (child) {
      currentId = child.id;
    } else {
      // crear
      currentId = await ensureFolder(projectId, currentId, name);
    }
  }
  return currentId; // folderId final
}

module.exports = {
  listHubs,
  listProjects,
  listTopFolders,
  listFolderContents,
  findChildByName,
  ensureFolder,
  createStorage,
  uploadFileToStorage,
  findItemByName,
  createItem,
  createVersion,
  parseStorageUrn,
  listProjectTree,
  getProjectFilesFolderId,
  ensureFolderByPath
};
