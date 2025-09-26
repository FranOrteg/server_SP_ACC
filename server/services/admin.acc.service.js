// services/admin.acc.service.js
const acc = require('./acc.service');
const aps = require('../clients/apsUserClient');
const { expandFolders, getPermissions } = require('./admin.template.service');

/* =========================
 * Helpers
 * ========================= */

// Normaliza la respuesta de ensureFolderByPath a { id, created }
async function ensurePath(projectIdDM, fullPath) {
  let out;
  try {
    out = await acc.ensureFolderByPath(projectIdDM, fullPath, { create: true });
  } catch {
    out = await acc.ensureFolderByPath(projectIdDM, fullPath, true);
  }
  if (!out) return { id: null, created: false };
  if (typeof out === 'string') return { id: out, created: false };
  if (typeof out === 'object' && out.id) return { id: out.id, created: !!out.created };
  return { id: out, created: false };
}

// Elimina claves con undefined o null
function compact(obj = {}) {
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === null) continue;
    out[k] = v;
  }
  return out;
}

// Construye IDs de DM a partir de Admin
function makeDmIds(accountId, adminProjectId) {
  const hubIdDM = `b.${accountId}`;
  const projectIdDM = `b.${accountId}.${adminProjectId}`;
  return { hubIdDM, projectIdDM };
}

// (opcional) pequeña espera
const delay = ms => new Promise(r => setTimeout(r, ms));

// Resuelve un “templateId” de Admin (UUID) o alias humano contra Admin v1
async function resolveTemplateProjectId(accountId, templateAliasOrId) {
  if (!templateAliasOrId) return null;
  // UUID?
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(templateAliasOrId)) {
    return templateAliasOrId;
  }
  const url = `/construction/admin/v1/accounts/${encodeURIComponent(accountId)}/projects?filter[classification]=template`;
  const list = await aps.apiGet(url);
  const results = Array.isArray(list?.results) ? list.results : (Array.isArray(list) ? list : []);
  const alias = String(templateAliasOrId).toLowerCase();
  const hit = results.find(p => (p?.name || '').toLowerCase().includes(alias));
  if (!hit) throw new Error(`No encuentro plantilla en la cuenta ${accountId} para alias: "${templateAliasOrId}". Usa el UUID del proyecto plantilla o revisa el nombre.`);
  return hit.id;
}

/* =========================
 * Aplicar plantilla (carpetas/permissions)
 * ========================= */

async function applyTemplateToProject({ accountId, projectId /* Admin GUID */, projectIdDM, template, resolvedName }) {
  // Aseguramos usar el projectId **de DM**
  const dm = projectIdDM || makeDmIds(accountId, projectId).projectIdDM;

  // Puede tardar unos segundos tras el 202 de creación
  await delay(2500);

  const created = [];
  const ensured = [];

  // Asegura "/Project Files"
  {
    const base = '/Project Files';
    const res = await ensurePath(dm, base);
    if (!res.id) throw new Error(`No se pudo asegurar "/Project Files" en ACC (projectIdDM: ${dm})`);
  }

  // Carpetas de la plantilla
  const folders = expandFolders(template);
  for (const rel of folders) {
    const fullPath = `/Project Files/${rel}`;
    const res = await ensurePath(dm, fullPath);
    if (res.created) created.push(fullPath); else ensured.push(fullPath);
  }

  // Permisos (opcional por ahora)
  const perms = getPermissions(template);
  // TODO: mapear groups/role → permisos ACC si tienes helpers (acc.ensurePermission)

  return {
    projectId,           // Admin GUID
    projectIdDM: dm,     // DM ID
    name: resolvedName,
    folders: { created, ensured },
    permissionsApplied: perms.length || 0
  };
}

/* =========================
 * Crear proyecto (ACC Admin v1)
 * ========================= */

async function createProject(input = {}) {
  const {
    hubId,
    accountId: accountIdRaw,
    templateId: templateAliasOrId,
    vars = {},
    name: nameDirect,
    code: codeDirect,
    startDate: startDirect,
    endDate: endDirect,
    classification: classDirect = 'production'
  } = input;

  // Deriva accountId
  let accountId = accountIdRaw || hubId;
  if (!accountId) throw new Error('hubId o accountId es obligatorio');
  accountId = String(accountId).replace(/^b\./, '');

  // Deriva name / code desde vars o desde top-level
  const code = vars.code ?? codeDirect ?? undefined;
  const baseName = vars.name ?? nameDirect ?? undefined;
  if (!baseName) throw new Error('name (o vars.name) es obligatorio');

  // Nombre final
  const resolvedName = code ? `PRJ-${code}-${baseName}` : baseName;

  // Fechas
  const startDate = vars.startDate ?? startDirect ?? new Date().toISOString().slice(0, 10);
  const endDate = vars.endDate ?? endDirect ?? undefined;

  // Campos obligatorios Admin v1
  const classification = vars.classification ?? classDirect ?? 'production';
  const type = vars.type ?? 'Other';

  const body = compact({
    name: resolvedName,
    classification,
    type,            // OBLIGATORIO
    jobNumber: code, // opcional
    startDate,
    endDate
  });

  // Plantilla Admin (clonado)
  if (templateAliasOrId) {
    const tplId = await resolveTemplateProjectId(accountId, templateAliasOrId);
    body.template = { projectId: tplId };
    console.log('[ACC] Clonando desde plantilla =>', tplId);
  }

  const url = `/construction/admin/v1/accounts/${encodeURIComponent(accountId)}/projects`;
  console.log('[ACC] POST', url, 'payload =>', JSON.stringify(body));

  const resp = await aps.apiPost(url, body); // 202 Accepted
  const adminProjectId = resp?.id;
  if (!adminProjectId) {
    throw new Error(`Respuesta inesperada al crear proyecto ACC: ${JSON.stringify(resp).slice(0, 300)}…`);
  }

  // Devuelve también IDs de DM ya “construidos”
  const dm = makeDmIds(accountId, adminProjectId);

  return {
    accountId,
    projectId: adminProjectId, // Admin GUID
    name: resolvedName,
    dm,                        // { hubIdDM, projectIdDM }
    raw: resp
  };
}

module.exports = {
  createProject,
  applyTemplateToProject
};
