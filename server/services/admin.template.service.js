// services/admin.template.service.js
const fs = require('fs');
const path = require('path');

const TPL_DIR = path.join(__dirname, '..', 'config', 'templates');

// Carga JSON: config/templates/<templateId>.json
async function loadTemplate(templateId) {
  if (!templateId) return null;
  const file = path.join(TPL_DIR, `${templateId}.json`);
  if (!fs.existsSync(file)) return null;
  const raw = fs.readFileSync(file, 'utf8');
  return JSON.parse(raw);
}

// Expande "PRJ-{code}-{name}"
function expandOne(s, vars = {}) {
  return String(s || '').replace(/\{(\w+)\}/g, (_, k) => (vars[k] ?? ''));
}

// Expande namePattern y devuelve un string “bonito”
function expandName(tpl, vars = {}) {
  const pat = tpl?.namePattern || '{name}';
  return expandOne(pat, vars).replace(/\s+/g, ' ').trim();
}

// Devuelve la lista de carpetas expandida (respetando subniveles "a/b/c")
function expandFolders(tpl, vars = {}) {
  const list = Array.isArray(tpl?.folders) ? tpl.folders : [];
  return list.map(f => f.split('/').map(seg => expandOne(seg, vars)).join('/'));
}

// (Opcional) permisos tal cual están en la plantilla
function getPermissions(tpl) {
  return Array.isArray(tpl?.permissions) ? tpl.permissions : [];
}

module.exports = { loadTemplate, expandName, expandFolders, getPermissions };
