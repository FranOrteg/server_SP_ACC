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

const LOG = (...a) => console.log('[ACC]', ...a);
const WARN = (...a) => console.warn('[ACC]', ...a);

// ------------------ Utils ------------------

function ensureB(id) {
  if (!id) return id;
  return String(id).startsWith('b.') ? id : `b.${id}`;
}

// ------------------ Activar Docs (best-effort) ------------------

async function activateDocs(projectAdminId) {
  // En varios tenants este endpoint no está expuesto → devolver sin bloquear si todo da 404
  const tried = [];
  const candidates = [
    `/construction/admin/v1/projects/${encodeURIComponent(projectAdminId)}/activate?service=doc_mgmt`,
    `/construction/admin/v1/projects/${encodeURIComponent(projectAdminId)}/activate?service=document_management`,
    `/construction/admin/v1/projects/${encodeURIComponent(projectAdminId)}/activate?service=docs`,
    `/construction/admin/v1/projects/${encodeURIComponent(projectAdminId)}:activate?service=doc_mgmt`,
    `/construction/admin/v1/projects/${encodeURIComponent(projectAdminId)}:activate?service=document_management`,
    `/construction/admin/v1/projects/${encodeURIComponent(projectAdminId)}:activate?service=docs`,
    `/construction/admin/v1/projects/${encodeURIComponent(projectAdminId)}/actions:activate?service=doc_mgmt`,
    `/construction/admin/v1/projects/${encodeURIComponent(projectAdminId)}/actions:activate?service=document_management`,
    `/construction/admin/v1/projects/${encodeURIComponent(projectAdminId)}/actions:activate?service=docs`
  ];

  for (const url of candidates) {
    try {
      await apsUser.apiPost(url, {}); // 200/202/204 esperado si existe
      LOG('[activateDocs] OK via', url);
      return { ok: true, via: url };
    } catch (e) {
      const s = e?.response?.status;
      if (s === 404) {
        LOG('[activateDocs] 404 (no disponible en este tenant). Alias:', url.split('=')[1]);
        tried.push(url);
        continue;
      }
      // Otros códigos, registramos y seguimos probando
      WARN('[activateDocs] fallo', s, '->', e?.response?.data || e?.message);
      tried.push(url);
    }
  }
  LOG('[activateDocs] endpoint no disponible en este tenant (solo 404). Continuamos sin bloquear.');
  return { ok: true, skipped: true, tried };
}

// ------------------ Miembros de Proyecto ------------------

/**
 * Invita o asegura un miembro al proyecto para que aparezca en Docs de inmediato.
 * Según el tenant, el endpoint difiere; probamos varias variantes como best-effort.
 * Retorna { ok, email, added|already }.
 */
async function ensureProjectMember({
  accountId,
  projectId,     // Admin GUID “pelado”
  email,
  makeProjectAdmin = true,
  grantDocs = 'admin' // 'admin' | 'standard' | 'view'
}) {
  if (!email) throw new Error('ensureProjectMember: email es obligatorio');

  const rid = (s) => s?.replace(/^b\./, '');
  const accId = rid(accountId);
  const pid   = rid(projectId);

  // Candidatos (distintos tenants) + payloads alternativos
  const urls = [
    `/construction/admin/v1/projects/${pid}/users:bulk-invite`,
    `/construction/admin/v1/projects/${pid}/users:invite`,
    `/construction/admin/v1/projects/${pid}/users`,
    `/construction/admin/v1/accounts/${accId}/projects/${pid}/users:bulk-invite`
  ];

  const payloads = [
    // Variante 1: bulk-invite
    {
      users: [{
        email,
        // algunas orgs aceptan flags directos
        projectAdmin: !!makeProjectAdmin,
        products: { docs: grantDocs } // admin|standard|view
      }]
    },
    // Variante 2: invite simple
    {
      email,
      projectAdmin: !!makeProjectAdmin,
      products: { docs: grantDocs }
    },
    // Variante 3: estructura alternativa
    {
      users: [{
        email,
        roles: makeProjectAdmin ? ['project_admin'] : ['project_member'],
        access: { docs: grantDocs }
      }]
    }
  ];

  // Intentamos todas las combinaciones hasta que una no devuelva 4xx “not found”
  for (const url of urls) {
    for (const body of payloads) {
      try {
        const r = await apsUser.apiPost(url, body);
        LOG('[ensureProjectMember] OK', email, 'via', url);
        return { ok: true, email, via: url, result: r };
      } catch (e) {
        const st = e?.response?.status;
        const data = e?.response?.data;
        // 409 o 207 (multi-status) suelen implicar "ya estaba"
        if (st === 409 || String(data).toLowerCase().includes('already')) {
          LOG('[ensureProjectMember] ya estaba', email, 'via', url);
          return { ok: true, email, already: true, via: url };
        }
        // 4xx distintos a 404: seguimos probando otra payload; 404: probamos otro URL
        if (st && st !== 404) {
          WARN('[ensureProjectMember] fallo', st, 'via', url, '->', data || e.message);
          continue;
        }
        if (st === 404) {
          LOG('[ensureProjectMember] 404 en', url, 'probando siguiente variante…');
          break; // cambia de url
        }
        // otros (timeout, 5xx) -> seguimos intentando
        WARN('[ensureProjectMember] error transitorio via', url, '->', data || e.message);
      }
    }
  }
  // Si todas fallan, devolvemos no-bloqueante
  WARN('[ensureProjectMember] no se pudo invitar por API en este tenant. Continúo.');
  return { ok: true, email, skipped: true };
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

  const payload = {
    name,
    classification,
    startDate: startDate || new Date().toISOString().slice(0, 10),
    endDate: endDate || null,
    jobNumber: code || vars.code || undefined,
    type
  };

  // 1) Crear en Admin API con manejo 409 -> renombrar con sufijo
  let created;
  try {
    created = await apsUser.apiPost(
      `/construction/admin/v1/accounts/${encodeURIComponent(accId)}/projects`,
      payload
    );
  } catch (err) {
    const status = err?.response?.status;
    if (status === 409 && onNameConflict !== 'fail') {
      const ts = (vars?.code || '').toString().padStart(3, '0') || Date.now().toString().slice(-6);
      const retryName = `${name}-${ts}`;
      WARN('409 nombre duplicado. Reintentando con:', retryName);
      const retryPayload = { ...payload, name: retryName };
      created = await apsUser.apiPost(
        `/construction/admin/v1/accounts/${encodeURIComponent(accId)}/projects`,
        retryPayload
      );
    } else {
      throw err;
    }
  }

  // Normalizamos el id (GET si hace falta)
  let pid =
    created?.id ||
    created?.data?.id ||
    created?.projectId ||
    (created?.links?.self && created.links.self.split('/').pop());
  if (!pid && created?.links?.self) {
    const info = await apsUser.apiGet(created.links.self);
    pid = info?.id || null;
  }
  if (!pid) throw new Error('No se pudo resolver el projectId de Admin tras la creación');

  // 2) Activar Docs (best-effort)
  await activateDocs(pid);

  // 3) Esperar a que exista en Data Management
  const hubIdDM = ensureB(accId);
  const projectIdDM = ensureB(pid);
  await dm.waitUntilDmProjectExists(hubIdDM, projectIdDM);

  // 4) Metadata DM útil
  let dmMeta = {};
  try {
    const tf = await dm.getTopFoldersByProjectId(projectIdDM);
    dmMeta = { hubIdDM: tf.hubId, projectIdDM, hubRegion: tf.hubRegion };
  } catch {
    dmMeta = { hubIdDM, projectIdDM };
  }

  return {
    ok: true,
    accountId: accId,
    projectId: pid, // Admin GUID
    name: created?.name || payload.name,
    dm: dmMeta
  };
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

  // Garantiza que el proyecto está visible en DM
  let hubIdDM = ensureB(accountId || '');
  try {
    const tf = await dm.getTopFoldersByProjectId(pidDM);
    hubIdDM = tf.hubId || hubIdDM;
  } catch (e) {
    try {
      await dm.waitUntilDmProjectExists(hubIdDM, pidDM, { timeoutMs: 60_000 });
      await dm.getTopFoldersByProjectId(pidDM);
    } catch (e2) {
      throw e;
    }
  }

  // Expandir carpetas
  const expandVars = { name: resolvedName, ...(vars || {}) };
  const folders = templates.expandFolders(template, expandVars);

  // Crear bajo "/Project Files"
  const pfId = await dm.getProjectFilesFolderId(pidDM);
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
