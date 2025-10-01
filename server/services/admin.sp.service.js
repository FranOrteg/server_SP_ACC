// services/admin.sp.service.js

const { spoAdminPost, spoAdminGet } = require('../clients/spoClient');
const logger = require('../helpers/logger').mk('SP');
const { graphGet, graphPost } = require('../clients/graphClient');
const sp = require('./sharepoint.service');
const { expandFolders, getPermissions } = require('./admin.template.service');

// ------------------------ utils ------------------------
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// mapea axios error -> { status, detail }
function mapAxiosError(e, fallbackMsg = 'sharepoint_error') {
  const status = e?.response?.status || 500;
  const detail =
    e?.response?.data?.error?.message ||
    e?.response?.data?.ErrorMessage ||
    e?.message ||
    fallbackMsg;
  const err = new Error(detail);
  err.status = status;
  return err;
}

// ------------------------ helpers Graph ------------------------
async function getDefaultDriveId(siteId) {
  const { data } = await graphGet(`/sites/${encodeURIComponent(siteId)}/drive?$select=id,name`);
  return data?.id || null;
}

async function getItemByPath(driveId, relPath) {
  const clean = String(relPath || '').replace(/^\/+/, '');
  const url = clean ? `/drives/${driveId}/root:/${encodeURI(clean)}` : `/drives/${driveId}/root`;
  const { data } = await graphGet(url);
  return data;
}

async function createChildFolder(driveId, parentItemId, name) {
  const { data } = await graphPost(`/drives/${driveId}/items/${parentItemId}/children`, {
    name,
    folder: {},
    '@microsoft.graph.conflictBehavior': 'fail'
  });
  return data;
}

async function ensureFolderByPath(driveId, relPath) {
  const segs = String(relPath || '').split('/').filter(Boolean);
  const root = await getItemByPath(driveId, '');
  let parentId = root.id;
  let built = '';

  for (const seg of segs) {
    built = built ? `${built}/${seg}` : seg;
    try {
      const item = await getItemByPath(driveId, built);
      parentId = item.id;
    } catch {
      const created = await createChildFolder(driveId, parentId, seg);
      parentId = created.id;
    }
  }
  return parentId;
}

async function adminFindActiveSiteByUrl(url) {
  const path = "/_api/Microsoft.Online.SharePoint.TenantAdministration/ServiceManagedSiteProperties?$filter=Url eq '"
    + url.replace(/'/g, "''") + "'";
  const { data } = await spoAdminGet(path, { Accept: 'application/json;odata=verbose' });
  const value = data?.d?.results || data?.d?.ServiceManagedSiteProperties || data?.value || [];
  return Array.isArray(value) ? value : [];
}

async function adminFindDeletedSiteByUrl(url) {
  const path = "/_api/Microsoft.Online.SharePoint.TenantAdministration/DeletedSiteProperties?$filter=Url eq '"
    + url.replace(/'/g, "''") + "'";
  const { data } = await spoAdminGet(path, { Accept: 'application/json;odata=verbose' });
  const value = data?.d?.results || data?.d?.DeletedSiteProperties || data?.value || [];
  return Array.isArray(value) ? value : [];
}

// ------------------------ provisioning waits ------------------------

/**
 * Intenta resolver el siteId usando la Admin API (ServiceManagedSiteProperties)
 * Útil cuando Graph aún no refleja el sitio pero ya está en Admin
 */
async function getSiteIdFromAdminApi(siteUrl) {
  try {
    const sites = await adminFindActiveSiteByUrl(siteUrl);
    if (sites.length > 0) {
      // Los datos pueden venir con diferentes estructuras según el tenant
      const site = sites[0];
      const siteId = site.SiteId || site.siteId || site.Id || site.id;
      if (siteId) {
        logger.debug('getSiteIdFromAdminApi found', { siteUrl, siteId, meta: { provisioning: true } });
        return siteId;
      }
    }
  } catch (err) {
    logger.debug('getSiteIdFromAdminApi failed', {
      siteUrl,
      error: err.message,
      meta: { provisioning: true }
    });
  }
  return null;
}

/**
 * Espera a que el sitio esté resolvible por Graph
 * Usa backoff exponencial con jitter
 */
async function waitUntilSpSiteReady({ siteUrl, siteId, maxMs = 300000 } = {}) {
  logger.debug('waitUntilSpSiteReady init', { siteUrl, siteId, maxMs, meta: { provisioning: true } });

  const started = Date.now();
  let attempt = 0;
  let currentDelay = 2000; // Empezar con 2s
  const maxDelay = 15000; // Max 15s entre intentos

  while (Date.now() - started < maxMs) {
    attempt++;

    try {
      // Estrategia 1: Si tenemos siteId, intentar por Graph con ID
      if (siteId && String(siteId).trim() !== '') {
        try {
          const s = await sp.resolveSiteIdFlexible({ siteId });
          if (s?.id) {
            logger.info('waitUntilSpSiteReady OK (by siteId)', {
              siteId: s.id,
              attempt,
              elapsed: Date.now() - started,
              meta: { provisioning: true }
            });
            return { siteId: s.id, siteUrl: s.webUrl };
          }
        } catch (err) {
          logger.debug('waitUntilSpSiteReady attempt by siteId failed', {
            attempt,
            error: err.message,
            meta: { provisioning: true }
          });
        }
      }

      // Estrategia 2: Intentar por URL en Graph
      if (siteUrl) {
        try {
          const s = await sp.resolveSiteIdFlexible({ url: siteUrl });
          if (s?.id) {
            logger.info('waitUntilSpSiteReady OK (by url)', {
              siteId: s.id,
              attempt,
              elapsed: Date.now() - started,
              meta: { provisioning: true }
            });
            return { siteId: s.id, siteUrl: s.webUrl };
          }
        } catch (err) {
          logger.debug('waitUntilSpSiteReady attempt by url failed', {
            attempt,
            error: err.message,
            meta: { provisioning: true }
          });
        }
      }

      // Estrategia 3: Si no tenemos siteId, intentar obtenerlo de Admin API
      if (!siteId && siteUrl && attempt % 3 === 0) {
        const adminSiteId = await getSiteIdFromAdminApi(siteUrl);
        if (adminSiteId) {
          siteId = adminSiteId;
          logger.debug('waitUntilSpSiteReady got siteId from Admin API', {
            siteId,
            meta: { provisioning: true }
          });
        }
      }

    } catch (err) {
      logger.debug('waitUntilSpSiteReady iteration error', {
        attempt,
        error: err.message,
        meta: { provisioning: true }
      });
    }

    // Backoff exponencial con jitter
    const jitter = Math.random() * 1000;
    await sleep(Math.min(currentDelay + jitter, maxDelay));
    currentDelay = Math.min(currentDelay * 1.5, maxDelay);

    logger.debug('waitUntilSpSiteReady retrying', {
      attempt,
      nextDelay: currentDelay,
      elapsed: Date.now() - started,
      meta: { provisioning: true }
    });
  }

  const e = new Error(`Timeout esperando a que el sitio sea resolvible (${maxMs}ms, ${attempt} intentos)`);
  e.status = 504;
  throw e;
}

/**
 * Espera activamente usando SPSiteManager/status hasta que el sitio esté listo
 * Solo usar cuando SPSiteManager/create devolvió status=3 (Provisioning)
 */
async function pollSPSiteManagerStatus(targetUrl, { maxMs = 360000, intervalMs = 5000 } = {}) {
  const started = Date.now();
  let attempt = 0;

  // Variantes de query (algunos tenants requieren comillas, otros no)
  const variants = [
    `/_api/SPSiteManager/status?url=${encodeURIComponent(targetUrl)}`,
    `/_api/SPSiteManager/status?url='${targetUrl.replace(/'/g, "%27")}'`
  ];
  let useVariant = 0;

  logger.debug('pollSPSiteManagerStatus init', {
    targetUrl,
    maxMs,
    intervalMs,
    meta: { provisioning: true }
  });

  while (Date.now() - started < maxMs) {
    attempt++;
    const statusUrl = variants[useVariant];

    try {
      const { data } = await spoAdminGet(statusUrl, {
        Accept: 'application/json;odata=verbose'
      });

      // Normalizar respuesta (puede venir con o sin wrapper 'd')
      const payload = data?.d || data;
      const status = payload?.SiteStatus ?? payload?.status;
      const siteId = payload?.SiteId ?? payload?.siteId;
      const siteUrl = payload?.Url ?? payload?.url;

      logger.debug('pollSPSiteManagerStatus response', {
        attempt,
        status,
        siteId,
        siteUrl,
        elapsed: Date.now() - started,
        meta: { provisioning: true }
      });

      // Status codes:
      // 0 = Provisioning
      // 1 = Error
      // 2 = Ready
      // 3 = (a veces) Creating/Queued

      if (status === 2 && siteId) {
        logger.info('pollSPSiteManagerStatus complete', {
          siteId,
          siteUrl,
          attempt,
          elapsed: Date.now() - started,
          meta: { provisioning: true }
        });
        return { ready: true, siteId, siteUrl, raw: payload };
      }

      if (status === 1) {
        const errMsg = payload?.ErrorMessage || 'SPSiteManager status=Error';
        const e = new Error(errMsg);
        e.status = 400;
        throw e;
      }

      // Status 0 o 3: seguir esperando

    } catch (err) {
      const code = err?.response?.status;

      logger.debug('pollSPSiteManagerStatus error', {
        attempt,
        statusCode: code,
        error: err.message,
        variant: useVariant,
        meta: { provisioning: true }
      });

      // Si es 400 y aún no probamos la otra variante, cambiar
      if (code === 400 && useVariant === 0) {
        useVariant = 1;
        logger.debug('pollSPSiteManagerStatus switching to quoted variant', {
          meta: { provisioning: true }
        });
      }

      // Si el error es 404, puede que el endpoint no exista o el sitio no esté registrado aún
      // No lanzar error, seguir esperando
    }

    await sleep(intervalMs);
  }

  const e = new Error(`Timeout esperando status del sitio (${maxMs}ms, ${attempt} intentos)`);
  e.status = 504;
  throw e;
}

// ------------------------ plantilla ------------------------
async function applyTemplateToSite({ siteId, siteUrl, template, resolvedName }) {
  try {
    let sId = siteId;

    // 1) Resolver siteId si solo viene URL
    if (!sId && siteUrl) {
      try {
        const s = await sp.resolveSiteIdFlexible({ url: siteUrl });
        sId = s?.id;
      } catch (e) {
        logger.debug('applyTemplateToSite: resolveSiteIdFlexible aún no disponible', {
          siteUrl,
          meta: { provisioning: true }
        });
      }
    }

    // 2) Asegurar sitio listo
    const ready = await waitUntilSpSiteReady({ siteUrl, siteId: sId, maxMs: 180000 });
    sId = ready.siteId;
    const resolvedUrl = ready.siteUrl;

    // 3) Drive por defecto
    const driveId = await getDefaultDriveId(sId);
    if (!driveId) throw new Error('No encontré la biblioteca por defecto');

    // 4) Carpetas (idempotente)
    const created = [];
    const ensured = [];
    const folders = expandFolders(template) || [];

    for (const rel of folders) {
      try {
        await getItemByPath(driveId, rel);
        ensured.push(rel);
        logger.debug('ensureFolder exists', { rel });
      } catch {
        await ensureFolderByPath(driveId, rel);
        created.push(rel);
        logger.debug('ensureFolder created', { rel });
      }
    }

    // 5) Permisos
    const perms = getPermissions(template) || [];
    // TODO: implementar según tu política de grupos

    logger.info('Plantilla aplicada', {
      siteId: sId,
      name: resolvedName,
      folders: { created: created.length, ensured: ensured.length }
    });

    return {
      siteId: sId,
      name: resolvedName,
      folders: { created, ensured },
      permissionsApplied: perms.length || 0
    };
  } catch (e) {
    throw mapAxiosError(e, 'apply_template_failed');
  }
}

// ------------------------ creación de sitio ------------------------

/**
 * Crea un sitio de SharePoint usando SPSiteManager/create
 * Maneja los diferentes estados de provisioning de forma robusta
 */
async function createSite({
  type = 'CommunicationSite',
  title,
  url,
  description = '',
  lcid = 1033,
  classification = ''
}) {
  if (!url) throw new Error('url es obligatorio');

  // PREFLIGHT 1: Verificar si ya existe en Graph
  try {
    const existing = await sp.resolveSiteIdFlexible({ url });
    if (existing?.id) {
      logger.info('Sitio SP ya existía (Graph)', {
        siteId: existing.id,
        siteUrl: existing.webUrl
      });
      return { siteId: existing.id, siteUrl: existing.webUrl, status: 2 };
    }
  } catch { /* no existe, continuamos */ }

  // PREFLIGHT 2: Verificar Admin API (activo)
  try {
    const actives = await adminFindActiveSiteByUrl(url);
    if (actives.length) {
      logger.info('Sitio SP ya existía (Admin API)', { siteUrl: url });
      // Esperar a que Graph lo refleje
      const resolved = await waitUntilSpSiteReady({ siteUrl: url, maxMs: 180000 });
      return { siteId: resolved.siteId, siteUrl: resolved.siteUrl, status: 2 };
    }
  } catch (pfErr) {
    logger.debug('Preflight Admin API check failed', { error: pfErr.message });
  }

  // PREFLIGHT 3: Verificar papelera
  try {
    const deleted = await adminFindDeletedSiteByUrl(url);
    if (deleted.length) {
      const e = new Error(
        `La URL ya está en la papelera de sitios del tenant. ` +
        `Elimínalo definitivamente o usa otra URL.`
      );
      e.status = 409;
      throw e;
    }
  } catch (pfErr) {
    if (pfErr.status === 409) throw pfErr;
  }

  // CREACIÓN
  logger.info('Creando sitio SP', { type, url, title });

  const payload = {
    request: {
      Title: title || '',
      Url: url,
      Lcid: lcid,
      ShareByEmailEnabled: false,
      Classification: classification || null,
      WebTemplate: (type === 'TeamSite') ? 'STS#3' : 'SITEPAGEPUBLISHING#0',
      Description: description || '',
      Owner: process.env.SPO_SITE_OWNER || undefined
    }
  };

  const { data } = await spoAdminPost('/_api/SPSiteManager/create', payload);

  const siteStatus = data?.SiteStatus ?? data?.status ?? null;
  const responseSiteId = data?.SiteId || data?.siteId || '';

  logger.debug('SPSiteManager.create response', {
    status: siteStatus,
    siteId: responseSiteId,
    url: data?.Url || url,
    meta: { provisioning: true }
  });

  // Manejar diferentes estados

  // CASO 1: Status 2 (Ready) con SiteId - sitio listo inmediatamente
  if (siteStatus === 2 && responseSiteId) {
    logger.info('Sitio SP creado inmediatamente', {
      siteId: responseSiteId,
      siteUrl: url
    });
    return { siteId: responseSiteId, siteUrl: url, status: 2 };
  }

  // CASO 2: Status 0 o 3 (Provisioning/Queued) - esperar activamente
  if (siteStatus === 0 || siteStatus === 3) {
    logger.info('Sitio en provisioning, esperando...', {
      status: siteStatus,
      url,
      meta: { provisioning: true }
    });

    try {
      // Intentar polling del status primero (más confiable si funciona)
      const pollResult = await pollSPSiteManagerStatus(url, {
        maxMs: 300000,  // 5 min
        intervalMs: 5000
      });

      if (pollResult.ready && pollResult.siteId) {
        // Verificar en Graph
        const resolved = await waitUntilSpSiteReady({
          siteUrl: pollResult.siteUrl,
          siteId: pollResult.siteId,
          maxMs: 120000 // 2 min adicionales
        });

        logger.info('Sitio SP creado (via polling)', {
          siteId: resolved.siteId,
          siteUrl: resolved.siteUrl
        });
        return { siteId: resolved.siteId, siteUrl: resolved.siteUrl, status: 2 };
      }
    } catch (pollErr) {
      logger.warn('Polling de status falló, intentando espera directa', {
        error: pollErr.message,
        meta: { provisioning: true }
      });
    }

    // Fallback: esperar directamente por Graph
    try {
      const resolved = await waitUntilSpSiteReady({
        siteUrl: url,
        siteId: responseSiteId || undefined,
        maxMs: 480000 // 8 min
      });

      logger.info('Sitio SP creado (via Graph wait)', {
        siteId: resolved.siteId,
        siteUrl: resolved.siteUrl
      });
      return { siteId: resolved.siteId, siteUrl: resolved.siteUrl, status: 2 };
    } catch (waitErr) {
      // Diagnóstico final
      const [activesAfter, deletedAfter] = await Promise.all([
        adminFindActiveSiteByUrl(url).catch(() => []),
        adminFindDeletedSiteByUrl(url).catch(() => [])
      ]);

      if (deletedAfter.length) {
        const e = new Error(
          `La creación falló y el sitio quedó en la papelera. ` +
          `Elimínalo definitivamente e inténtalo de nuevo.`
        );
        e.status = 409;
        throw e;
      }

      if (activesAfter.length) {
        const e = new Error(
          `El sitio aparece activo en Admin pero Graph aún no lo resuelve. ` +
          `Espera unos minutos y consulta directamente: ${url}`
        );
        e.status = 504;
        throw e;
      }

      const e = new Error(
        `SharePoint aceptó la creación pero no se materializó en el tiempo esperado. ` +
        `Verifica manualmente o intenta con otra URL.`
      );
      e.status = 504;
      throw e;
    }
  }

  // CASO 3: Status 1 (Error) o cualquier otro
  const errMsg = data?.ErrorMessage || `SPSiteManager devolvió status inesperado: ${siteStatus}`;
  const e = new Error(errMsg);
  e.status = 400;
  throw e;
}

module.exports = {
  applyTemplateToSite,
  createSite
};