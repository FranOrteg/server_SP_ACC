// controllers/bridge.controller.js

const transfer = require('../services/transfer.service');
const sp = require('../services/sharepoint.service');
const acc = require('../services/acc.service');
const accAdmin = require('../services/admin.acc.service');
const spAdmin = require('../services/admin.sp.service');
const apsUser = require('../clients/apsUserClient');
const { graphGet } = require('../clients/graphClient');
const logger = require('../helpers/logger').mk('BRIDGE');
const { setupSSE, cancelSession, getSessionInfo, listActiveSessions } = require('../helpers/progressEmitter');

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
      mapSpMembers = true,      // NUEVO: por defecto, copiar miembros de SP
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

    // 6) Mapear miembros del sitio SP al nuevo proyecto ACC
    let spMembersSummary = null;
    if (mapSpMembers && !cloneMembersFromProjectId) {
      logger.info('🔄 Iniciando mapeo de miembros de SP a ACC', { mapSpMembers, cloneMembersFromProjectId });
      try {

        // Helper para extraer solo la URL del sitio (sin /Shared Documents /Documentos compartidos, etc.)
        const extractSiteUrl = (url) => {
          if (!url) return null;
          try {
            const urlObj = new URL(url);
            // Coincidir /sites/{nombre} o /teams/{nombre}
            const m = urlObj.pathname.match(/\/(sites|teams)\/[^\/]+/i);
            if (m) return `${urlObj.protocol}//${urlObj.host}${m[0]}`;
            // Fallback: si no hay match, quitamos cualquier sufijo de biblioteca conocido
            const knownLibs = [
              '/Shared Documents',
              '/Documentos compartidos',
              '/Documents'
            ].map(s => s.toLowerCase());
            const base = urlObj.pathname.split('/').slice(0, 3).join('/'); // "", "sites|teams", "{nombre}" => /sites/foo
            if (base && (base.toLowerCase().startsWith('/sites/') || base.toLowerCase().startsWith('/teams/'))) {
              return `${urlObj.protocol}//${urlObj.host}${base}`;
            }
            // Si nada cuadra, devolvemos el original
            return `${urlObj.protocol}//${urlObj.host}${urlObj.pathname}`;
          } catch {
            return url;
          }
        };

        // 1) Intentar resolver siteUrl a partir del item (puede venir con /Shared%20Documents)
        logger.debug('Obteniendo metadata del item', { driveId, itemId });
        const meta = await sp.getItemMeta(driveId, itemId);
        let rawSiteUrl = meta?.parentReference?.siteUrl || meta?.webUrl || null;
        logger.debug('siteUrl desde item meta (raw)', { rawSiteUrl, parentReference: meta?.parentReference });
        let siteUrl = extractSiteUrl(rawSiteUrl);
        logger.debug('siteUrl extraído desde item', { siteUrl });

        // 2) Si no se pudo extraer del item, probar con el drive
        if (!siteUrl) {
          logger.debug('siteUrl no encontrado en item; intentando desde drive');
          const { data: drv } = await graphGet(`/drives/${encodeURIComponent(driveId)}?$select=name,webUrl,sharepointIds`);
          rawSiteUrl = drv?.webUrl || null;
          siteUrl = extractSiteUrl(rawSiteUrl);
          logger.debug('siteUrl extraído desde drive', {
            siteUrl,
            driveWebUrl: drv?.webUrl,
            siteId: drv?.sharepointIds?.siteId
          });
          // 3) Último recurso: si hay siteId en sharepointIds, resolverlo a webUrl
          if (!siteUrl && drv?.sharepointIds?.siteId) {
            logger.debug('Resolviendo siteUrl desde siteId via Graph', { siteId: drv.sharepointIds.siteId });
            const { data: site } = await graphGet(`/sites/${drv.sharepointIds.siteId}?$select=webUrl`);
            siteUrl = site?.webUrl ? extractSiteUrl(site.webUrl) : null;
            logger.debug('siteUrl resuelto desde Graph (siteId)', { siteUrl });
          }
        }

        if (siteUrl) {
          logger.info('✅ siteUrl obtenido, obteniendo miembros del sitio', { siteUrl });
          // Obtener miembros del sitio SP en formato plano
          const spMembers = await spAdmin.getSiteMembers({ siteUrl, format: 'flat' });
          const users = spMembers?.users || [];
          logger.info(`📋 Miembros obtenidos de SP: ${users.length}`, { mode: spMembers?.mode, userCount: users.length });

          if (users.length > 0) {
            let added = 0, skipped = 0, failures = 0;
            const results = [];

            for (const u of users) {
              if (!u.email) {
                logger.debug('⚠️ Usuario sin email, saltando', { user: u });
                continue;
              }

              try {
                // Mapear rol de SP a ACC
                const accRole = mapSpRoleToAcc(u.role);
                logger.debug(`➕ Añadiendo miembro: ${u.email}`, { spRole: u.role, accRole });

                const r = await ensureProjectMemberLocal({
                  projectId: created.projectId,
                  email: u.email,
                  makeProjectAdmin: accRole.makeProjectAdmin,
                  grantDocs: accRole.grantDocs,
                  notify: false,
                });

                results.push({ ok: true, email: u.email, spRole: u.role, accRole, result: r });
                if (r?.ok && !r?.skipped) {
                  added++;
                  logger.info(`✅ Miembro añadido: ${u.email}`);
                } else if (r?.ok && r?.skipped && r?.status === 409) {
                  // 409 Conflict = usuario ya existe en el proyecto
                  skipped++;
                  logger.info(`⏭️ Miembro ya existente: ${u.email}`);
                } else {
                  // Otro tipo de error (ej: 400 Bad Request)
                  failures++;
                  const errorMsg = r?.error?.detail || r?.error?.errors?.[0]?.detail || r?.error || 'Error desconocido';
                  logger.warn(`⚠️ Error añadiendo miembro ${u.email}: ${errorMsg}`, { status: r?.status, error: r?.error });
                }
              } catch (e) {
                failures++;
                const msg = e?.response?.data?.detail || e?.message || 'invite_failed';
                logger.error(`❌ Error añadiendo miembro ${u.email}:`, { error: msg });
                results.push({ ok: false, email: u.email, spRole: u.role, error: msg });
              }
            }

            spMembersSummary = { added, skipped, failures, total: users.length, results };
            logger.info('✅ Mapeo de miembros completado', spMembersSummary);
          } else {
            logger.warn('⚠️ No se encontraron usuarios en el sitio de SP');
          }
        } else {
          logger.warn('⚠️ No se pudo obtener siteUrl');
        }
      } catch (e) {
        // Si falla la obtención de miembros, lo registramos pero no fallamos la operación completa
        logger.error('❌ Error en mapeo de miembros de SP', { error: e?.message, stack: e?.stack });
        spMembersSummary = { error: e?.message || 'Failed to map SP members', added: 0, skipped: 0, failures: 0 };
      }
    } else {
      logger.info('⏭️ Mapeo de miembros de SP desactivado o usando cloneMembersFromProjectId', { mapSpMembers, cloneMembersFromProjectId });
    }

    // 7) Clonar miembros desde otro proyecto ACC si se indicó (alternativa al mapeo de SP)
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

    // 8) Respuesta
    res.json({
      ok: true,
      created: {
        accountId: created.accountId,
        projectId: created.projectId,      // Admin
        projectIdDM,                       // DM (con 'b.')
        name: created.name,
      },
      copy: { ...copyResult, log: copyLog },
      mappedSpMembers: spMembersSummary,
      clonedMembers: cloneSummary,
    });
  } catch (err) {
    next(err);
  }
}

// --- helpers ACC members (local, sin depender del servicio) ---

// Mapea roles de SharePoint a roles de ACC
function mapSpRoleToAcc(spRole) {
  const r = String(spRole || 'Member').toLowerCase();
  if (r === 'owner') return { makeProjectAdmin: true, grantDocs: 'admin' };
  if (r === 'visitor') return { makeProjectAdmin: false, grantDocs: 'viewer' };
  // default Member
  return { makeProjectAdmin: false, grantDocs: 'member' };
}

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

  // Convertir nivel a access de Autodesk
  const lvl = String(grantDocs || 'viewer').toLowerCase();
  const access = lvl === 'admin' ? 'administrator' : (lvl === 'member' ? 'member' : 'viewer');
  
  // IMPORTANTE: Todos los productos deben tener el mismo nivel de acceso
  // La API de Autodesk rechaza mezclar 'member' con 'administrator'
  products.push({ key: 'docs', access });
  products.push({ key: 'designCollaboration', access });
  products.push({ key: 'modelCoordination', access });

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

// =====================================================
// STREAMING SSE: sp-to-new-acc-project/stream
// =====================================================

/**
 * POST /api/bridge/sp-to-new-acc-project/stream
 * Versión con Server-Sent Events para progreso en tiempo real
 */
async function spToNewAccProjectStream(req, res) {
  // Configurar SSE
  const { sessionId, emitter } = setupSSE(req, res);
  
  logger.info(`[SSE] Iniciando sesión de migración: ${sessionId}`);
  
  let partialResult = null;
  let currentStep = 'reading';

  try {
    const {
      driveId,
      itemId,
      hubId,
      accountId,
      cloneMembersFromProjectId,
      mapSpMembers = true,
      mode = 'upsert',
    } = { ...req.query, ...(req.body || {}) };

    // 1) Validaciones
    if (!driveId || !itemId || !(hubId || accountId)) {
      emitter.error(new Error('driveId, itemId y hubId|accountId son obligatorios'), null, 'reading');
      res.end();
      return;
    }

    // ===== FASE 1: READING =====
    currentStep = 'reading';
    emitter.progress({
      currentStep,
      stepProgress: 0,
      message: 'Iniciando lectura de SharePoint...',
      force: true
    });
    
    emitter.checkCancellation();

    // 2) Nombre del sitio SP → nombre del proyecto ACC
    emitter.progress({
      currentStep,
      stepProgress: 30,
      message: 'Resolviendo nombre del sitio de SharePoint...'
    });

    const siteName = await sp.getSiteNameForItem(driveId, itemId);
    if (!siteName) {
      emitter.error(new Error('No se pudo resolver el nombre del sitio de SharePoint'), null, 'reading');
      res.end();
      return;
    }
    const projectName = `${siteName} SP`;

    emitter.progress({
      currentStep,
      stepProgress: 60,
      message: `Sitio encontrado: ${siteName}`
    });
    
    emitter.checkCancellation();

    // ===== FASE 2: PROCESSING =====
    currentStep = 'processing';
    emitter.progress({
      currentStep,
      stepProgress: 0,
      message: 'Creando proyecto en Autodesk ACC...',
      force: true
    });

    // 3) Crear proyecto ACC
    const created = await accAdmin.createProject({
      hubId,
      accountId,
      name: projectName,
      onNameConflict: 'suffix-timestamp',
    });

    const projectIdDM = created?.dm?.projectIdDM || `b.${created.projectId}`;
    const hubIdDM = `b.${created.accountId}`;

    emitter.progress({
      currentStep,
      stepProgress: 50,
      message: `Proyecto creado: ${created.name}`
    });
    
    emitter.checkCancellation();

    partialResult = {
      created: {
        accountId: created.accountId,
        projectId: created.projectId,
        projectIdDM,
        name: created.name,
      }
    };

    // 4) Preparar carpeta destino
    const destPath = `/Project Files`;
    const targetFolderId = await acc.ensureFolderByPath(projectIdDM, destPath, { preferHubId: hubIdDM });

    emitter.progress({
      currentStep,
      stepProgress: 100,
      message: 'Estructura del proyecto preparada'
    });
    
    emitter.checkCancellation();

    // ===== FASE 3: UPLOADING =====
    currentStep = 'uploading';
    emitter.progress({
      currentStep,
      stepProgress: 0,
      message: 'Iniciando copia de archivos...',
      force: true
    });

    // 5) Copiar árbol completo de SP → ACC (con progreso)
    const copyLog = [];
    const copyResult = await transfer.copySpTreeToAcc({
      driveId,
      itemId,
      projectId: projectIdDM,
      targetFolderId,
      mode,
      dryRun: false,
      onLog: (m) => copyLog.push(m),
      // Callback de progreso
      onProgress: (progress) => {
        emitter.checkCancellation();
        emitter.progress({
          currentStep: 'uploading',
          stepProgress: progress.stepProgress,
          message: `Subiendo: ${progress.currentFile} (${progress.processedFiles}/${progress.totalFiles})`,
          totalItems: progress.totalFiles,
          processedItems: progress.processedFiles,
          currentItem: progress.currentFile,
          bytesTotal: progress.bytesTotal,
          bytesTransferred: progress.bytesTransferred
        });
      }
    });

    partialResult.copy = { ...copyResult, log: copyLog };
    
    emitter.updateStats({ 
      bytes: copyResult.summary?.bytesUploaded || 0, 
      files: copyResult.summary?.filesUploaded || 0 
    });

    // ===== FASE 4: MEMBERS =====
    currentStep = 'members';
    let spMembersSummary = null;
    let cloneSummary = null;
    let membersAdded = 0;

    if (mapSpMembers && !cloneMembersFromProjectId) {
      emitter.progress({
        currentStep,
        stepProgress: 0,
        message: 'Configurando miembros del proyecto...',
        force: true
      });
      
      emitter.checkCancellation();

      try {
        // Helper para extraer siteUrl
        const extractSiteUrl = (url) => {
          if (!url) return null;
          try {
            const urlObj = new URL(url);
            const m = urlObj.pathname.match(/\/(sites|teams)\/[^\/]+/i);
            if (m) return `${urlObj.protocol}//${urlObj.host}${m[0]}`;
            const base = urlObj.pathname.split('/').slice(0, 3).join('/');
            if (base && (base.toLowerCase().startsWith('/sites/') || base.toLowerCase().startsWith('/teams/'))) {
              return `${urlObj.protocol}//${urlObj.host}${base}`;
            }
            return `${urlObj.protocol}//${urlObj.host}${urlObj.pathname}`;
          } catch {
            return url;
          }
        };

        const meta = await sp.getItemMeta(driveId, itemId);
        let rawSiteUrl = meta?.parentReference?.siteUrl || meta?.webUrl || null;
        let siteUrl = extractSiteUrl(rawSiteUrl);

        if (!siteUrl) {
          const { data: drv } = await graphGet(`/drives/${encodeURIComponent(driveId)}?$select=name,webUrl,sharepointIds`);
          rawSiteUrl = drv?.webUrl || null;
          siteUrl = extractSiteUrl(rawSiteUrl);
          if (!siteUrl && drv?.sharepointIds?.siteId) {
            const { data: site } = await graphGet(`/sites/${drv.sharepointIds.siteId}?$select=webUrl`);
            siteUrl = site?.webUrl ? extractSiteUrl(site.webUrl) : null;
          }
        }

        if (siteUrl) {
          const spMembers = await spAdmin.getSiteMembers({ siteUrl, format: 'flat' });
          const users = spMembers?.users || [];

          if (users.length > 0) {
            let added = 0, skipped = 0, failures = 0;
            const results = [];
            const total = users.length;

            for (let i = 0; i < users.length; i++) {
              const u = users[i];
              
              emitter.checkCancellation();
              
              emitter.progress({
                currentStep,
                stepProgress: Math.round((i / total) * 100),
                message: `Añadiendo miembro: ${u.email || 'sin email'} (${i + 1}/${total})`,
                totalItems: total,
                processedItems: i
              });

              if (!u.email) continue;

              try {
                const accRole = mapSpRoleToAcc(u.role);
                const r = await ensureProjectMemberLocal({
                  projectId: created.projectId,
                  email: u.email,
                  makeProjectAdmin: accRole.makeProjectAdmin,
                  grantDocs: accRole.grantDocs,
                  notify: false,
                });

                results.push({ ok: true, email: u.email, spRole: u.role, accRole, result: r });
                if (r?.ok && !r?.skipped) {
                  added++;
                } else if (r?.ok && r?.skipped && r?.status === 409) {
                  skipped++;
                } else {
                  failures++;
                  emitter.addNonCriticalError(`Error añadiendo ${u.email}: ${r?.error?.detail || 'desconocido'}`);
                }
              } catch (e) {
                failures++;
                const msg = e?.response?.data?.detail || e?.message || 'invite_failed';
                results.push({ ok: false, email: u.email, spRole: u.role, error: msg });
                emitter.addNonCriticalError(`Error añadiendo ${u.email}: ${msg}`);
              }
            }

            spMembersSummary = { added, skipped, failures, total: users.length, results };
            membersAdded = added;
          }
        }
      } catch (e) {
        if (e.message === 'CANCELLED') throw e;
        spMembersSummary = { error: e?.message || 'Failed to map SP members', added: 0, skipped: 0, failures: 0 };
        emitter.addNonCriticalError(`Error en mapeo de miembros: ${e?.message}`);
      }
    } else if (cloneMembersFromProjectId) {
      emitter.progress({
        currentStep,
        stepProgress: 0,
        message: 'Clonando miembros desde otro proyecto...',
        force: true
      });
      
      emitter.checkCancellation();

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
      membersAdded = cloneSummary?.added || 0;
    }

    emitter.progress({
      currentStep,
      stepProgress: 100,
      message: 'Configuración de miembros completada'
    });

    partialResult.mappedSpMembers = spMembersSummary;
    partialResult.clonedMembers = cloneSummary;

    // ===== FASE 5: FINALIZING =====
    currentStep = 'finalizing';
    emitter.progress({
      currentStep,
      stepProgress: 0,
      message: 'Verificando migración...',
      force: true
    });
    
    emitter.checkCancellation();

    emitter.progress({
      currentStep,
      stepProgress: 50,
      message: 'Generando resumen...'
    });

    // Resultado final
    const finalResult = {
      ok: true,
      created: partialResult.created,
      copy: partialResult.copy,
      mappedSpMembers: spMembersSummary,
      clonedMembers: cloneSummary,
    };

    emitter.progress({
      currentStep,
      stepProgress: 100,
      message: 'Migración completada exitosamente'
    });

    // Enviar evento complete
    const stats = emitter.getStats();
    emitter.complete(finalResult, {
      filesProcessed: copyResult.summary?.filesUploaded || 0,
      bytesTransferred: copyResult.summary?.bytesUploaded || 0,
      membersAdded
    });

    logger.info(`[SSE] Migración completada: ${sessionId}`, { 
      duration: stats.duration,
      files: stats.filesProcessed,
      bytes: stats.bytesTransferred
    });

  } catch (error) {
    if (error.message === 'CANCELLED') {
      emitter.cancelled(partialResult);
      logger.info(`[SSE] Migración cancelada: ${sessionId}`);
    } else {
      emitter.error(error, partialResult, currentStep);
      logger.error(`[SSE] Error en migración: ${sessionId}`, { error: error.message, step: currentStep });
    }
  }

  res.end();
}

/**
 * POST /api/bridge/sp-to-new-acc-project/cancel/:sessionId
 * Cancela una sesión de migración en progreso
 */
function cancelMigrationSession(req, res) {
  const { sessionId } = req.params;
  const result = cancelSession(sessionId);
  
  if (result.ok) {
    logger.info(`[SSE] Cancelación solicitada para sesión: ${sessionId}`);
    res.json(result);
  } else {
    res.status(404).json(result);
  }
}

/**
 * GET /api/bridge/sp-to-new-acc-project/sessions
 * Lista sesiones activas (admin/debug)
 */
function listMigrationSessions(req, res) {
  const sessions = listActiveSessions();
  res.json({ sessions, count: sessions.length });
}

/**
 * GET /api/bridge/sp-to-new-acc-project/session/:sessionId
 * Información de una sesión específica
 */
function getMigrationSession(req, res) {
  const { sessionId } = req.params;
  const info = getSessionInfo(sessionId);
  
  if (info) {
    res.json(info);
  } else {
    res.status(404).json({ error: 'Sesión no encontrada' });
  }
}

module.exports = { 
  spToAcc, 
  spTreeToAcc, 
  spToNewAccProject,
  // Nuevos endpoints de streaming
  spToNewAccProjectStream,
  cancelMigrationSession,
  listMigrationSessions,
  getMigrationSession
};
