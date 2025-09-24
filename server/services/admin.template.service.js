// services/admin.template.service.js

const fs = require('fs');
const path = require('path');

let yaml;
try { yaml = require('js-yaml'); } catch { /* opcional */ }

const TPL_DIR = path.join(__dirname, '..', 'config', 'templates');

function tryParse(filePath) {
  const raw = fs.readFileSync(filePath, 'utf8');
  if (filePath.endsWith('.json')) return JSON.parse(raw);
  if (filePath.endsWith('.yml') || filePath.endsWith('.yaml')) {
    if (!yaml) throw new Error('Instala js-yaml para usar plantillas YAML');
    return yaml.load(raw);
  }
  throw new Error('Formato de plantilla no soportado');
}

async function loadTemplate(templateId) {
  const bases = [
    path.join(TPL_DIR, `${templateId}.json`),
    path.join(TPL_DIR, `${templateId}.yaml`),
    path.join(TPL_DIR, `${templateId}.yml`)
  ];
  const file = bases.find(f => fs.existsSync(f));
  if (!file) return null;
  const tpl = tryParse(file);
  // normaliza
  tpl.templateId = tpl.templateId || templateId;
  tpl.folders = Array.isArray(tpl.folders) ? tpl.folders : [];
  tpl.permissions = Array.isArray(tpl.permissions) ? tpl.permissions : [];
  tpl.tags = Array.isArray(tpl.tags) ? tpl.tags : [];
  return tpl;
}

function expandName(tpl, vars = {}) {
  const pat = tpl.namePattern || '{name}';
  return pat.replace(/\{(\w+)\}/g, (_, k) => (vars[k] != null ? String(vars[k]) : ''));
}

module.exports = { loadTemplate, expandName };
