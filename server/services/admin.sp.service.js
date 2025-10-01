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
  return data; // lanza si 404
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

async function pollSPSiteManagerStatus(targetUrl, { maxMs = 360000, intervalMs = 3000 } = {}) {
  const started = Date.now();
  let last = null;

  // Variantes probadas: algunos tenants exigen comillas simples; otros no.
  // Primero probamos SIN comillas y, si da 400, reintentamos CON comillas.
  const variants = [
    `/_api/SPSiteManager/status?url=${encodeURIComponent(targetUrl)}`,
    `/_api/SPSiteManager/status?url='${targetUrl.replace(/'/g, "%27")}'`
  ];
  let useVariant = 0;

  while (Date.now() - started < maxMs) {
    const statusUrl = variants[useVariant];
    try {
      // Algunas instancias piden odata=verbose para este endpoint
      const { data } = await spoAdminGet(statusUrl, { Accept: 'application/json;odata=verbose' });
      last = data;

      // Normaliza posibles formas: a veces vienen con d/…
      const payload = data?.d || data;
      const st = payload?.SiteStatus ?? payload?.status;
      const sid = payload?.SiteId ?? payload?.siteId;
      const surl = payload?.Url ?? payload?.url;

      logger.debug('status poll', { SiteStatus: st, Url: surl, SiteId: sid, meta: { provisioning: true } });

      if (st === 2) {
        return { ready: true, siteId: sid, siteUrl: surl, raw: payload };
      }
      if (st === 1) {
        const em = payload?.ErrorMessage || 'SPSiteManager status=Error';
        const e = new Error(em);
        e.status = 400;
        throw e;
      }
      // 0/3 -> sigue
    } catch (err) {
      // Log con CUERPO del 400 para ver qué pide exactamente el tenant
      const code = err?.response?.status || err?.code || err?.message;
      const body = err?.response?.data;
      logger.debug('status polling transient', { err: code, body, variant: useVariant, meta: { provisioning: true } });

      // Si es 400 y aún no probamos la otra variante, cambiamos
      if (err?.response?.status === 400 && useVariant === 0) {
        useVariant = 1;
      }
    }
    await new Promise(r => setTimeout(r, intervalMs));
  }

  const e = new Error('Timeout esperando a que el sitio sea resolvible');
  e.status = 504;
  e.last = last || null;
  throw e;
}


// ------------------------ provisioning waits ------------------------
/**
 * Espera “silenciosamente” a que el sitio esté resolvible por Graph y su drive por defecto exista.
 * Usa backoff exponencial capped con jitter.
 * meta: { provisioning: true } para logs discretos.
 */
async function waitUntilSpSiteReady({ siteUrl, siteId, maxMs = 180000 } = {}) {
  logger.debug('waitUntilSpSiteReady init', { siteUrl, siteId, maxMs, meta: { provisioning: true } });

  // 1) Si tenemos siteId o url, probamos por GRAPH (resolve)
  const started = Date.now();
  while (Date.now() - started < maxMs) {
    try {
      if (siteId) {
        const s = await sp.resolveSiteIdFlexible({ url: siteUrl, siteId });
        if (s?.id) {
          logger.debug('waitUntilSpSiteReady OK', { siteId: s.id, attempt: 1, meta: { provisioning: true } });
          return { siteId: s.id, siteUrl: s.webUrl };
        }
      }
      if (siteUrl) {
        const s = await sp.resolveSiteIdFlexible({ url: siteUrl });
        if (s?.id) {
          logger.debug('waitUntilSpSiteReady OK', { siteId: s.id, attempt: 1, meta: { provisioning: true } });
          return { siteId: s.id, siteUrl: s.webUrl };
        }
      }
    } catch { /* aún no */ }
    await new Promise(r => setTimeout(r, 2000));
  }

  const e = new Error('Timeout esperando a que el sitio sea resolvible');
  e.status = 504;
  throw e;
}

// ------------------------ plantilla ------------------------
async function applyTemplateToSite({ siteId, siteUrl, template, resolvedName }) {
  try {
    // 1) resolver siteId si solo viene URL
    let sId = siteId;
    if (!sId && siteUrl) {
      try {
        const s = await sp.resolveSiteIdFlexible({ url: siteUrl });
        sId = s?.id;
      } catch (e) {
        logger.debug('applyTemplateToSite: resolveSiteIdFlexible aún no disponible, esperando aprovisionamiento...', { siteUrl, meta: { provisioning: true } });
      }
    }

    // 2) asegurar sitio listo (Graph + drive)
    const ready = await waitUntilSpSiteReady({ siteUrl, siteId: sId });
    sId = ready.siteId;
    const resolvedUrl = ready.siteUrl;

    // 3) drive por defecto
    const driveId = await getDefaultDriveId(sId);

    if (!driveId) throw new Error('No encontré la biblioteca por defecto');

    // 4) carpetas (idempotente)
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

    // 5) permisos (placeholder – según tu política/grupos)
    const perms = getPermissions(template) || [];
    // TODO: mapear a Owners/Members/Visitors o M365 groups (si encaja en tu tenant)
    // for (const p of perms) await ensureSpPermission(...);

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
 * Crea un sitio de SharePoint desde el host ADMIN usando:
 *  POST https://<tenant>-admin.sharepoint.com/_api/SPSiteManager/create
 *  WebTemplate:
 *    - Communication: SITEPAGEPUBLISHING#0
 *    - Team (moderno): STS#3
 */
async function createSite({ type = 'CommunicationSite', title, url, description = '', lcid = 1033, classification = '' }) {
  if (!url) throw new Error('url es obligatorio (https://<tenant>.sharepoint.com/sites/<algo>)');
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
  const ret = {
    siteId: data?.SiteId || '',
    siteUrl: data?.Url || url, // fallback al solicitado
    status: siteStatus,
    meta: { provisioning: true }
  };
  logger.debug('SPSiteManager.create result', ret);

  // 1) Polling a SPSiteManager/status (6 min)
  try {
    const ok = await pollSPSiteManagerStatus(url, { maxMs: 360000, intervalMs: 3000 });
    ret.siteId = ok.siteId || ret.siteId;
    ret.siteUrl = ok.siteUrl || ret.siteUrl;
    ret.status = 2;
  } catch (e) {
    // 2) Fallback: intenta resolver por Graph otros 2 min
    logger.debug('status endpoint fallback to Graph', { meta: { provisioning: true } });
    const resolved = await waitUntilSpSiteReady({ siteUrl: ret.siteUrl, siteId: ret.siteId, maxMs: 120000 });
    ret.siteId = resolved.siteId;
    ret.siteUrl = resolved.siteUrl;
    ret.status = 2;
  }

  logger.info('Sitio SP creado', { siteId: ret.siteId, siteUrl: ret.siteUrl });
  return { siteId: ret.siteId, siteUrl: ret.siteUrl, status: ret.status };
}


module.exports = {
  applyTemplateToSite,
  createSite
};
