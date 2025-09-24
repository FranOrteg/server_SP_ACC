// services/admin.apply.js

const acc = require('./acc.service');
const sp = require('./sharepoint.service');

// Rellena variables simples en strings "PRJ-{code}-{name}"
function fill(s, vars = {}) {
  return String(s || '').replace(/\{(\w+)\}/g, (_, k) => vars[k] ?? '');
}

// Aplica plantilla en ACC: crea carpetas (y permisos si ya tienes ese helper)
async function applyAccTemplate({ projectId, template, vars }) {
  const base = await acc.folderByPath(projectId, '/Project Files', { create: true }); // ya tenías ruta en peticiones.rest
  const rootId = base?.id || base;

  // carpetas
  for (const raw of (template.folders || [])) {
    const path = raw.split('/').map(seg => fill(seg, vars)).join('/');
    await acc.ensureFolderByPath(projectId, `/Project Files/${path}`, { create: true });
  }

  // permisos (opcional: si tienes helpers para roles/grupos)
  // for (const p of (template.permissions || [])) { ... }
}

// Aplica plantilla en SP (opcional): estructura en doclib principal
async function applySpTemplate({ siteId, template, vars }) {
  // Obtener el drive (document library) por defecto del sitio
  const { data: drive } = await acc.apiGet
  // ↑ ojo: aquí NO es ACC. Usa Graph:
  // const { data: drive } = await graphGet(`/sites/${siteId}/drive?$select=id,name`);
  // Luego vas creando subcarpetas con Graph POST children.
  // Si quieres, te paso el helper `ensureSpFolderByPath` en el siguiente paso.
}

module.exports = { applyAccTemplate, applySpTemplate };
