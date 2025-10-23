// controllers/bridge.controller.js

const transfer = require('../services/transfer.service');
const sp = require('../services/sharepoint.service');
const acc = require('../services/acc.service');
const accAdmin = require('../services/admin.acc.service');
const spAdmin = require('../services/admin.sp.service');
const apsUser = require('../clients/apsUserClient');

async function spToAcc(req, res, next) {
  try {
    const src = { ...req.query, ...(req.body || {}) };
    const { driveId, itemId, projectId, folderId, fileName, destPath, onConflict = 'version' } = src;

    if (!driveId || !itemId || !projectId || (!folderId && !destPath)) {
      return res.status(400).json({ error: 'driveId, itemId, projectId y (folderId o destPath) son obligatorios' });
    }

    // Validar que el item es un fichero
    const meta = await sp.getItemMeta(driveId, itemId);
    if (!meta?.file) {
      return res.status(400).json({ error: 'itemId no es un fichero (o no existe en el drive indicado)' });
    }

    // Resolver carpeta destino por ruta si viene destPath
    let destFolderId = folderId;
    if (!destFolderId && destPath) {
      destFolderId = await acc.ensureFolderByPath(projectId, destPath);
    }

    const result = await transfer.copySharePointItemToAcc({
      driveId,
      itemId,
      projectId,
      folderId: destFolderId,
      fileName,
      onConflict // version | skip | rename
    });
    res.json(result);
  } catch (e) { next(e); }
}

async function spTreeToAcc(req, res, next) {
  try {
    const src = { ...req.query, ...(req.body || {}) };
    const { driveId, itemId, projectId, folderId, destPath, mode = 'upsert' } = src;
    const dryRun = String(src.dryRun || '').toLowerCase() === 'true';

    if (!driveId || !itemId || !projectId || (!folderId && !destPath)) {
      return res.status(400).json({ error: 'driveId, itemId, projectId y (folderId o destPath) son obligatorios' });
    }

    // Resolver carpeta objetivo
    let targetFolderId = folderId;
    if (!targetFolderId && destPath) {
      targetFolderId = await acc.ensureFolderByPath(projectId, destPath);
    }

    const log = [];
    const result = await transfer.copySpTreeToAcc({
      driveId,
      itemId,
      projectId,
      targetFolderId,
      mode,   // upsert | skip | rename
      dryRun,
      onLog: (m) => log.push(m)
    });

    res.json({ ...result, log });
  } catch (e) { next(e); }
}

async function spToNewAccProject(req, res, next) {
  try {
    const {
      driveId,
      itemId,
      hubId,
      accountId,
      cloneMembersFromProjectId,
      onConflict = 'version',   // no lo usamos aquí, pero lo dejamos por si lo añades a transfer
      mode = 'upsert',
    } = { ...req.query, ...(req.body || {}) };

    // 1) Validaciones
    if (!driveId || !itemId || !(hubId || accountId)) {
      return res.status(400).json({
        error: 'driveId, itemId y hubId|accountId son obligatorios',
      });
    }

    // 2) Nombre del sitio SP → nombre del proyecto ACC
    const siteName = await sp.getSiteNameForItem(driveId, itemId);
    if (!siteName) {
      return res.status(400).json({
        error: 'No se pudo resolver el nombre del sitio de SharePoint',
      });
    }
    // Nombre del proyecto ACC
    const projectName = `${siteName} SP`;

    // 3) Crear proyecto ACC (sin plantilla) – esto ya espera aprovisionamiento DM
    const created = await accAdmin.createProject({
      hubId,
      accountId,
      name: projectName,
      // Si quieres forzar reintentos por nombre duplicado:
      onNameConflict: 'suffix-timestamp',
    });

    // IMPORTANTE:
    // - created.projectId       -> ID de Admin (sin 'b.')
    // - created.dm.projectIdDM  -> ID de DM (con 'b.'), el que hay que usar con Data Management
    const projectIdDM = created?.dm?.projectIdDM || `b.${created.projectId}`;
    const hubIdDM = `b.${created.accountId}`;

    // 4) **EVITAR doble "LBAN0X"**:
    //    Copiamos SIEMPRE bajo la raíz /Project Files (sin añadir <siteName>),
    //    porque el árbol que viene de SP ya incluye la carpeta raíz "LBAN0X".
    //    Así se crea solo una vez: /Project Files/LBAN0X/...
    const destPath = `/Project Files`;
    const targetFolderId = await acc.ensureFolderByPath(projectIdDM, destPath, { preferHubId: hubIdDM });

    // 5) Copiar árbol completo de SP → carpeta destino del nuevo proyecto ACC
    const copyLog = [];
    const copyResult = await transfer.copySpTreeToAcc({
      driveId,
      itemId,
      // OJO: copySpTreeToAcc espera el projectId de DM (con 'b.')
      projectId: projectIdDM,
      targetFolderId,            // carpeta real, no null
      mode,                      // 'upsert' | 'skip' | 'rename'
      dryRun: false,
      onLog: (m) => copyLog.push(m),
    });

    // 6) Clonar miembros desde otro proyecto ACC si se indicó
    let cloneSummary = null;
    if (cloneMembersFromProjectId) {
      const canCallServiceClone = typeof accAdmin.cloneProjectMembers === 'function';
      cloneSummary = canCallServiceClone
        ? await accAdmin.cloneProjectMembers({
          fromProjectId: cloneMembersFromProjectId,
          toProjectId: created.projectId,
          notify: false,
        })
        : await cloneMembersFallback({
          fromProjectId: cloneMembersFromProjectId,
          toProjectId: created.projectId,
          notify: false,
        });
    }

    // 7) Respuesta
    res.json({
      ok: true,
      created: {
        accountId: created.accountId,
        projectId: created.projectId,      // Admin
        projectIdDM,                       // DM (con 'b.')
        name: created.name,
      },
      copy: { ...copyResult, log: copyLog },
      clonedMembers: cloneSummary,
    });
  } catch (err) {
    next(err);
  }
}

// --- helpers ACC members (local, sin depender del servicio) ---

// Normaliza un miembro de Admin API → { email, makeProjectAdmin, grantDocs }
function normalizeAdminUser(u) {
  const prods = Array.isArray(u?.products) ? u.products : [];
  const isAdmin = !!prods.find(p => p.key === 'projectAdministration' && p.access === 'administrator');

  let grantDocs = 'viewer';
  const docs = prods.find(p => p.key === 'docs');
  if (docs?.access === 'administrator') grantDocs = 'admin';
  else if (docs?.access === 'member') grantDocs = 'member';

  return {
    email: (u?.email || '').trim(),
    makeProjectAdmin: isAdmin,
    grantDocs
  };
}

// Lista miembros del proyecto (Admin IDs, SIN 'b.') con 3LO directamente
async function listAccProjectMembersNormalizedLocal(projectId) {
  const pageSize = 500;
  let offset = 0;
  const acc = [];

  for (let i = 0; i < 100; i++) {
    const r = await apsUser.apiGet(
      `/construction/admin/v1/projects/${encodeURIComponent(projectId)}/users`,
      { params: { limit: pageSize, offset } }
    );
    const items = Array.isArray(r?.results) ? r.results : (Array.isArray(r) ? r : []);
    acc.push(...items);
    if (items.length < pageSize) break;
    offset += items.length;
  }

  return acc
    .map(normalizeAdminUser)
    .filter(x => x.email); // solo con email
}

// Invita a 1 usuario al proyecto con el rol correcto
async function ensureProjectMemberLocal({ projectId, email, makeProjectAdmin, grantDocs, notify = false }) {
  if (typeof accAdmin.ensureProjectMember === 'function') {
    // usa la del servicio si existe
    return await accAdmin.ensureProjectMember({ projectId, email, makeProjectAdmin, grantDocs, notify });
  }

  // fallback directo a Admin API (3LO)
  const products = [];
  if (makeProjectAdmin) products.push({ key: 'projectAdministration', access: 'administrator' });

  const lvl = String(grantDocs || 'viewer').toLowerCase();
  products.push({ key: 'docs', access: (lvl === 'admin' ? 'administrator' : (lvl === 'member' ? 'member' : 'viewer')) });

  await apsUser.apiPost(
    `/construction/admin/v1/projects/${encodeURIComponent(projectId)}/users`,
    { email, products, notify: !!notify }
  );

  return { ok: true, email };
}

// Clona miembros (origen→destino) usando los helpers locales
async function cloneMembersFallback({ fromProjectId, toProjectId, notify = false }) {
  const src = await listAccProjectMembersNormalizedLocal(fromProjectId);
  let added = 0, skipped = 0, failures = 0;
  const results = [];

  for (const m of src) {
    try {
      const r = await ensureProjectMemberLocal({
        projectId: toProjectId,
        email: m.email,
        makeProjectAdmin: !!m.makeProjectAdmin,
        grantDocs: m.grantDocs || 'viewer',
        notify
      });
      results.push({ ok: true, email: m.email, result: r });
      if (r?.ok && !r?.skipped) added++; else skipped++;
    } catch (e) {
      failures++;
      const msg = e?.response?.data?.detail || e?.message || 'invite_failed';
      results.push({ ok: false, email: m.email, error: msg });
    }
  }
  return { added, skipped, failures, total: src.length, results };
}

module.exports = { spToAcc, spTreeToAcc, spToNewAccProject };
