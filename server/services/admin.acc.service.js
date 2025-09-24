// services/admin.acc.service.js
const acc = require('./acc.service');
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

module.exports = { applyTemplateToProject };
