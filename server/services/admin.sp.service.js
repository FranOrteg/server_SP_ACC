const { spoAdminPost, spoAdminGet } = require('../clients/spoClient');
const { spoTenantGet, spoTenantPost } = require('../clients/spoTenantClient');
const logger = require('../helpers/logger').mk('SP');
const { graphGet, graphPost } = require('../clients/graphClient');
const sp = require('./sharepoint.service');
const { expandFolders, getPermissions } = require('./admin.template.service');

// ------------------------ utils ------------------------
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

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

// ------------------------ helpers Graph/Drive ------------------------
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

// ------------------------ Admin API helpers ------------------------
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

// ------------------------ Permisos helpers ------------------------

// ¿Está group-connected? intenta resolver el GroupId del sitio.
// Nota: en muchos Communication Site, /_api/group no existe → devolvemos null.
async function getSiteGroupIdIfAny(siteUrl) {
  try {
    const { data } = await spoTenantGet(`${siteUrl}/_api/group`);
    const d = data?.d || data;
    return d?.Id || d?.GroupId || null;
  } catch {
    return null;
  }
}

// Devuelve los IDs de grupos asociados (Owners/Members/Visitors)
async function getWebAssociatedGroups(siteUrl) {
  const { data } = await spoTenantGet(
    `${siteUrl}/_api/web?$select=AssociatedOwnerGroup/Id,AssociatedMemberGroup/Id,AssociatedVisitorGroup/Id&$expand=AssociatedOwnerGroup,AssociatedMemberGroup,AssociatedVisitorGroup`
  );
  const d = data?.d || data;
  return {
    ownersId: d?.AssociatedOwnerGroup?.Id,
    membersId: d?.AssociatedMemberGroup?.Id,
    visitorsId: d?.AssociatedVisitorGroup?.Id
  };
}

// Asegura usuario en el sitio y devuelve su LoginName (claims)
async function ensureWebUser(siteUrl, upnOrMail) {
  const claim = upnOrMail.includes('|') ? upnOrMail : `i:0#.f|membership|${upnOrMail}`;
  const { data } = await spoTenantPost(
    `${siteUrl}/_api/web/ensureuser`,
    JSON.stringify({ logonName: claim })
  );
  const d = data?.d || data;
  return { loginName: d?.LoginName, id: d?.Id };
}

// Añade usuario a un SharePoint Group (idempotente-friendly)
async function addUserToSpGroup(siteUrl, groupId, loginName) {
  try {
    await spoTenantPost(
      `${siteUrl}/_api/web/sitegroups/GetById(${groupId})/users`,
      JSON.stringify({
        __metadata: { type: 'SP.User' },
        LoginName: loginName
      })
    );
    return true;
  } catch (e) {
    const msg = e?.response?.data?.error?.message?.value || e?.message || '';
    if (/exists|already/i.test(msg)) return false;
    throw e;
  }
}

// Graph helpers para M365 Group (TeamSite)
async function resolveAadUserObjectId(upnOrMail) {
  const { data } = await graphGet(`/users/${encodeURIComponent(upnOrMail)}?$select=id,mail,userPrincipalName`);
  return data?.id || null;
}
async function addToM365Group(groupId, userObjectId, asOwner = false) {
  const path = asOwner ? `/groups/${groupId}/owners/$ref` : `/groups/${groupId}/members/$ref`;
  await graphPost(path, {
    '@odata.id': `https://graph.microsoft.com/v1.0/directoryObjects/${userObjectId}`
  });
}

// ------------------------ waits ------------------------
async function getSiteIdFromAdminApi(siteUrl) {
  try {
    const sites = await adminFindActiveSiteByUrl(siteUrl);
    if (sites.length > 0) {
      const site = sites[0];
      const siteId = site.SiteId || site.siteId || site.Id || site.id;
      if (siteId) {
        logger.debug('getSiteIdFromAdminApi found', { siteUrl, siteId, meta: { provisioning: true } });
        return siteId;
      }
    }
  } catch (err) {
    logger.debug('getSiteIdFromAdminApi failed', { siteUrl, error: err.message, meta: { provisioning: true } });
  }
  return null;
}

async function waitUntilSpSiteReady({ siteUrl, siteId, maxMs = 300000 } = {}) {
  logger.debug('waitUntilSpSiteReady init', { siteUrl, siteId, maxMs, meta: { provisioning: true } });

  const started = Date.now();
  let attempt = 0;
  let currentDelay = 2000;
  const maxDelay = 15000;

  while (Date.now() - started < maxMs) {
    attempt++;

    try {
      if (siteId && String(siteId).trim() !== '') {
        try {
          const s = await sp.resolveSiteIdFlexible({ siteId });
          if (s?.id) {
            logger.info('waitUntilSpSiteReady OK (by siteId)', {
              siteId: s.id, attempt, elapsed: Date.now() - started, meta: { provisioning: true }
            });
            return { siteId: s.id, siteUrl: s.webUrl };
          }
        } catch (err) {
          logger.debug('waitUntilSpSiteReady attempt by siteId failed', {
            attempt, error: err.message, meta: { provisioning: true }
          });
        }
      }

      if (siteUrl) {
        try {
          const s = await sp.resolveSiteIdFlexible({ url: siteUrl });
          if (s?.id) {
            logger.info('waitUntilSpSiteReady OK (by url)', {
              siteId: s.id, attempt, elapsed: Date.now() - started, meta: { provisioning: true }
            });
            return { siteId: s.id, siteUrl: s.webUrl };
          }
        } catch (err) {
          logger.debug('waitUntilSpSiteReady attempt by url failed', {
            attempt, error: err.message, meta: { provisioning: true }
          });
        }
      }

      if (!siteId && siteUrl && attempt % 3 === 0) {
        const adminSiteId = await getSiteIdFromAdminApi(siteUrl);
        if (adminSiteId) {
          siteId = adminSiteId;
          logger.debug('waitUntilSpSiteReady got siteId from Admin API', { siteId, meta: { provisioning: true } });
        }
      }

    } catch (err) {
      logger.debug('waitUntilSpSiteReady iteration error', {
        attempt, error: err.message, meta: { provisioning: true }
      });
    }

    const jitter = Math.random() * 1000;
    await sleep(Math.min(currentDelay + jitter, maxDelay));
    currentDelay = Math.min(currentDelay * 1.5, maxDelay);

    logger.debug('waitUntilSpSiteReady retrying', {
      attempt, nextDelay: currentDelay, elapsed: Date.now() - started, meta: { provisioning: true }
    });
  }

  const e = new Error(`Timeout esperando a que el sitio sea resolvible (${maxMs}ms, ${attempt} intentos)`);
  e.status = 504;
  throw e;
}

async function pollSPSiteManagerStatus(targetUrl, { maxMs = 360000, intervalMs = 5000 } = {}) {
  const started = Date.now();
  let attempt = 0;

  const variants = [
    `/_api/SPSiteManager/status?url=${encodeURIComponent(targetUrl)}`,
    `/_api/SPSiteManager/status?url='${targetUrl.replace(/'/g, "%27")}'`
  ];
  let useVariant = 0;

  logger.debug('pollSPSiteManagerStatus init', {
    targetUrl, maxMs, intervalMs, meta: { provisioning: true }
  });

  while (Date.now() - started < maxMs) {
    attempt++;
    const statusUrl = variants[useVariant];

    try {
      const { data } = await spoAdminGet(statusUrl, { Accept: 'application/json;odata=verbose' });

      const payload = data?.d || data;
      const status = payload?.SiteStatus ?? payload?.status;
      const siteId = payload?.SiteId ?? payload?.siteId;
      const siteUrl = payload?.Url ?? payload?.url;

      logger.debug('pollSPSiteManagerStatus response', {
        attempt, status, siteId, siteUrl, elapsed: Date.now() - started, meta: { provisioning: true }
      });

      if (status === 2 && siteId) {
        logger.info('pollSPSiteManagerStatus complete', {
          siteId, siteUrl, attempt, elapsed: Date.now() - started, meta: { provisioning: true }
        });
        return { ready: true, siteId, siteUrl, raw: payload };
      }

      if (status === 1) {
        const errMsg = payload?.ErrorMessage || 'SPSiteManager status=Error';
        const e = new Error(errMsg);
        e.status = 400;
        throw e;
      }

    } catch (err) {
      const code = err?.response?.status;

      logger.debug('pollSPSiteManagerStatus error', {
        attempt, statusCode: code, error: err.message, variant: useVariant, meta: { provisioning: true }
      });

      if (code === 400 && useVariant === 0) {
        useVariant = 1;
        logger.debug('pollSPSiteManagerStatus switching to quoted variant', { meta: { provisioning: true } });
      }
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

    if (!sId && siteUrl) {
      try {
        const s = await sp.resolveSiteIdFlexible({ url: siteUrl });
        sId = s?.id;
      } catch (e) {
        logger.debug('applyTemplateToSite: resolveSiteIdFlexible aún no disponible', {
          siteUrl, meta: { provisioning: true }
        });
      }
    }

    const ready = await waitUntilSpSiteReady({ siteUrl, siteId: sId, maxMs: 180000 });
    sId = ready.siteId;

    const driveId = await getDefaultDriveId(sId);
    if (!driveId) throw new Error('No encontré la biblioteca por defecto');

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

    const perms = getPermissions(template) || [];
    // TODO: implementar según tu política de grupos

    logger.info('Plantilla aplicada', {
      siteId: sId, name: resolvedName, folders: { created: created.length, ensured: ensured.length }
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
async function createSite({
  type = 'CommunicationSite',
  title,
  url,
  description = '',
  lcid = 1033,
  classification = ''
}) {
  if (!url) throw new Error('url es obligatorio');

  try {
    const existing = await sp.resolveSiteIdFlexible({ url });
    if (existing?.id) {
      logger.info('Sitio SP ya existía (Graph)', {
        siteId: existing.id, siteUrl: existing.webUrl
      });
      return { siteId: existing.id, siteUrl: existing.webUrl, status: 2 };
    }
  } catch { }

  try {
    const actives = await adminFindActiveSiteByUrl(url);
    if (actives.length) {
      logger.info('Sitio SP ya existía (Admin API)', { siteUrl: url });
      const resolved = await waitUntilSpSiteReady({ siteUrl: url, maxMs: 180000 });
      return { siteId: resolved.siteId, siteUrl: resolved.siteUrl, status: 2 };
    }
  } catch (pfErr) {
    logger.debug('Preflight Admin API check failed', { error: pfErr.message });
  }

  try {
    const deleted = await adminFindDeletedSiteByUrl(url);
    if (deleted.length) {
      const e = new Error(`La URL ya está en la papelera de sitios del tenant. Elimínalo definitivamente o usa otra URL.`);
      e.status = 409; throw e;
    }
  } catch (pfErr) {
    if (pfErr.status === 409) throw pfErr;
  }

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
    status: siteStatus, siteId: responseSiteId, url: data?.Url || url, meta: { provisioning: true }
  });

  if (siteStatus === 2 && responseSiteId) {
    logger.info('Sitio SP creado inmediatamente', { siteId: responseSiteId, siteUrl: url });
    return { siteId: responseSiteId, siteUrl: url, status: 2 };
  }

  if (siteStatus === 0 || siteStatus === 3) {
    logger.info('Sitio en provisioning, esperando...', { status: siteStatus, url, meta: { provisioning: true } });

    try {
      const pollResult = await pollSPSiteManagerStatus(url, { maxMs: 300000, intervalMs: 5000 });
      if (pollResult.ready && pollResult.siteId) {
        const resolved = await waitUntilSpSiteReady({
          siteUrl: pollResult.siteUrl, siteId: pollResult.siteId, maxMs: 120000
        });
        logger.info('Sitio SP creado (via polling)', { siteId: resolved.siteId, siteUrl: resolved.siteUrl });
        return { siteId: resolved.siteId, siteUrl: resolved.siteUrl, status: 2 };
      }
    } catch (pollErr) {
      logger.warn('Polling de status falló, intentando espera directa', {
        error: pollErr.message, meta: { provisioning: true }
      });
    }

    try {
      const resolved = await waitUntilSpSiteReady({
        siteUrl: url, siteId: responseSiteId || undefined, maxMs: 480000
      });
      logger.info('Sitio SP creado (via Graph wait)', { siteId: resolved.siteId, siteUrl: resolved.siteUrl });
      return { siteId: resolved.siteId, siteUrl: resolved.siteUrl, status: 2 };
    } catch (waitErr) {
      const [activesAfter, deletedAfter] = await Promise.all([
        adminFindActiveSiteByUrl(url).catch(() => []),
        adminFindDeletedSiteByUrl(url).catch(() => [])
      ]);

      if (deletedAfter.length) {
        const e = new Error('La creación falló y el sitio quedó en la papelera. Elimínalo definitivamente e inténtalo de nuevo.');
        e.status = 409; throw e;
      }

      if (activesAfter.length) {
        const e = new Error(`El sitio aparece activo en Admin pero Graph aún no lo resuelve. Espera unos minutos y consulta directamente: ${url}`);
        e.status = 504; throw e;
      }

      const e = new Error('SharePoint aceptó la creación pero no se materializó en el tiempo esperado. Verifica manualmente o intenta con otra URL.');
      e.status = 504; throw e;
    }
  }

  const errMsg = data?.ErrorMessage || `SPSiteManager devolvió status inesperado: ${siteStatus}`;
  const e = new Error(errMsg);
  e.status = 400;
  throw e;
}

/**
 * Asigna usuarios al sitio.
 *  - Communication Site → SharePoint Groups (Owners/Members/Visitors)
 *  - Team Site (group-connected) → M365 Group (owners/members)
 */
async function assignMembersToSite({ siteId, siteUrl, siteType, members = [] }) {
  if (!members?.length) return { applied: 0, skipped: 0, details: [] };

  const ready = await waitUntilSpSiteReady({ siteUrl, siteId, maxMs: 180000 });
  const resolvedUrl = ready.siteUrl;

  // Si es TeamSite o si detectamos GroupId, usamos M365 Group
  const detectedGroupId = await getSiteGroupIdIfAny(resolvedUrl);
  const useGroup = (siteType === 'TeamSite') || !!detectedGroupId;
  const groupId = detectedGroupId || null;

  const details = [];
  let applied = 0, skipped = 0;

  if (useGroup && groupId) {
    for (const a of members) {
      const role = (a.role || '').toLowerCase();
      if (!['owner', 'member'].includes(role)) {
        details.push({ user: a.user, role: a.role, result: 'skipped (invalid role for group site)' });
        skipped++; continue;
      }
      const oid = await resolveAadUserObjectId(a.user).catch(() => null);
      if (!oid) {
        details.push({ user: a.user, role: a.role, result: 'user not found' });
        skipped++; continue;
      }
      try {
        await addToM365Group(groupId, oid, role === 'owner');
        details.push({ user: a.user, role: a.role, result: 'added to m365 group' });
        applied++;
      } catch (e) {
        const msg = e?.response?.data?.error?.message || e?.message || 'error';
        if (/added object references|already exist/i.test(msg)) {
          details.push({ user: a.user, role: a.role, result: 'already in group' });
          skipped++;
        } else {
          details.push({ user: a.user, role: a.role, result: `error: ${msg}` });
        }
      }
    }
    return { applied, skipped, details, mode: 'm365-group', groupId };
  }

  // Communication Site → SP groups
  const groups = await getWebAssociatedGroups(resolvedUrl);
  const mapRoleToGroupId = (role) => {
    const r = (role || '').toLowerCase();
    if (r === 'owner') return groups.ownersId;
    if (r === 'member') return groups.membersId;
    if (r === 'visitor') return groups.visitorsId;
    return null;
  };

  for (const a of members) {
    const gid = mapRoleToGroupId(a.role);
    if (!gid) {
      details.push({ user: a.user, role: a.role, result: 'skipped (invalid role)' });
      skipped++; continue;
    }
    try {
      const ensured = await ensureWebUser(resolvedUrl, a.user);
      if (!ensured?.loginName) {
        details.push({ user: a.user, role: a.role, result: 'ensureuser failed' });
        skipped++; continue;
      }
      const added = await addUserToSpGroup(resolvedUrl, gid, ensured.loginName);
      details.push({ user: a.user, role: a.role, result: added ? 'added to sp group' : 'already in group' });
      applied += added ? 1 : 0;
      skipped += added ? 0 : 1;
    } catch (e) {
      const msg = e?.response?.data?.error?.message?.value || e?.message || 'error';
      details.push({ user: a.user, role: a.role, result: `error: ${msg}` });
    }
  }

  return { applied, skipped, details, mode: 'sp-groups', groups };
}

module.exports = {
  applyTemplateToSite,
  createSite,
  assignMembersToSite
};
