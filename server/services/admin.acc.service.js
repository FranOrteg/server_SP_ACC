// services/admin.acc.service.js
//
// Servicio "Admin ACC" (3-legged) para crear proyectos en Construction Admin,
// (best-effort) activar Docs, esperar aprovisionamiento en DM y aplicar tu
// plantilla de carpetas en Docs. Incluye ensureProjectMember() para visibilidad.
//
// Depende de:
//  - clients/apsUserClient (3LO)  -> Construction Admin API
//  - services/acc.service (2LO)   -> Data Management (project/v1, data/v1)
//  - services/admin.template.service

const apsUser = require('../clients/apsUserClient');
const dm = require('./acc.service');
const templates = require('./admin.template.service');
const { mk } = require('../helpers/logger');
const log = mk('ACC');

function ensureB(id) {
  if (!id) return id;
  return String(id).startsWith('b.') ? id : `b.${id}`;
}

// ------------------ Activar Docs (best-effort) ------------------

let DOCS_ACTIVATION_SUPPORTED; // undefined = desconocido, false = no existe en tenant, true = soportado

async function activateDocs(projectAdminId) {
  const url = `/construction/admin/v1/projects/${encodeURIComponent(projectAdminId)}/activate?service=doc_mgmt`;

  if (DOCS_ACTIVATION_SUPPORTED === false) {
    log.debug('[activateDocs] omitido (cache: no soportado en tenant)');
    return { ok: true, skipped: true, via: null };
  }

  try {
    await apsUser.apiPost(url, {});
    DOCS_ACTIVATION_SUPPORTED = true;
    log.info('[activateDocs] ok via', url);
    return { ok: true, via: url };
  } catch (e) {
    const s = e?.response?.status;
    if (s === 404) {
      DOCS_ACTIVATION_SUPPORTED = false;
      log.info('[activateDocs] no disponible en este tenant (404). No se volverá a intentar.');
      return { ok: true, skipped: true, via: url };
    }
    log.warn('[activateDocs] continua (best-effort). Motivo:', s || e.message);
    return { ok: true, skipped: true, via: url, status: s };
  }
}

// ------------------ Miembros de Proyecto ------------------

async function ensureProjectMember({
  accountId,
  projectId,
  email,
  makeProjectAdmin = true,
  grantDocs = 'admin'
}) {
  if (!projectId || !email) throw new Error('ensureProjectMember: projectId y email son obligatorios');

  const products = [];
  if (makeProjectAdmin) products.push({ key: 'projectAdministration', access: 'administrator' });
  if (grantDocs) {
    const lvl = String(grantDocs).toLowerCase();
    let access = 'viewer';
    if (lvl === 'admin') access = 'administrator';
    else if (lvl === 'member') access = 'member';
    else access = 'viewer';
    products.push({ key: 'docs', access });
  }
  const url = `/construction/admin/v1/projects/${encodeURIComponent(projectId)}/users`;
  try {
    await apsUser.apiPost(url, { email, products });
    await waitForProjectUserActive(projectId, email, { maxTries: 10, delayMs: 2000 });
    log.info('[ensureProjectMember] invitado', email, 'con', products.map(p => `${p.key}:${p.access}`).join(','));
    return { ok: true, email, via: url };
  } catch (e) {
    const st = e?.response?.status;
    const data = e?.response?.data;
    log.warn('[ensureProjectMember] fallo', st, '->', Array.isArray(data?.errors) ? data.errors.map(x => x.detail).join(' | ') : (data?.detail || e.message));
    return { ok: false, email, skipped: true, status: st, error: data || e.message };
  }
}

async function waitForProjectUserActive(projectId, email, { maxTries = 8, delayMs = 1500 } = {}) {
  for (let i = 0; i < maxTries; i++) {
    try {
      const list = await apsUser.apiGet(`/construction/admin/v1/projects/${encodeURIComponent(projectId)}/users?limit=1000&offset=0`);
      const hit = (list?.results || []).find(u => (u.email || '').toLowerCase() === (email || '').toLowerCase());
      if (hit && hit.status === 'active') return true;
    } catch { /* no romper */ }
    await new Promise(r => setTimeout(r, delayMs));
  }
  return false;
}

// ------------------ Creación de proyecto ------------------

async function createProject({
  hubId,
  accountId,
  name,
  code,
  vars = {},
  type = 'Other',
  classification = 'production',
  startDate,
  endDate,
  onNameConflict = 'suffix-timestamp'
}) {
  const accId = (accountId || (hubId || '').replace(/^b\./, '') || '').trim();
  if (!accId) throw new Error('createProject: accountId|hubId es obligatorio');
  if (!name) throw new Error('createProject: name es obligatorio');

  const payloadBase = {
    name,
    classification,
    startDate: startDate || new Date().toISOString().slice(0, 10),
    endDate: endDate || null,
    jobNumber: code || vars.code || undefined,
    type
  };

  const ts6 = () => Date.now().toString().slice(-6);
  const rnd6 = () => Math.random().toString().slice(2, 8);
  const makeRetryName = (base) => (onNameConflict === 'suffix-timestamp' ? `${base}-${ts6()}` : `${base}-${ts6()}-${rnd6()}`);

  const maxAttempts = (onNameConflict === 'fail') ? 1 : 3;
  let attempt = 0;
  let lastErr;

  while (attempt < maxAttempts) {
    const attemptName = attempt === 0 ? payloadBase.name : makeRetryName(name);
    const payload = { ...payloadBase, name: attemptName };

    try {
      const created = await apsUser.apiPost(`/construction/admin/v1/accounts/${encodeURIComponent(accId)}/projects`, payload);

      let projectAdminId =
        created?.id ||
        created?.data?.id ||
        created?.projectId ||
        (created?.links?.self && created.links.self.split('/').pop());

      if (!projectAdminId && created?.links?.self) {
        const data = await apsUser.apiGet(created.links.self);
        if (data?.id) projectAdminId = data.id;
      }
      if (!projectAdminId) throw new Error('No se pudo resolver el projectId de Admin tras la creación');

      try { await activateDocs(projectAdminId); } catch (e) {
        const st = e?.response?.status;
        if (st === 404) log.debug('[activateDocs] endpoint no disponible en este tenant. Continuamos.');
        else log.debug('[activateDocs] best-effort, continuar. Motivo:', st || e.message);
      }

      const hubIdDM = ensureB(accId);
      const projectIdDM = ensureB(projectAdminId);

      // 👉 pasar preferHubId para acelerar resolución y reducir intentos
      await dm.waitUntilDmProjectExists(hubIdDM, projectIdDM, {
        timeoutMs: 90_000,
        initialDelayMs: 700,
        maxDelayMs: 3_500,
        factor: 1.7,
        jitterMs: 200,
        silentRetries: true,
        onRetry: (i) => log.debug(`Esperando aprovisionamiento DM… intento ${i}`),
        preferHubId: hubIdDM
      });

      log.debug('DM provisioning listo para', { accountId: accId, projectId: projectAdminId });

      let dmMeta = {};
      try {
        const tf = await dm.getTopFoldersByProjectId(projectIdDM, { preferHubId: hubIdDM });
        dmMeta = { hubIdDM: tf.hubId, projectIdDM, hubRegion: tf.hubRegion };
      } catch {
        dmMeta = { hubIdDM, projectIdDM };
      }

      return {
        ok: true,
        accountId: accId,
        projectId: projectAdminId,
        name: payload.name,
        dm: dmMeta
      };
    } catch (err) {
      const status = err?.response?.status;
      const detail = err?.response?.data?.errors?.[0]?.detail || '';
      if (status === 409 && attempt < maxAttempts - 1 && onNameConflict !== 'fail') {
        attempt++;
        log.warn('409 nombre duplicado → reintento con sufijo único', { detalle: detail || '(sin detalle)', attempt, maxAttempts });
        continue;
      }
      lastErr = err;
      break;
    }
  }

  throw (lastErr || new Error('createProject: fallo desconocido creando proyecto'));
}

// ------------------ Aplicar plantilla de carpetas ------------------

async function applyTemplateToProject({
  accountId,
  projectId,
  projectIdDM,
  template,
  resolvedName,
  vars = {}
}) {
  if (!template) throw new Error('applyTemplateToProject: template es obligatorio');
  if (!(projectId || projectIdDM)) throw new Error('applyTemplateToProject: projectId|projectIdDM requerido');

  const pidDM = ensureB(projectIdDM || projectId);
  const hubIdDM = ensureB(accountId || '');

  // Asegura visibilidad en DM usando preferHubId para acelerar
  try {
    const tf = await dm.getTopFoldersByProjectId(pidDM, { preferHubId: hubIdDM });
    // ok, seguimos
  } catch (e) {
    try {
      await dm.waitUntilDmProjectExists(hubIdDM, pidDM, {
        timeoutMs: 90_000,
        initialDelayMs: 700,
        maxDelayMs: 3_500,
        factor: 1.7,
        jitterMs: 200,
        silentRetries: true,
        onRetry: (i) => log.debug(`Esperando aprovisionamiento DM… intento ${i}`),
        preferHubId: hubIdDM
      });
      await dm.getTopFoldersByProjectId(pidDM, { preferHubId: hubIdDM });
    } catch (e2) {
      throw e;
    }
  }

  // Expandir carpetas
  const expandVars = { name: resolvedName, ...(vars || {}) };
  const folders = templates.expandFolders(template, expandVars);

  // Crear bajo "/Project Files"
  const pfId = await dm.getProjectFilesFolderId(pidDM, { preferHubId: hubIdDM });
  const created = [];
  for (const f of folders) {
    const clean = f.split('/').filter(Boolean).join('/');
    const path = `/Project Files/${clean}`;
    const folderId = await dm.ensureFolderByPath(pidDM, path);
    created.push({ path, folderId });
  }

  return { ok: true, hubIdDM, projectIdDM: pidDM, folders: created };
}

module.exports = {
  createProject,
  applyTemplateToProject,
  activateDocs,
  ensureProjectMember
};
