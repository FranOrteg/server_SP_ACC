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
        console.log('[ACC][activateDocs] endpoint no disponible en este tenant (404). Continuamos.');
      } else {
        console.log('[ACC][activateDocs] best-effort, continuar. Motivo:', s || e.message);
      }
    }

  }
  LOG('[activateDocs] endpoint no disponible en este tenant (solo 404). Continuamos sin bloquear.');
  return { ok: true, skipped: true, tried };
}

// ------------------ Miembros de Proyecto ------------------

/**
 * Invita/asegura un miembro en el proyecto (ACC Admin v1).
 * Requisitos:
 *  - El email debe existir en la cuenta (Account Admin / Account Member).
 *  - El endpoint válido en tu tenant es v1 projects/{id}/users con products[] {key, access}.
 */
async function ensureProjectMember({
  accountId,
  projectId,
  email,
  makeProjectAdmin = true,      // añade projectAdministration:administrator
  grantDocs = 'admin'           // 'admin' | 'member' | false
}) {
  if (!projectId || !email) throw new Error('ensureProjectMember: projectId y email son obligatorios');

  const products = [];
  if (makeProjectAdmin) {
    products.push({ key: 'projectAdministration', access: 'administrator' });
  }
  if (grantDocs) {
    products.push({
      key: 'docs',
      access: grantDocs === 'admin' ? 'administrator' : 'member'
    });
  }

  // 🚩 Este es el endpoint que acepta tu tenant:
  const url = `/construction/admin/v1/projects/${encodeURIComponent(projectId)}/users`;
  try {
    const resp = await apsUser.apiPost(url, { email, products }); // <-- forma correcta
    // Opcional: esperar a que quede "active"
    await waitForProjectUserActive(projectId, email, { maxTries: 10, delayMs: 2000 });

    return {
      ok: true,
      email,
      via: url
    };
  } catch (e) {
    const st = e?.response?.status;
    const data = e?.response?.data;
    console.warn('[ACC][ensureProjectMember] fallo', st, 'via', url, '->', data || e.message);
    return {
      ok: false,
      email,
      skipped: true,
      status: st,
      error: data || e.message
    };
  }
}

/**
 * Espera hasta que el usuario aparezca con status "active" en el proyecto.
 */
async function waitForProjectUserActive(projectId, email, { maxTries = 8, delayMs = 1500 } = {}) {
  for (let i = 0; i < maxTries; i++) {
    try {
      const list = await apsUser.apiGet(`/construction/admin/v1/projects/${encodeURIComponent(projectId)}/users?limit=1000&offset=0`);
      const hit = (list?.results || []).find(u => (u.email || '').toLowerCase() === email.toLowerCase());
      if (hit && hit.status === 'active') return true;
    } catch (e) {
      // no romper por errores puntuales de listado
    }
    await new Promise(r => setTimeout(r, delayMs));
  }
  return false;
}



// ------------------ Creación de proyecto ------------------

/**
 * Crea proyecto en Construction Admin API (3LO).
 * - Resuelve accountId desde hubId ("b.{accountGuid}") si hace falta.
 * - Maneja conflicto de nombre con políticas de reintento.
 * - (Best-effort) intenta activar Docs. Si el endpoint no existe en el tenant, continúa.
 * - Espera aprovisionamiento en Data Management.
 */
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
  onNameConflict = 'suffix-timestamp' // 'fail' | 'suffix-timestamp'
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

  // helper para generar nombres únicos
  const ts6 = () => Date.now().toString().slice(-6);
  const rnd6 = () => Math.random().toString().slice(2, 8);
  const makeRetryName = (base) => {
    if (onNameConflict === 'suffix-timestamp') return `${base}-${ts6()}`;
    // fallback siempre único
    return `${base}-${ts6()}-${rnd6()}`;
  };

  // intentos: 1 (nombre original) + 2 reintentos con sufijos únicos
  const maxAttempts = (onNameConflict === 'fail') ? 1 : 3;
  let attempt = 0;
  let lastErr;

  while (attempt < maxAttempts) {
    const attemptName = attempt === 0 ? payloadBase.name : makeRetryName(name);
    const payload = { ...payloadBase, name: attemptName };

    try {
      const created = await apsUser.apiPost(
        `/construction/admin/v1/accounts/${encodeURIComponent(accId)}/projects`,
        payload
      );

      // Resolver Admin projectId (202/Location o body.id)
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

      // (Best-effort) Activar Docs: si el endpoint no existe en el tenant (404), no bloquea
      try {
        await activateDocs(projectAdminId);
      } catch (e) {
        const st = e?.response?.status;
        if (st === 404) {
          console.log('[ACC][activateDocs] endpoint no disponible en este tenant. Continuamos.');
        } else {
          // otros errores: también continuamos (best-effort)
          console.log('[ACC][activateDocs] best-effort, continuar. Motivo:', st || e.message);
        }
      }

      // Esperar aprovisionamiento en Data Management
      const hubIdDM = ensureB(accId);
      const projectIdDM = ensureB(projectAdminId);
      await dm.waitUntilDmProjectExists(hubIdDM, projectIdDM);

      // Metadatos DM (hub + región/topFolders, si se puede)
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
        projectId: projectAdminId, // Admin GUID sin 'b.'
        name: payload.name,
        dm: dmMeta
      };
    } catch (err) {
      const status = err?.response?.status;
      const detail = err?.response?.data?.errors?.[0]?.detail || '';
      if (status === 409 && attempt < maxAttempts - 1 && onNameConflict !== 'fail') {
        attempt++;
        console.warn('[ACC] 409 nombre duplicado. Reintentando con sufijo único… detalle:', detail);
        continue;
      }
      lastErr = err;
      break;
    }
  }

  // si llegamos aquí, no pudimos crear
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
