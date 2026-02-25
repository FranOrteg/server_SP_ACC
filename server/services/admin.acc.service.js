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
const aps2LO = require('../clients/apsClient');
const { mk } = require('../helpers/logger');
const log = mk('ACC');

function ensureB(id) {
  if (!id) return id;
  return String(id).startsWith('b.') ? id : `b.${id}`;
}

// ------------------ Activar Docs (best-effort) ------------------

let DOCS_ACTIVATION_SUPPORTED;
let DESIGN_COLLABORATION_SUPPORTED;
let MODEL_COORDINATION_SUPPORTED;

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

// ------------------ Activar Design Collaboration (best-effort) ------------------

async function activateDesignCollaboration(projectAdminId) {
  const url = `/construction/admin/v1/projects/${encodeURIComponent(projectAdminId)}/activate?service=design_collaboration`;

  if (DESIGN_COLLABORATION_SUPPORTED === false) {
    log.debug('[activateDesignCollaboration] omitido (cache: no soportado en tenant)');
    return { ok: true, skipped: true, via: null };
  }

  try {
    await apsUser.apiPost(url, {});
    DESIGN_COLLABORATION_SUPPORTED = true;
    log.info('[activateDesignCollaboration] ok via', url);
    return { ok: true, via: url };
  } catch (e) {
    const s = e?.response?.status;
    if (s === 404) {
      DESIGN_COLLABORATION_SUPPORTED = false;
      log.info('[activateDesignCollaboration] no disponible en este tenant (404). No se volverá a intentar.');
      return { ok: true, skipped: true, via: url };
    }
    log.warn('[activateDesignCollaboration] continua (best-effort). Motivo:', s || e.message);
    return { ok: true, skipped: true, via: url, status: s };
  }
}


// ------------------ Activar Model Coordination (best-effort) ------------------

async function activateModelCoordination(projectAdminId) {
  const url = `/construction/admin/v1/projects/${encodeURIComponent(projectAdminId)}/activate?service=model_coordination`;

  if (MODEL_COORDINATION_SUPPORTED === false) {
    log.debug('[activateModelCoordination] omitido (cache: no soportado en tenant)');
    return { ok: true, skipped: true, via: null };
  }

  try {
    await apsUser.apiPost(url, {});
    MODEL_COORDINATION_SUPPORTED = true;
    log.info('[activateModelCoordination] ok via', url);
    return { ok: true, via: url };
  } catch (e) {
    const s = e?.response?.status;
    if (s === 404) {
      MODEL_COORDINATION_SUPPORTED = false;
      log.info('[activateModelCoordination] no disponible en este tenant (404). No se volverá a intentar.');
      return { ok: true, skipped: true, via: url };
    }
    log.warn('[activateModelCoordination] continua (best-effort). Motivo:', s || e.message);
    return { ok: true, skipped: true, via: url, status: s };
  }
}

// ------------------ Miembros de Hub (HQ API, 2LO) ------------------

/**
 * Lista usuarios de una cuenta ACC usando HQ API (2-legged).
 * Admite filtro 'q' → se mapea a 'search', y paginación limit/offset.
 * Si la ruta global no aplica, hace fallback a /regions/eu/...
 */
async function listAccountUsers({ accountId, q = "", limit = 25, offset = 0, region } = {}) {
  const accId = String(accountId || "").replace(/^b\./, "");
  if (!accId) throw new Error("listAccountUsers: accountId requerido");

  const clamp = (n, lo, hi) => Math.min(Math.max(parseInt(n ?? 0, 10), lo), hi);
  const params = {
    limit: clamp(limit, 1, 100),          // HQ: max 100
    offset: Math.max(parseInt(offset ?? 0, 10), 0),
  };
  if (q && q.trim()) params.search = q.trim();

  const base = region?.toLowerCase() === 'eu'
    ? `/hq/v1/regions/eu/accounts/${encodeURIComponent(accId)}`
    : `/hq/v1/accounts/${encodeURIComponent(accId)}`;

  const tryOnce = (root) => aps2LO.apiGet(`${root}/users`, { params, timeout: 10000 });

  try {
    return await tryOnce(base);
  } catch (e) {
    const st = e?.response?.status;
    if (!region && (st === 404 || st === 400)) {
      return await tryOnce(`/hq/v1/regions/eu/accounts/${encodeURIComponent(accId)}`);
    }
    throw e;
  }
}

/** Normaliza respuesta HQ para UI/autocomplete */
function normalizeAccountUsersResponse(raw) {
  const arr = Array.isArray(raw) ? raw : (raw?.results || raw?.items || []);
  const items = arr.map(u => ({
    id: u.id,
    name: u.name || `${u.first_name || ''} ${u.last_name || ''}`.trim(),
    email: u.email || "",
    status: u.status,                         // active|inactive|pending|...
    role: u.role,                             // account_admin|account_user|project_admin
    company: u.company_name || "",
  }));
  // HQ puro no devuelve total estándar; mantenemos 'next' por offset manual
  // Si ya usas limit/offset, calcula next:
  const next = (Array.isArray(arr) && arr.length === (raw?.limit || 0))
    ? (raw?.offset || 0) + arr.length
    : null;

  return { items, next: Number.isFinite(next) ? next : null };
}

// ------------------ Miembros de Proyecto ------------------

async function ensureProjectMember({
  accountId,
  projectId,
  email,
  makeProjectAdmin = true,
  grantDocs = 'admin',
  grantDesignCollab = null,  // null = heredar de grantDocs
  grantModelCoord = null     // null = heredar de grantDocs
}) {
  if (!projectId || !email) throw new Error('ensureProjectMember: projectId y email son obligatorios');

  // Normalizar nivel base de grantDocs
  const docsLvl = String(grantDocs || 'viewer').toLowerCase();
  
  // Si no se especifican grantDesignCollab/grantModelCoord, heredan de grantDocs
  // Esto evita mezclar 'member' con 'administrator' que la API de Autodesk rechaza
  const effectiveDesignCollab = grantDesignCollab !== null ? grantDesignCollab : grantDocs;
  const effectiveModelCoord = grantModelCoord !== null ? grantModelCoord : grantDocs;

  const products = [];

  // Project Administration - solo si es admin
  if (makeProjectAdmin) products.push({ key: 'projectAdministration', access: 'administrator' });

  // Helper para convertir nivel a access
  const toAccess = (lvl) => {
    const l = String(lvl || 'viewer').toLowerCase();
    if (l === 'admin') return 'administrator';
    if (l === 'member') return 'member';
    return 'viewer';
  };

  // Docs
  if (grantDocs) {
    products.push({ key: 'docs', access: toAccess(grantDocs) });
  }

  // Design Collaboration - usa el nivel efectivo (heredado o explícito)
  if (effectiveDesignCollab) {
    products.push({ key: 'designCollaboration', access: toAccess(effectiveDesignCollab) });
  }

  // Model Coordination - usa el nivel efectivo (heredado o explícito)
  if (effectiveModelCoord) {
    products.push({ key: 'modelCoordination', access: toAccess(effectiveModelCoord) });
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

      try { await activateDesignCollaboration(projectAdminId); } catch (e) {
        const st = e?.response?.status;
        if (st === 404) log.debug('[activateDesignCollaboration] endpoint no disponible en este tenant. Continuamos.');
        else log.debug('[activateDesignCollaboration] best-effort, continuar. Motivo:', st || e.message);
      }

      try { await activateModelCoordination(projectAdminId); } catch (e) {
        const st = e?.response?.status;
        if (st === 404) log.debug('[activateModelCoordination] endpoint no disponible en este tenant. Continuamos.');
        else log.debug('[activateModelCoordination] best-effort, continuar. Motivo:', st || e.message);
      }

      // Esperar aprovisionamiento en DM

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

// ------------------ Renombrar proyecto (Archive) ------------------

/**
 * Renombra un proyecto ACC/BIM360 usando HQ Admin API (2-legged OAuth).
 * PATCH https://developer.api.autodesk.com/hq/v1/accounts/:account_id/projects/:project_id
 * Docs: https://aps.autodesk.com/en/docs/bim360/v1/reference/http/projects-:project_id-PATCH/
 *
 * IMPORTANTE:
 * - Requiere 2LO (client_credentials) con scope account:write
 * - Usa /hq/v1/accounts/... (NO /construction/admin/...)
 * - Si la cuenta está en EU, hace fallback a /hq/v1/regions/eu/...
 */
async function renameProject({ hubId, projectId, newName }) {
  if (!hubId || !projectId || !newName) {
    throw new Error('renameProject: hubId, projectId y newName son obligatorios');
  }

  // Normalizar IDs (sin prefijo "b.")
  const projectIdNorm = String(projectId).replace(/^b\./, '');
  const accountIdNorm = String(hubId).replace(/^b\./, '');

  // Obtener nombre actual del proyecto desde Construction Admin (3LO)
  let previousName = null;
  try {
    const projectData = await apsUser.apiGet(`/construction/admin/v1/projects/${encodeURIComponent(projectIdNorm)}`);
    previousName = projectData?.name || null;
  } catch (e) {
    log.warn('[renameProject] No se pudo obtener nombre actual del proyecto:', e.message);
  }

  // Payload plano para HQ API
  const payload = { name: newName };

  // Intentar primero con ruta US, luego fallback EU
  const usUrl = `/hq/v1/accounts/${encodeURIComponent(accountIdNorm)}/projects/${encodeURIComponent(projectIdNorm)}`;
  const euUrl = `/hq/v1/regions/eu/accounts/${encodeURIComponent(accountIdNorm)}/projects/${encodeURIComponent(projectIdNorm)}`;

  const tryPatch = async (url) => {
    log.debug('[renameProject] PATCH (2LO):', url);
    return await aps2LO.apiPatch(url, payload);
  };

  try {
    const result = await tryPatch(usUrl);
    log.info('[renameProject] Proyecto renombrado (US):', { projectId: projectIdNorm, previousName, newName });
    return {
      ok: true,
      projectId: projectIdNorm,
      hubId: `b.${accountIdNorm}`,
      previousName,
      newName,
      renamedAt: new Date().toISOString()
    };
  } catch (usError) {
    const usStatus = usError?.response?.status;
    // Si es 404 o 400 puede ser que la cuenta esté en EU
    if (usStatus === 404 || usStatus === 400) {
      log.warn('[renameProject] US falló con', usStatus, '→ intentando EU');
      try {
        const result = await tryPatch(euUrl);
        log.info('[renameProject] Proyecto renombrado (EU):', { projectId: projectIdNorm, previousName, newName });
        return {
          ok: true,
          projectId: projectIdNorm,
          hubId: `b.${accountIdNorm}`,
          previousName,
          newName,
          renamedAt: new Date().toISOString()
        };
      } catch (euError) {
        const euStatus = euError?.response?.status;
        const euData = euError?.response?.data;
        log.error('[renameProject] Ambas regiones fallaron:', {
          usStatus,
          euStatus,
          euData: JSON.stringify(euData)
        });
        const detail = euData?.developerMessage || euData?.message || euError?.message || 'rename_failed';
        const err = new Error(detail);
        err.status = euStatus || 500;
        err.code = 'RENAME_FAILED';
        throw err;
      }
    }

    // Otro error (403, 409, 500, etc.) -> no reintentar con EU
    const usData = usError?.response?.data;
    log.error('[renameProject] Error:', { usStatus, usData: JSON.stringify(usData) });
    const detail = usData?.developerMessage || usData?.message || usError?.message || 'rename_failed';
    const err = new Error(detail);
    err.status = usStatus || 500;
    err.code = 'RENAME_FAILED';
    throw err;
  }
}

// ------------------ Listar usuarios del proyecto ------------------

/**
 * Obtiene todos los usuarios de un proyecto ACC.
 * GET /construction/admin/v1/projects/:projectId/users
 */
async function getProjectUsers(projectId, { limit = 100, offset = 0 } = {}) {
  if (!projectId) throw new Error('getProjectUsers: projectId es obligatorio');

  const projectIdNorm = String(projectId).replace(/^b\./, '');
  const url = `/construction/admin/v1/projects/${encodeURIComponent(projectIdNorm)}/users`;
  
  const allUsers = [];
  let currentOffset = offset;
  let hasMore = true;

  while (hasMore) {
    try {
      const result = await apsUser.apiGet(url, {
        params: { limit, offset: currentOffset },
        timeout: 15000
      });

      const users = result?.results || result || [];
      if (Array.isArray(users) && users.length > 0) {
        allUsers.push(...users);
        currentOffset += users.length;
        hasMore = users.length === limit;
      } else {
        hasMore = false;
      }
    } catch (e) {
      log.error('[getProjectUsers] Error:', e.message);
      throw e;
    }
  }

  log.info('[getProjectUsers] Total usuarios obtenidos:', allUsers.length);
  return allUsers;
}

// ------------------ Actualizar acceso de usuario ------------------

/**
 * Actualiza el acceso a productos de un usuario en un proyecto ACC.
 * PATCH /construction/admin/v1/projects/:projectId/users/:userId
 *
 * NOTA: PATCH cambia productos pero NO puede cambiar el rol de proyecto
 * (Project Admin → Member). Para eso se necesita DELETE + POST.
 */
async function updateProjectUserAccess(projectId, userId, { products }) {
  if (!projectId || !userId) {
    throw new Error('updateProjectUserAccess: projectId y userId son obligatorios');
  }

  const projectIdNorm = String(projectId).replace(/^b\./, '');
  const url = `/construction/admin/v1/projects/${encodeURIComponent(projectIdNorm)}/users/${encodeURIComponent(userId)}`;

  const payload = { products };

  try {
    const result = await apsUser.apiPatch(url, payload);
    log.info('[updateProjectUserAccess] Respuesta API:', JSON.stringify(result));
    log.debug('[updateProjectUserAccess] Usuario actualizado:', { userId, products });
    return { ok: true, userId, products, result };
  } catch (e) {
    const status = e?.response?.status;
    const detail = e?.response?.data?.errors?.[0]?.detail || e?.response?.data?.message || e?.message || 'update_failed';
    log.warn('[updateProjectUserAccess] Error:', { userId, status, detail, body: JSON.stringify(e?.response?.data) });
    return { ok: false, userId, error: detail, status };
  }
}

// ------------------ Eliminar y re-añadir usuario (cambia ROL) ------------------

/**
 * Elimina un usuario del proyecto y lo re-añade con los productos deseados.
 * Esto es NECESARIO porque:
 *   - PATCH /users/:id → cambia productos pero NO el rol (Project Admin → Member)
 *   - POST /users → devuelve 409 si el usuario ya existe
 * La única forma de cambiar el rol es DELETE + POST.
 *
 * Pasos:
 *   1. DELETE /construction/admin/v1/projects/:projectId/users/:userId
 *   2. POST   /construction/admin/v1/projects/:projectId/users  { email, products }
 *
 * Si el DELETE falla, se hace fallback a PATCH (al menos los productos se actualizan).
 * Si el POST falla tras un DELETE exitoso, se intenta re-añadir con productos originales.
 */
async function removeAndReaddUser(projectId, userId, email, newProducts, originalProducts) {
  if (!projectId || !userId || !email) {
    throw new Error('removeAndReaddUser: projectId, userId y email son obligatorios');
  }

  const projectIdNorm = String(projectId).replace(/^b\./, '');
  const deleteUrl = `/construction/admin/v1/projects/${encodeURIComponent(projectIdNorm)}/users/${encodeURIComponent(userId)}`;
  const postUrl = `/construction/admin/v1/projects/${encodeURIComponent(projectIdNorm)}/users`;

  // Solo productos con acceso real
  const activeProducts = newProducts.filter(p => p.access && p.access !== 'none');

  // Paso 1: DELETE
  log.info('[removeAndReaddUser] Paso 1: DELETE', deleteUrl);
  try {
    await apsUser.apiDelete(deleteUrl);
    log.info('[removeAndReaddUser] Usuario eliminado del proyecto:', email);
  } catch (delErr) {
    const delStatus = delErr?.response?.status;
    const delDetail = delErr?.response?.data?.detail || delErr?.message;
    log.warn('[removeAndReaddUser] DELETE falló:', { status: delStatus, detail: delDetail });

    // Fallback: usar PATCH (al menos actualiza productos aunque no el rol)
    log.info('[removeAndReaddUser] Fallback → PATCH para actualizar productos');
    try {
      const patchResult = await apsUser.apiPatch(
        `/construction/admin/v1/projects/${encodeURIComponent(projectIdNorm)}/users/${encodeURIComponent(userId)}`,
        { products: activeProducts }
      );
      log.info('[removeAndReaddUser] PATCH fallback OK:', JSON.stringify(patchResult));
      return { ok: true, via: 'patch-fallback', result: patchResult, roleChanged: false };
    } catch (patchErr) {
      const patchDetail = patchErr?.response?.data?.detail || patchErr?.message;
      log.error('[removeAndReaddUser] PATCH fallback también falló:', patchDetail);
      return { ok: false, error: `DELETE: ${delDetail}; PATCH: ${patchDetail}`, status: delStatus };
    }
  }

  // Paso 2: POST (re-añadir como Member sin projectAdministration)
  const payload = { email, products: activeProducts };
  log.info('[removeAndReaddUser] Paso 2: POST', postUrl, '→', JSON.stringify(payload));
  try {
    const result = await apsUser.apiPost(postUrl, payload);
    log.info('[removeAndReaddUser] Usuario re-añadido como Member:', JSON.stringify(result));
    return { ok: true, via: 'delete-and-readd', result, roleChanged: true };
  } catch (postErr) {
    const postStatus = postErr?.response?.status;
    const postData = postErr?.response?.data;
    const postDetail = postData?.detail || postData?.message || postErr?.message;
    log.error('[removeAndReaddUser] POST re-add falló:', { status: postStatus, detail: postDetail });

    // Intento de emergencia: re-añadir con productos originales para no dejar al usuario sin acceso
    log.warn('[removeAndReaddUser] Intento de emergencia: re-añadir con productos originales');
    try {
      const origProds = (originalProducts || []).filter(p => p.access && p.access !== 'none');
      await apsUser.apiPost(postUrl, { email, products: origProds.length > 0 ? origProds : activeProducts });
      log.info('[removeAndReaddUser] Re-añadido con productos originales (rol NO cambiado)');
      return { ok: false, error: `Re-add falló: ${postDetail}. Usuario restaurado con productos originales.`, via: 'emergency-restore', roleChanged: false };
    } catch (emergErr) {
      log.error('[removeAndReaddUser] ⚠️ EMERGENCIA: usuario', email, 'eliminado pero no se pudo re-añadir:', emergErr?.message);
      return { ok: false, error: `Usuario eliminado pero no re-añadido: ${postDetail}`, status: postStatus, critical: true };
    }
  }
}

// ------------------ Archivar proyecto (Renombrar + Restringir permisos) ------------------

/**
 * Archiva un proyecto ACC:
 * 1. Renombra el proyecto con un prefijo (ej: "Closed_")
 * 2. Obtiene la lista de usuarios del proyecto (una sola vez)
 * 3. Restringe los permisos de productos (quita designCollaboration, modelCoordination, etc.)
 * 4. Degrada administradores de proyecto a miembros (excepto protectedAdminEmails)
 *
 * IMPORTANTE: Para la degradación de admins se usa DELETE + POST (eliminar y
 * re-añadir) porque PATCH solo cambia productos pero NO el rol de proyecto,
 * y POST /users devuelve 409 si el usuario ya existe.
 */
async function archiveProject({
  hubId,
  projectId,
  options = {}
}) {
  // Emails de Project Managers que NUNCA deben ser degradados
  const DEFAULT_PROTECTED_EMAILS = [
    'support@labit.es',
    'lsierra@labit.es',
    'jrsevilla@labit.es',
    'jlago@labit.es',
  ];

  const {
    renamePrefix = 'Closed_',
    restrictToDocsOnly = true,
    removeFromProducts = ['designCollaboration', 'modelCoordination', 'projectManagement', 'costManagement', 'fieldManagement'],
    demoteAdmins = true,
    protectedAdminEmails = DEFAULT_PROTECTED_EMAILS
  } = options;

  if (!hubId || !projectId) {
    throw new Error('archiveProject: hubId y projectId son obligatorios');
  }

  // Normalizar emails protegidos a lowercase para comparacion segura
  const protectedEmails = (protectedAdminEmails || []).map(e => String(e).toLowerCase().trim());

  const result = {
    success: true,
    archived: null,
    permissions: null,
    adminDemotion: null,
    errors: []
  };

  // 1. Obtener nombre actual y renombrar
  const hubIdNorm = ensureB(hubId);
  const projectIdClean = String(projectId).replace(/^b\./, '');

  let previousName = null;
  let newName = null;

  try {
    const projectUrl = `/construction/admin/v1/projects/${encodeURIComponent(projectIdClean)}`;
    const projectData = await apsUser.apiGet(projectUrl);
    previousName = projectData?.name || 'Unknown';

    if (!previousName.startsWith(renamePrefix)) {
      newName = `${renamePrefix}${previousName}`;
      const renameResult = await renameProject({ hubId: hubIdNorm, projectId: projectIdClean, newName });
      result.archived = {
        projectId: projectIdClean,
        newName,
        previousName,
        renamedAt: renameResult.renamedAt
      };
    } else {
      newName = previousName;
      result.archived = {
        projectId: projectIdClean,
        newName: previousName,
        previousName,
        renamedAt: null,
        skipped: true,
        reason: 'Project already has archive prefix'
      };
    }
  } catch (e) {
    result.success = false;
    result.errors.push({ phase: 'rename', error: e.message, code: e.code || 'RENAME_FAILED' });
    log.error('[archiveProject] Error en renombrado:', e.message);
  }

  // 2. Obtener usuarios una sola vez para ambas fases (permisos + degradación)
  let users = [];
  try {
    users = await getProjectUsers(projectIdClean);
  } catch (e) {
    result.success = false;
    result.errors.push({ phase: 'fetch_users', error: e.message, code: 'FETCH_USERS_FAILED' });
    log.error('[archiveProject] Error obteniendo usuarios:', e.message);
  }

  // 3. Restringir productos + degradar admins en UNA SOLA pasada por usuario
  if (users.length > 0 && (restrictToDocsOnly || demoteAdmins)) {
    try {
      const permissionResult = {
        totalMembers: users.length,
        membersModified: 0,
        membersSkipped: 0,
        details: []
      };

      const demotionResult = {
        totalAdmins: 0,
        adminsDemoted: 0,
        adminsProtected: 0,
        adminsFailed: 0,
        details: []
      };

      for (const user of users) {
        const userId = user.id;
        const email = (user.email || '').toLowerCase().trim();
        const name = user.name || `${user.firstName || ''} ${user.lastName || ''}`.trim();
        const currentProducts = user.products || [];

        // --- Determinar si es admin y si está protegido ---
        const adminViaProducts = currentProducts.some(
          p => (p.key || p) === 'projectAdministration' && (p.access === 'administrator')
        );
        const adminViaAccessLevels = user.accessLevels?.projectAdmin === true;
        const isAdmin = adminViaProducts || adminViaAccessLevels;
        const isProtected = protectedEmails.includes(email);
        const shouldDemote = demoteAdmins && isAdmin && !isProtected;

        log.debug('[archiveProject] Usuario:', email,
          '| isAdmin:', isAdmin,
          '(viaProducts:', adminViaProducts, ', viaAccessLevels:', adminViaAccessLevels, ')',
          '| shouldDemote:', shouldDemote);

        if (isAdmin) demotionResult.totalAdmins++;

        // --- Construir array final de productos ---
        const productsToRemove = [];
        const productsToKeep = [];
        const newProducts = [];

        for (const prod of currentProducts) {
          const prodKey = prod.key || prod;

          if (prodKey === 'projectAdministration') {
            if (shouldDemote) {
              productsToRemove.push(prodKey);
              // OMITIR de newProducts → al re-añadir sin este producto, queda como Member
            } else {
              productsToKeep.push(prodKey);
              newProducts.push({ key: prodKey, access: prod.access || 'administrator' });
            }
          } else if (restrictToDocsOnly && removeFromProducts.includes(prodKey)) {
            productsToRemove.push(prodKey);
            // OMITIR de newProducts → el PATCH full-replace los elimina
          } else {
            productsToKeep.push(prodKey);
            newProducts.push({ key: prodKey, access: prod.access || 'member' });
          }
        }

        // Admin detectado via accessLevels pero no en products
        if (shouldDemote && !productsToRemove.includes('projectAdministration')) {
          productsToRemove.push('projectAdministration');
        }

        // --- Registrar admin protegido ---
        if (isAdmin && isProtected) {
          demotionResult.adminsProtected++;
          demotionResult.details.push({
            userId, email, name,
            status: 'protected',
            reason: 'Project Manager protegido'
          });
          log.debug('[archiveProject] Admin protegido, no se degrada:', email);
        }

        // --- Aplicar cambios ---
        const activeProducts = newProducts.filter(p => p.access && p.access !== 'none');
        log.info('[archiveProject]', shouldDemote ? 'DELETE+POST (demotar)' : 'PATCH', 'para', email,
          '→ activeProducts:', JSON.stringify(activeProducts));

        if (productsToRemove.length > 0) {
          let updateResult;

          if (shouldDemote) {
            // DELETE + POST: única forma de cambiar el rol de proyecto
            updateResult = await removeAndReaddUser(
              projectIdClean, userId, email,
              activeProducts,
              currentProducts
            );
          } else {
            // PATCH: funciona bien para cambios de productos sin democión
            updateResult = await updateProjectUserAccess(projectIdClean, userId, {
              products: activeProducts
            });
          }

          permissionResult.details.push({
            userId, email, name,
            status: updateResult.ok ? 'modified' : 'failed',
            productsRemoved: productsToRemove,
            productsKept: productsToKeep,
            error: updateResult.error || null
          });

          if (updateResult.ok) {
            permissionResult.membersModified++;
          } else {
            permissionResult.membersSkipped++;
          }

          // Registro de degradación
          if (shouldDemote) {
            if (updateResult.ok) {
              demotionResult.adminsDemoted++;
              demotionResult.details.push({
                userId, email, name,
                status: 'demoted',
                previousRole: 'project_admin',
                newRole: 'project_member'
              });
              log.info('[archiveProject] Admin degradado a miembro:', email);
            } else {
              demotionResult.adminsFailed++;
              demotionResult.details.push({
                userId, email, name,
                status: 'failed',
                error: updateResult.error
              });
              log.warn('[archiveProject] Fallo al degradar admin:', email, updateResult.error);
            }
          }
        } else {
          permissionResult.membersSkipped++;
          permissionResult.details.push({
            userId, email, name,
            status: 'skipped',
            productsRemoved: [],
            productsKept: productsToKeep,
            reason: 'No changes needed'
          });
        }
      }

      result.permissions = permissionResult;
      result.adminDemotion = demotionResult;

      log.info('[archiveProject] Permisos y degradación completados:', {
        membersModified: permissionResult.membersModified,
        membersSkipped: permissionResult.membersSkipped,
        totalAdmins: demotionResult.totalAdmins,
        demoted: demotionResult.adminsDemoted,
        protected: demotionResult.adminsProtected,
        failed: demotionResult.adminsFailed
      });

    } catch (e) {
      result.success = false;
      result.errors.push({
        phase: 'permissions_and_demotion',
        error: e.message,
        code: 'PERMISSIONS_DEMOTION_FAILED'
      });
      log.error('[archiveProject] Error en permisos/degradación:', e.message);
    }
  }

  return result;
}

module.exports = {
  createProject,
  applyTemplateToProject,
  activateDocs,
  ensureProjectMember,
  listAccountUsers,
  normalizeAccountUsersResponse,
  renameProject,
  getProjectUsers,
  updateProjectUserAccess,
  removeAndReaddUser,
  archiveProject
};
