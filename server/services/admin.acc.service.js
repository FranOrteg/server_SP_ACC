// services/admin.acc.service.js
const acc = require('./acc.service');

function normFolder(p) {
  return '/' + String(p || '').replace(/^\/+/, '').replace(/\/+$/, '');
}

/**
 * Aplica la plantilla a un proyecto ACC *existente*:
 * - Crea/asegura la estructura de carpetas bajo /Project Files
 * - (TODO) Aplica permisos/roles según template.permissions
 */
async function applyTemplateToProject({ projectId, template, resolvedName }) {
  const rootPath = '/Project Files'; // asumimos estructura estándar
  const created = [];
  for (const f of template.folders) {
    const full = normFolder(`${rootPath}/${f}`);
    const id = await acc.ensureFolderByPath(projectId, full);
    created.push({ path: full, folderId: id });
  }

  // Placeholder permisos (requiere decidir roles/permission sets concretos)
  const permApplied = template.permissions.map(p => ({
    group: p.group,
    role: p.role,
    status: 'SKIPPED_TODO'
  }));

  // Tags: podríamos guardar como atributos de proyecto vía Admin API (futuro)
  return { name: resolvedName, created, permissions: permApplied };
}

module.exports = { applyTemplateToProject };
