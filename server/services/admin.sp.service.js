const { spoAdminPost, spoAdminGet } = require('../clients/spoClient');
const { spoTenantGet, spoTenantPost, spoTenantMerge } = require('../clients/spoTenantClient');
const logger = require('../helpers/logger').mk('SP');
const { graphGet, graphPost, graphPatch, graphDelete } = require('../clients/graphClient');
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

// ---------------------------- helpers quitar usuarios (Communication Site) -----------------------------
async function removeUserFromSpGroup(siteUrl, groupId, loginName) {
  // SharePoint REST: POST a removeByLoginName(@v)?@v='<loginName>'
  // loginName suele tener '#' y '@'; hay que encodear bien la comilla simple:
  const encoded = encodeURIComponent(`'${loginName}'`);
  const url = `${siteUrl}/_api/web/sitegroups/GetById(${groupId})/users/removeByLoginName(@v)?@v=${encoded}`;
  // No requiere cuerpo; método POST
  await spoTenantPost(url, null, { 'X-RequestDigest': 'context' }).catch(() => { }); // algunos tenants no requieren digest en app-only
  return true;
}

async function getSpGroupUsers(siteUrl, groupId) {
  const { data } = await spoTenantGet(
    `${siteUrl}/_api/web/sitegroups/GetById(${groupId})/users` +
    `?$select=Id,Title,Email,LoginName,PrincipalType,IsHiddenInUI`
  );
  const arr = data?.d?.results || data?.d?.Users?.results || data?.value || [];

  // PrincipalType:
  // 1=User, 2=DistributionList, 4=SharePointGroup, 8=SecurityGroup, 16=Unknown...
  return arr
    .filter(u =>
      u.PrincipalType === 1 || u.PrincipalType === 8 // solo usuarios y (opcional) security groups AAD
    )
    .filter(u => u.LoginName !== 'SHAREPOINT\\system' && !u.IsHiddenInUI)
    .map(u => ({
      id: u.Id,
      title: u.Title,
      email: u.Email,
      loginName: u.LoginName,
      principalType: u.PrincipalType
    }));
}

// ---- listar miembros actuales del sitio ----
async function getSiteMembers({ siteUrl, format } = {}) {
  // 1) ¿El sitio está conectado a un Microsoft 365 Group?
  const m365GroupId = await getSiteGroupIdIfAny(siteUrl);

  if (m365GroupId) {
    // --- Team Site (group-connected) → Graph ---
    const ownersRes = await graphGet(
      `/groups/${m365GroupId}/owners?$select=id,displayName,mail,userPrincipalName&$top=999`
    ).catch(() => ({ data: { value: [] } }));

    const membersRes = await graphGet(
      `/groups/${m365GroupId}/members?$select=id,displayName,mail,userPrincipalName&$top=999`
    ).catch(() => ({ data: { value: [] } }));

    const owners = (ownersRes?.data?.value || [])
      .filter(x => (x['@odata.type'] || '').toLowerCase().includes('user') || x.userPrincipalName)
      .map(u => ({
        id: u.id,
        title: u.displayName,
        email: u.mail || u.userPrincipalName || '',
        loginName: u.userPrincipalName || u.mail || '',
        principalType: 1
      }));

    const membersRaw = (membersRes?.data?.value || [])
      .filter(x => (x['@odata.type'] || '').toLowerCase().includes('user') || x.userPrincipalName)
      .map(u => ({
        id: u.id,
        title: u.displayName,
        email: u.mail || u.userPrincipalName || '',
        loginName: u.userPrincipalName || u.mail || '',
        principalType: 1
      }));

    // Quitar de members los que ya son owners
    const ownerIds = new Set(owners.map(o => o.id));
    const members = membersRaw.filter(m => !ownerIds.has(m.id));

    // Respuesta "plana" opcional para el UI
    if (String(format).toLowerCase() === 'flat') {
      const withRole = (arr, role) => arr.map(u => ({ ...u, role }));
      const users = [...withRole(owners, 'Owner'), ...withRole(members, 'Member')];
      return { mode: 'm365-group', groupId: m365GroupId, users };
    }

    // Respuesta estructurada por roles
    return { mode: 'm365-group', groupId: m365GroupId, owners, members, visitors: [] };
  }

  // 2) Communication Site → SharePoint Groups
  const groups = await getWebAssociatedGroups(siteUrl);
  const [owners, members, visitors] = await Promise.all([
    groups.ownersId ? getSpGroupUsers(siteUrl, groups.ownersId) : [],
    groups.membersId ? getSpGroupUsers(siteUrl, groups.membersId) : [],
    groups.visitorsId ? getSpGroupUsers(siteUrl, groups.visitorsId) : []
  ]);

  if (String(format).toLowerCase() === 'flat') {
    const withRole = (arr, role) => arr.map(u => ({ ...u, role }));
    const users = [
      ...withRole(owners, 'Owner'),
      ...withRole(members, 'Member'),
      ...withRole(visitors, 'Visitor')
    ];
    return { mode: 'sp-groups', groups, users };
  }

  return { mode: 'sp-groups', groups, owners, members, visitors };
}



// ---- quitar miembros (Communication / Group-connected) ----
async function removeMembersFromSite({ siteId, siteUrl, removals = [] }) {
  if (!removals?.length) return { removed: 0, skipped: 0, details: [] };

  const ready = await waitUntilSpSiteReady({ siteUrl, siteId, maxMs: 180000 });
  const resolvedUrl = ready.siteUrl;

  // ¿Team Site con M365 Group?
  const m365GroupId = await getSiteGroupIdIfAny(resolvedUrl);
  const details = [];
  let removed = 0, skipped = 0;

  if (m365GroupId) {
    for (const r of removals) {
      const role = (r.role || '').toLowerCase(); // owner|member
      if (!['owner', 'member'].includes(role)) {
        details.push({ user: r.user, role: r.role, result: 'skipped (invalid role for group site)' });
        skipped++; continue;
      }
      const oid = await resolveAadUserObjectId(r.user).catch(() => null);
      if (!oid) {
        details.push({ user: r.user, role: r.role, result: 'user not found' });
        skipped++; continue;
      }
      try {
        const path = role === 'owner'
          ? `/groups/${m365GroupId}/owners/${oid}/$ref`
          : `/groups/${m365GroupId}/members/${oid}/$ref`;
        await graphDelete(path);
        details.push({ user: r.user, role: r.role, result: 'removed from m365 group' });
        removed++;
      } catch (e) {
        const msg = e?.response?.data?.error?.message || e?.message || 'error';
        if (/does not exist|is not an owner|is not a member/i.test(msg)) {
          details.push({ user: r.user, role: r.role, result: 'not in group' });
          skipped++;
        } else {
          throw e;
        }
      }
    }
    return { removed, skipped, details, mode: 'm365-group' };
  }

  // Communication Site → quitar de grupos SP
  const groups = await getWebAssociatedGroups(resolvedUrl);
  const mapRoleToGroupId = (role) => {
    const r = (role || '').toLowerCase();
    if (r === 'owner') return groups.ownersId;
    if (r === 'member') return groups.membersId;
    if (r === 'visitor') return groups.visitorsId;
    return null;
  };

  for (const r of removals) {
    const gid = mapRoleToGroupId(r.role);
    if (!gid) {
      details.push({ user: r.user, role: r.role, result: 'skipped (invalid role)' });
      skipped++; continue;
    }
    try {
      // necesitamos el LoginName en el sitio
      const ensured = await ensureWebUser(resolvedUrl, r.user).catch(() => null);
      const loginName = ensured?.loginName || r.user; // fallback conservador
      await removeUserFromSpGroup(resolvedUrl, gid, loginName);
      details.push({ user: r.user, role: r.role, result: 'removed from sp group' });
      removed++;
    } catch (e) {
      const msg = e?.response?.data?.error?.message?.value || e?.message || 'error';
      if (/does not exist|not found/i.test(msg)) {
        details.push({ user: r.user, role: r.role, result: 'not in group' });
        skipped++;
      } else {
        throw e;
      }
    }
  }

  return { removed, skipped, details, mode: 'sp-groups' };
}

async function removeFromM365Group(groupId, userObjectId, fromOwner = false) {
  const rolePath = fromOwner ? 'owners' : 'members';
  // DELETE /groups/{id}/{owners|members}/{id}/$ref
  const { graphDelete } = require('../clients/graphClient');
  await graphDelete(`/groups/${groupId}/${rolePath}/${userObjectId}/$ref`);
}


// ------------------------ Permisos helpers ------------------------

// ¿Está group-connected? intenta resolver el GroupId del sitio.
// Nota: en muchos Communication Site, /_api/group no existe → devolvemos null.
async function getSiteGroupIdIfAny(siteIdOrUrl) {
  try {
    const siteUrl = typeof siteIdOrUrl === 'string' && siteIdOrUrl.startsWith('http')
      ? siteIdOrUrl
      : null;
    if (!siteUrl) return null;

    // Este endpoint existe en Team Sites conectados a M365 Group
    const { data } = await spoTenantGet(`${siteUrl}/_api/site?$select=GroupId`);
    const d = data?.d || data;
    const gid = d?.GroupId || d?.groupId || null;

    // Guid.Empty => no hay M365 Group
    if (!gid || /^0{8}-0{4}-0{4}-0{4}-0{12}$/i.test(gid)) return null;
    return String(gid);
  } catch {
    return null;
  }
}


// Devuelve los IDs de grupos asociados (Owners/Members/Visitors) con fallback robusto
async function getWebAssociatedGroups(siteUrl) {
  // 1) intento rápido (todo en una query)
  try {
    const { data } = await spoTenantGet(
      `${siteUrl}/_api/web?$select=AssociatedOwnerGroup/Id,AssociatedMemberGroup/Id,AssociatedVisitorGroup/Id&$expand=AssociatedOwnerGroup,AssociatedMemberGroup,AssociatedVisitorGroup`,
      { Accept: 'application/json;odata=nometadata' } // más estable
    );
    const d = data?.d || data;
    const ownersId = d?.AssociatedOwnerGroup?.Id ?? null;
    const membersId = d?.AssociatedMemberGroup?.Id ?? null;
    const visitorsId = d?.AssociatedVisitorGroup?.Id ?? null;

    if (ownersId || membersId || visitorsId) {
      return { ownersId, membersId, visitorsId };
    }
  } catch (_) {
    // si falla seguimos con el fallback
  }

  // 2) fallback robusto: pedir cada grupo por separado
  async function getId(endpoint) {
    try {
      const { data } = await spoTenantGet(
        `${siteUrl}/_api/web/${endpoint}?$select=Id`,
        { Accept: 'application/json;odata=nometadata' }
      );
      const d = data?.d || data;
      return d?.Id ?? null;
    } catch { return null; }
  }

  const [ownersId, membersId, visitorsId] = await Promise.all([
    getId('AssociatedOwnerGroup'),
    getId('AssociatedMemberGroup'),
    getId('AssociatedVisitorGroup')
  ]);

  return { ownersId, membersId, visitorsId };
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

/**
 * Crea un Team Site con Microsoft 365 Group asociado usando Graph API
 * @param {Object} params
 * @param {string} params.displayName - Nombre del sitio/grupo
 * @param {string} params.mailNickname - Alias de correo (solo caracteres alfanuméricos, sin espacios)
 * @param {string} params.description - Descripción
 * @param {Array} params.owners - Array de emails de propietarios
 * @returns {Promise<{groupId: string, siteUrl: string, siteId: string}>}
 */
async function createTeamSiteWithGroup({ displayName, mailNickname, description = '', owners = [] }) {
  logger.info('Creando Team Site con M365 Group', { displayName, mailNickname, owners });

  // 1. Crear el grupo de Microsoft 365 con sitio de SharePoint
  // Nota: La creación automática de SharePoint se activa con groupTypes: ["Unified"]
  const groupPayload = {
    displayName,
    mailNickname,
    description: description || displayName,
    mailEnabled: true,
    securityEnabled: false,
    groupTypes: ["Unified"],
    visibility: "Private" // o "Public" según necesites
  };

  const { data: group } = await graphPost('/groups', groupPayload);
  const groupId = group.id;

  logger.debug('Grupo M365 creado', { groupId, displayName });

  // 2. Agregar propietarios al grupo
  // Nota: Necesitamos esperar un momento para que el grupo esté completamente provisionado
  await sleep(2000);
  
  if (owners && owners.length > 0) {
    for (const ownerEmail of owners) {
      try {
        const oid = await resolveAadUserObjectId(ownerEmail);
        if (oid) {
          // Primero agregar como member (requerido antes de agregar como owner)
          try {
            await addToM365Group(groupId, oid, false); // false = member
          } catch (memberErr) {
            // Ignorar si ya es member
            const msg = memberErr?.response?.data?.error?.message || '';
            if (!/already exist/i.test(msg)) {
              logger.debug('Error agregando como member (puede ser esperado)', { ownerEmail, error: memberErr.message });
            }
          }
          
          // Luego agregar como owner
          await addToM365Group(groupId, oid, true); // true = owner
          logger.debug('Owner agregado al grupo', { groupId, ownerEmail });
        }
      } catch (e) {
        const msg = e?.response?.data?.error?.message || e?.message || '';
        if (/already exist/i.test(msg)) {
          logger.debug('Owner ya existía en el grupo', { ownerEmail });
        } else {
          logger.warn('No se pudo agregar owner', { ownerEmail, error: msg });
        }
      }
    }
  }

  // 3. Esperar a que SharePoint provisione el sitio asociado
  // El sitio puede tardar unos minutos en estar disponible
  let siteUrl = null;
  let siteId = null;
  const maxAttempts = 30;
  const delayMs = 5000;

  for (let i = 0; i < maxAttempts; i++) {
    try {
      const { data: site } = await graphGet(`/groups/${groupId}/sites/root?$select=id,webUrl`);
      if (site?.webUrl) {
        siteUrl = site.webUrl;
        siteId = site.id;
        logger.info('Sitio SharePoint del grupo provisionado', { groupId, siteUrl, siteId });
        break;
      }
    } catch (e) {
      if (i < maxAttempts - 1) {
        logger.debug(`Esperando provisionamiento del sitio (intento ${i + 1}/${maxAttempts})`, { groupId });
        await sleep(delayMs);
      } else {
        throw new Error(`El sitio SharePoint no se provisionó después de ${maxAttempts} intentos. GroupId: ${groupId}`);
      }
    }
  }

  return { groupId, siteUrl, siteId };
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

// ------------ Configurar límite de versiones de biblioteca ----------

/**
 * Configura el límite de versiones principales de la biblioteca de documentos
 * de un sitio SP mediante SharePoint REST API.
 *
 * Usa BaseTemplate=101 para localizar la document library principal,
 * independientemente del idioma ("Documents", "Documentos", etc.).
 *
 * SP REST API:
 *   GET  {siteUrl}/_api/web/lists?$filter=BaseTemplate eq 101
 *   POST {siteUrl}/_api/web/lists(guid'{listId}')  (X-HTTP-Method: MERGE)
 *
 * @param {string} siteUrl          URL absoluta del sitio (ej: https://tenant.sharepoint.com/sites/PRJ-X)
 * @param {number} [versionLimit=5] Número máximo de versiones principales
 * @returns {{ success: boolean, listId?: string, library?: string, versionLimit?: number, error?: string }}
 */
async function configureVersionLimit(siteUrl, versionLimit = 5) {
  if (!siteUrl) {
    logger.warn('configureVersionLimit: siteUrl no proporcionado');
    return { success: false, error: 'siteUrl es obligatorio' };
  }

  // Normalizar URL (quitar trailing slash)
  const baseUrl = siteUrl.replace(/\/+$/, '');

  try {
    // 1. Obtener bibliotecas de documentos (BaseTemplate 101 = Document Library)
    const { data: listsData } = await spoTenantGet(
      `${baseUrl}/_api/web/lists?$filter=BaseTemplate eq 101&$select=Id,Title,BaseTemplate,ItemCount`
    );

    const lists = listsData?.value || [];
    if (!lists.length) {
      logger.warn('configureVersionLimit: No se encontraron document libraries', { siteUrl });
      return { success: false, error: 'No document libraries found' };
    }

    // Tomar la primera document library (normalmente "Documents" / "Documentos")
    const docLib = lists[0];
    const listGuid = docLib.Id;

    logger.debug('Document library encontrada', {
      siteUrl, listId: listGuid, title: docLib.Title, itemCount: docLib.ItemCount
    });

    // 2. Actualizar MajorVersionLimit via SP REST API (MERGE)
    await spoTenantMerge(
      `${baseUrl}/_api/web/lists(guid'${listGuid}')`,
      {
        __metadata: { type: 'SP.List' },
        EnableVersioning: true,
        MajorVersionLimit: versionLimit
      }
    );

    logger.info('Límite de versiones configurado correctamente', {
      siteUrl, listId: listGuid, library: docLib.Title, versionLimit
    });

    return { success: true, listId: listGuid, library: docLib.Title, versionLimit };
  } catch (e) {
    const detail =
      e?.response?.data?.error?.message?.value ||
      e?.response?.data?.error?.message ||
      e?.response?.data?.['odata.error']?.message?.value ||
      e?.message || 'unknown';
    logger.warn('Error configurando límite de versiones', {
      siteUrl, error: detail, status: e?.response?.status
    });
    return { success: false, error: detail };
  }
}

// ------------------------ creación de sitio ------------------------
async function createSite({
  type = 'CommunicationSite',
  title,
  url,
  description = '',
  lcid = 1033,
  classification = '',
  members = []  // <-- Nuevo parámetro para propietarios
}) {
  if (!url) throw new Error('url es obligatorio');

  // === NUEVO: Manejar TeamSiteWithGroup con Microsoft 365 Group ===
  if (type === 'TeamSiteWithGroup') {
    logger.info('Creando Team Site con M365 Group', { url, title });
    
    // Extraer propietarios del array de members
    const owners = (members || [])
      .filter(m => (m.role || '').toLowerCase() === 'owner')
      .map(m => m.user)
      .filter(Boolean);

    if (owners.length === 0) {
      throw new Error('TeamSiteWithGroup requiere al menos un propietario (role: "Owner") en members[]');
    }

    // Extraer mailNickname de la URL (parte después de /sites/)
    const urlParts = url.split('/sites/');
    if (urlParts.length < 2) {
      throw new Error('URL inválida para Team Site. Formato esperado: https://tenant.sharepoint.com/sites/sitename');
    }
    const mailNickname = urlParts[1].replace(/\//g, ''); // Remover cualquier slash adicional

    // Crear el grupo y el sitio
    const result = await createTeamSiteWithGroup({
      displayName: title,
      mailNickname,
      description,
      owners
    });

    logger.info('Team Site con M365 Group creado exitosamente', result);
    return { siteId: result.siteId, siteUrl: result.siteUrl, status: 2, groupId: result.groupId };
  }

  // === FIN NUEVO ===

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

  // === MODIFICADO: Determinar Owner según el tipo de sitio ===
  // El campo Owner debe ser siempre un email/UPN válido de usuario
  let siteOwner;
  
  // Buscar el primer owner en members[]
  const owners = (members || [])
    .filter(m => (m.role || '').toLowerCase() === 'owner')
    .map(m => m.user)
    .filter(Boolean);
  
  if (owners.length > 0) {
    // Usar el primer owner como propietario principal del sitio
    siteOwner = owners[0];
    logger.debug('Usando primer owner de members[] como propietario del sitio', { siteOwner });
  } else {
    // Fallback a variable de entorno
    siteOwner = process.env.SPO_SITE_OWNER || undefined;
    if (siteOwner) {
      logger.debug('Usando SPO_SITE_OWNER como propietario del sitio', { siteOwner });
    }
  }
  // === FIN MODIFICADO ===

  const payload = {
    request: {
      Title: title || '',
      Url: url,
      Lcid: lcid,
      ShareByEmailEnabled: false,
      Classification: classification || null,
      WebTemplate: (type === 'TeamSite') ? 'STS#3' : 'SITEPAGEPUBLISHING#0',
      Description: description || '',
      Owner: siteOwner
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
async function assignMembersToSite({ siteId, siteUrl, assignments = [], remove = [] }) {
  if (!(assignments?.length || remove?.length)) {
    return { applied: 0, skipped: 0, details: [] };
  }

  const ready = await waitUntilSpSiteReady({ siteUrl, siteId, maxMs: 180000 });
  const resolvedUrl = ready.siteUrl;
  const m365GroupId = await getSiteGroupIdIfAny(resolvedUrl);

  const details = [];
  let applied = 0, skipped = 0;

  if (m365GroupId) {
    // ADD
    for (const a of (assignments || [])) {
      const role = (a.role || '').toLowerCase(); // owner|member
      if (!['owner', 'member'].includes(role)) {
        details.push({ user: a.user, role: a.role, result: 'skipped (invalid role for group site)' });
        skipped++; continue;
      }
      const oid = await resolveAadUserObjectId(a.user).catch(() => null);
      if (!oid) { details.push({ user: a.user, role: a.role, result: 'user not found' }); skipped++; continue; }
      try {
        await addToM365Group(m365GroupId, oid, role === 'owner');
        details.push({ user: a.user, role: a.role, result: 'added to m365 group' });
        applied++;
      } catch (e) {
        const msg = e?.response?.data?.error?.message || e?.message || '';
        if (/already exist/i.test(msg)) {
          details.push({ user: a.user, role: a.role, result: 'already in group' });
          skipped++;
        } else {
          throw e;
        }
      }
    }
    // REMOVE
    for (const r of (remove || [])) {
      const role = (r.role || '').toLowerCase(); // owner|member
      if (!['owner', 'member'].includes(role)) {
        details.push({ user: r.user, role: r.role, result: 'skipped (invalid role for group site)' });
        skipped++;
        continue;
      }
      const oid = await resolveAadUserObjectId(r.user).catch(() => null);
      if (!oid) {
        details.push({ user: r.user, role: r.role, result: 'user not found' });
        skipped++;
        continue;
      }

      try {
        // Si piden quitar Owner, primero quitamos de owners y además de members.
        if (role === 'owner') {
          // Quitar de owners
          await removeFromM365Group(m365GroupId, oid, /*fromOwner*/ true).catch(e => {
            const msg = e?.response?.data?.error?.message || e?.message || '';
            if (!/cannot find|does not exist/i.test(msg)) throw e;
          });
          // Quitar de members (owners también son members)
          await removeFromM365Group(m365GroupId, oid, /*fromOwner*/ false).catch(e => {
            const msg = e?.response?.data?.error?.message || e?.message || '';
            if (!/cannot find|does not exist/i.test(msg)) throw e;
          });
          details.push({ user: r.user, role: r.role, result: 'removed from m365 group (owner & member)' });
          applied++;
        } else {
          // role === 'member' → solo de members
          await removeFromM365Group(m365GroupId, oid, /*fromOwner*/ false);
          details.push({ user: r.user, role: r.role, result: 'removed from m365 group (member)' });
          applied++;
        }
      } catch (e) {
        const msg = e?.response?.data?.error?.message || e?.message || '';
        if (/cannot find|does not exist/i.test(msg)) {
          details.push({ user: r.user, role: r.role, result: 'not in group' });
          skipped++;
        } else {
          throw e;
        }
      }
    }


    return { applied, skipped, details, mode: 'm365-group' };
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

  for (const a of (assignments || [])) {
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
  assignMembersToSite,
  getSiteMembers,
  removeMembersFromSite,
  configureVersionLimit
};
