// services/admin.acc.service.js
const acc = require('./acc.service');
const aps = require('../clients/apsUserClient');
const { expandFolders, getPermissions } = require('./admin.template.service');

// Normaliza la respuesta de ensureFolderByPath a { id, created }
async function ensurePath(projectId, fullPath) {
  // Algunos acc.ensureFolderByPath aceptan (projectId, path, { create: true })
  // otros (projectId, path, createBool). Intentamos ambas.
  let out;
  try {
    out = await acc.ensureFolderByPath(projectId, fullPath, { create: true });
  } catch {
    out = await acc.ensureFolderByPath(projectId, fullPath, true);
  }

  if (!out) return { id: null, created: false };

  if (typeof out === 'string') return { id: out, created: false };
  if (typeof out === 'object' && out.id) {
    return { id: out.id, created: !!out.created };
  }
  // fallback genérico
  return { id: out, created: false };
}

async function applyTemplateToProject({ projectId, template, resolvedName }) {
  const created = [];
  const ensured = [];

  // Aseguramos "/Project Files" siempre con ensureFolderByPath
  {
    const base = '/Project Files';
    const res = await ensurePath(projectId, base);
    if (!res.id) throw new Error('No se pudo asegurar "/Project Files" en ACC');
  }

  // Carpetas de la plantilla
  const folders = expandFolders(template);
  for (const rel of folders) {
    const fullPath = `/Project Files/${rel}`;
    const res = await ensurePath(projectId, fullPath);
    if (res.created) created.push(fullPath); else ensured.push(fullPath);
  }

  // Permisos: hook opcional (de momento no hace nada para no romper flujo)
  const perms = getPermissions(template);
  // TODO: mapear groups/role → permisos ACC si tienes helpers.
  // for (const p of perms) { await acc.ensurePermission(...); }

  return {
    projectId,
    name: resolvedName,
    folders: { created, ensured },
    permissionsApplied: perms.length || 0
  };
}

// Crea proyecto en una cuenta ACC (Construction Admin API)
async function createProject({ hubId, accountId, name, code, startDate, endDate, status = 'active', classification = 'production' }) {
  const accId = accountId || hubId; // compat con tu payload actual
  if (!accId) throw new Error('accountId (hubId) es obligatorio');
  if (!name)  throw new Error('name es obligatorio');

  const url = `/construction/admin/v1/accounts/${encodeURIComponent(accId)}/projects`; // <-- NUEVO endpoint
  const body = {
    name,
    classification,                 // 'production' | 'template'
    startDate: startDate || new Date().toISOString().slice(0,10),
    endDate: endDate || null,
    jobNumber: code || null
    // añade aquí más campos si los necesitas (type, address, timezone, etc.)
  };

  const resp = await aps.apiPost(url, body);
  const projectId = resp?.id;
  if (!projectId) throw new Error(`Respuesta inesperada al crear proyecto: ${JSON.stringify(resp).slice(0,300)}…`);
  return { projectId, raw: resp };
}


module.exports = { 
  createProject,
  applyTemplateToProject
};
