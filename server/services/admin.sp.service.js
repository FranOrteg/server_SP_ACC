// services/admin.sp.service.js

const logger = require('../helpers/logger').mk('SP');
const { graphGet, graphPost } = require('../clients/graphClient');
const { spoAdminPost } = require('../clients/spoClient');
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

// ------------------------ provisioning waits ------------------------
/**
 * Espera “silenciosamente” a que el sitio esté resolvible por Graph y su drive por defecto exista.
 * Usa backoff exponencial capped con jitter.
 * meta: { provisioning: true } para logs discretos.
 */
async function waitUntilSpSiteReady({ siteUrl, siteId, maxMs = 180000 }) {
  const started = Date.now();
  let attempt = 0;

  logger.debug('waitUntilSpSiteReady init', { siteUrl, siteId, maxMs, meta: { provisioning: true } });

  // 1) resolver siteId si solo tenemos URL
  let sId = siteId;
  while (!sId) {
    try {
      const s = await sp.resolveSiteIdFlexible({ url: siteUrl });
      sId = s?.id || null;
      if (sId) break;
    } catch (_) { /* silencioso */ }
    if (Date.now() - started > maxMs) throw new Error('Timeout esperando a que el sitio sea resolvible');
    await sleep(1000);
  }

  // 2) esperar drive por defecto
  while (true) {
    attempt++;
    try {
      const drv = await getDefaultDriveId(sId);
      if (drv) {
        logger.debug('waitUntilSpSiteReady OK', { siteId: sId, attempt, meta: { provisioning: true } });
        return sId;
      }
    } catch (_) { /* transitorio */ }

    const elapsed = Date.now() - started;
    if (elapsed > maxMs) {
      const err = new Error('Timeout esperando a que el drive por defecto exista');
      err.status = 504;
      throw err;
    }
    const backoff = Math.min(6000, 300 + attempt * 300 + Math.floor(Math.random() * 300));
    await sleep(backoff);
  }
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
    sId = await waitUntilSpSiteReady({ siteUrl, siteId: sId });

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
async function createSite({
  type = 'CommunicationSite',
  title,
  url,
  description = '',
  lcid = 1033,
  classification = ''
}) {
  if (!url) throw new Error('url es obligatorio (https://<tenant>.sharepoint.com/sites/<algo>)');

  const payload = {
    request: {
      Title: title || '',
      Url: url,
      Lcid: lcid,
      ShareByEmailEnabled: false,
      Classification: classification || null,
      WebTemplate: (type === 'TeamSite') ? 'STS#3' : 'SITEPAGEPUBLISHING#0',
      Description: description || ''
      // SiteDesignId: '00000000-0000-0000-0000-000000000000' // opcional si usas Site Design
    }
  };

  try {
    logger.info('Creando sitio SP', { type, url, title });
    const { data } = await spoAdminPost('/_api/SPSiteManager/create', payload);
    if (data?.ErrorMessage) {
      const err = new Error(`SPO create error: ${data.ErrorMessage}`);
      err.status = 400;
      throw err;
    }

    const siteUrl = data?.Url;
    const siteId = data?.SiteId;
    const status = data?.SiteStatus;

    logger.debug('SPSiteManager.create result', { siteId, siteUrl, status, meta: { provisioning: true } });

    // Espera silenciosa a que el sitio quede listo para Graph/Drive
    await waitUntilSpSiteReady({ siteUrl, siteId });

    logger.info('Sitio SP creado', { siteId, siteUrl });
    return { siteId, siteUrl, status };
  } catch (e) {
    throw mapAxiosError(e, 'create_site_failed');
  }
}

module.exports = {
  applyTemplateToSite,
  createSite
};
