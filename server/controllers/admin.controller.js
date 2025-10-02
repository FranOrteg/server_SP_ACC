// controllers/admin.controller.js

const templates = require('../services/admin.template.service');
const accAdmin  = require('../services/admin.acc.service');
const spAdmin   = require('../services/admin.sp.service');
const twinSvc   = require('../services/admin.twin.service');
const logger    = require('../helpers/logger');
const { graphGet } = require('../clients/graphClient');
const { searchTenantUsers } = require('../services/admin.users.service');
const { assignMembersToSite, removeMembersFromSite, getSiteMembers } = require('../services/admin.sp.service');

// ------------------------- Helpers locales -------------------------

/** Normaliza accountId/hubId → GUID "pelado" (sin 'b.') */
function normalizeAccountId(accountIdOrHubId) {
  return (accountIdOrHubId || '').toString().replace(/^b\./, '');
}

/** Lee plantilla y expande nombre con vars; 404 si no existe */
async function loadTemplateAndExpandName(templateKey, vars) {
  const tpl = await templates.loadTemplate(templateKey);
  if (!tpl) {
    const err = new Error('template not found');
    err.status = 404;
    throw err;
  }
  return { tpl, name: templates.expandName(tpl, vars || {}) };
}

/** Mapea axios/error → { status, detail } */
function mapError(e, fallback = 'internal_error') {
  const status =
    e?.status ||
    e?.response?.status ||
    500;

  const detail =
    (e?.response?.data?.errors && Array.isArray(e.response.data.errors) &&
      e.response.data.errors.map(x => x.detail).filter(Boolean).join(' | ')) ||
    e?.response?.data?.error?.message ||
    e?.response?.data?.ErrorMessage ||
    e?.response?.data?.detail ||
    e?.message ||
    fallback;

  return { status, detail };
}

// ------------------------- Templates -------------------------

async function getTemplate(req, res, next) {
  try {
    const t = await templates.loadTemplate(req.params.templateId);
    if (!t) return res.status(404).json({ error: 'template not found' });
    res.json(t);
  } catch (e) { next(e); }
}

// ------------------------- Apply only: ACC -------------------------

async function applyAcc(req, res, next) {
  try {
    const { projectId, templateId, vars = {}, accountId, hubId } = req.body || {};
    if (!projectId || !templateId) {
      return res.status(400).json({ error: 'projectId y templateId son obligatorios' });
    }
    const accId = normalizeAccountId(accountId || hubId);
    if (!accId) {
      return res.status(400).json({ error: 'accountId o hubId es obligatorio para aplicar carpetas en Docs' });
    }

    const { tpl, name } = await loadTemplateAndExpandName(templateId, vars);

    const r = await accAdmin.applyTemplateToProject({
      accountId: accId,
      projectId,
      template: tpl,
      resolvedName: name
    });

    res.json({ ok: true, projectId, accountId: accId, name, result: r });
  } catch (e) {
    const { status, detail } = mapError(e, 'apply_acc_failed');
    res.status(status === 409 ? 400 : status).json({ error: { status, detail } });
  }
}

// ------------------------- Apply only: SP -------------------------

async function applySp(req, res, next) {
  try {
    const { siteId, siteUrl, templateId, vars = {} } = req.body || {};
    if (!(siteId || siteUrl) || !templateId) {
      return res.status(400).json({ error: 'siteId o siteUrl y templateId son obligatorios' });
    }

    const { tpl, name } = await loadTemplateAndExpandName(templateId, vars);

    const r = await spAdmin.applyTemplateToSite({
      siteId, siteUrl, template: tpl, resolvedName: name
    });

    res.json({ ok: true, siteId: r.siteId, name, result: r });
  } catch (e) {
    const { status, detail } = mapError(e, 'apply_sp_failed');
    res.status(status === 409 ? 400 : status).json({ error: { status, detail } });
  }
}

// ------------------------- Apply both (Twin) -------------------------

async function applyTwin(req, res, next) {
  try {
    const { projectId, accountId, hubId, siteId, siteUrl, templateId, vars = {}, twinId } = req.body || {};
    if (!projectId || !(siteId || siteUrl) || !templateId) {
      return res.status(400).json({ error: 'projectId, siteId|siteUrl y templateId son obligatorios' });
    }
    const accId = normalizeAccountId(accountId || hubId);
    if (!accId) {
      return res.status(400).json({ error: 'accountId o hubId es obligatorio para aplicar en ACC (Docs)' });
    }

    const { tpl, name } = await loadTemplateAndExpandName(templateId, vars);

    const accRes = await accAdmin.applyTemplateToProject({
      accountId: accId,
      projectId,
      template: tpl,
      resolvedName: name
    });

    const spRes = await spAdmin.applyTemplateToSite({
      siteId, siteUrl, template: tpl, resolvedName: name
    });

    const link = await twinSvc.saveLink({
      twinId: twinId || `${projectId}__${spRes.siteId}`,
      projectId,
      siteId: spRes.siteId,
      templateId,
      vars
    });

    res.json({ ok: true, name, link, acc: accRes, sp: spRes });
  } catch (e) {
    const { status, detail } = mapError(e, 'apply_twin_failed');
    res.status(status).json({ error: { status, detail } });
  }
}

// ------------------------- Twin status/list -------------------------

async function twinStatus(req, res, next) {
  try {
    const s = await twinSvc.getStatus(req.params.id);
    if (!s) return res.status(404).json({ error: 'twin not found' });
    res.json(s);
  } catch (e) { next(e); }
}

async function listTwins(_req, res, next) {
  try {
    res.json(await twinSvc.listLinks());
  } catch (e) { next(e); }
}

// ------------------------- Create ACC Project -------------------------

async function createAccProject(req, res, next) {
  try {
    const {
      hubId, accountId,
      templateId, template,
      vars = {},
      code, name,
      onNameConflict = 'suffix-timestamp',
      memberEmail
    } = req.body || {};

    const tplKey = templateId || template;
    if (!(hubId || accountId) || !tplKey) {
      return res.status(400).json({ error: 'hubId|accountId y templateId|template son obligatorios' });
    }

    const { tpl, name: resolvedNameCandidate } = await loadTemplateAndExpandName(tplKey, vars);
    const resolvedName = name || resolvedNameCandidate;

    const created = await accAdmin.createProject({
      hubId, accountId, name: resolvedName, code: code || vars.code, vars,
      type: vars.type, classification: vars.classification || 'production',
      onNameConflict
    });

    let member = null;
    if (memberEmail) {
      try {
        member = await accAdmin.ensureProjectMember({
          accountId: created.accountId,
          projectId: created.projectId,
          email: memberEmail,
          makeProjectAdmin: true,
          grantDocs: 'admin'
        });
      } catch (e) {
        const msg = e?.response?.data?.detail || e?.message || 'invite_failed';
        logger.mk('ACC-CTRL').warn('ensureProjectMember warning:', msg);
        member = { ok: false, error: msg };
      }
    }

    const applied = await accAdmin.applyTemplateToProject({
      accountId: created.accountId,
      projectId: created.projectId,
      projectIdDM: created.dm?.projectIdDM,
      template: tpl,
      resolvedName
    });

    res.json({
      ok: true,
      hubId: hubId || `b.${created.accountId}`,
      accountId: created.accountId,
      projectId: created.projectId,
      projectIdDM: created.dm?.projectIdDM,
      name: created.name,
      ...(member ? { member } : {}),
      applied
    });
  } catch (e) {
    const { status, detail } = mapError(e, 'create_acc_project_failed');
    return res.status(status === 409 ? 400 : status).json({ error: { status, detail } });
  }
}

// ------------------------- Create SP Site -------------------------

async function createSpSite(req, res, next) {
  try {
    const {
      templateId,
      vars = {},
      type = 'CommunicationSite',
      title,
      url,
      description,
      members = []
    } = req.body || {};

    if (!templateId || !url) {
      return res.status(400).json({ error: 'templateId y url son obligatorios' });
    }

    const { tpl, name } = await loadTemplateAndExpandName(templateId, vars);
    const resolvedName = title || name;

    logger.mk('SP-CTRL').info('Iniciando creación de sitio SP', { 
      type, url, title: resolvedName 
    });

    const created = await spAdmin.createSite({ 
      type, title: resolvedName, url, description 
    });

    logger.mk('SP-CTRL').info('Sitio creado, aplicando plantilla', { 
      siteId: created.siteId, siteUrl: created.siteUrl 
    });

    const applied = await spAdmin.applyTemplateToSite({
      siteId: created.siteId,
      siteUrl: created.siteUrl,
      template: tpl,
      resolvedName
    });

    let membership = null;
    if (Array.isArray(members) && members.length) {
      membership = await spAdmin.assignMembersToSite({
        siteId: created.siteId,
        siteUrl: created.siteUrl,
        siteType: type,
        members
      });
      logger.mk('SP-CTRL').info('Miembros asignados al sitio', membership);
    }

    logger.mk('SP-CTRL').info('Sitio SP completado', { 
      siteId: created.siteId,
      folders: applied.folders 
    });

    res.json({ 
      ok: true, 
      siteId: created.siteId, 
      siteUrl: created.siteUrl, 
      name: resolvedName,
      applied,
      ...(membership ? { membership } : {})
    });
  } catch (e) {
    const { status, detail } = mapError(e, 'create_sp_site_failed');
    logger.mk('SP-CTRL').error('Error creando sitio SP', { status, detail, url: req.body?.url });
    res.status(status === 409 ? 400 : status).json({ error: { status, detail } });
  }
}

// ------------------------- Create Twin (ACC + SP) -------------------------

async function createTwin(req, res, next) {
  try {
    const { hubId, accountId, sp = {}, templateId, template, vars = {}, twinId, code, name, memberEmail } = req.body || {};
    if (!(hubId || accountId) || !templateId || !sp?.url) {
      return res.status(400).json({ error: 'hubId|accountId, templateId y sp.url son obligatorios' });
    }

    let tplObj = template;
    if (tplObj && typeof tplObj === 'string') {
      const loaded = await templates.loadTemplate(tplObj);
      if (!loaded) return res.status(404).json({ error: `template "${template}" not found` });
      tplObj = loaded;
    }

    const adminTpl = await templates.loadTemplate(templateId).catch(() => null);
    const resolvedName =
      name ||
      (adminTpl ? templates.expandName(adminTpl, vars) : (tplObj ? templates.expandName(tplObj, vars) : vars.name));

    if (!resolvedName) return res.status(400).json({ error: 'name (o vars.name) es obligatorio' });

    logger.mk('TWIN-CTRL').info('Iniciando creación de twin', { 
      name: resolvedName, accId: accountId || hubId, spUrl: sp.url 
    });

    const accCreated = await accAdmin.createProject({
      hubId, accountId, name: resolvedName, code, vars
    });

    let memberResult = null;
    if (memberEmail) {
      memberResult = await accAdmin.ensureProjectMember({
        accountId: accCreated.accountId,
        projectId: accCreated.projectId,
        email: memberEmail,
        makeProjectAdmin: true,
        grantDocs: 'admin'
      }).catch(e => ({ ok: false, error: e?.message || 'invite_failed' }));
    }

    const tplForAcc = adminTpl || tplObj;
    if (tplForAcc) {
      await accAdmin.applyTemplateToProject({
        accountId: accCreated.accountId,
        projectId: accCreated.projectId,
        projectIdDM: accCreated.dm?.projectIdDM,
        template: tplForAcc,
        resolvedName
      });
    }

    logger.mk('TWIN-CTRL').info('ACC listo, creando sitio SP', { projectId: accCreated.projectId });

    const spCreated = await spAdmin.createSite({
      type: sp.type || 'CommunicationSite',
      title: resolvedName,
      url: sp.url,
      description: sp.description
    });

    await spAdmin.applyTemplateToSite({
      siteId: spCreated.siteId,
      siteUrl: spCreated.siteUrl,
      template: adminTpl || tplObj,
      resolvedName
    });

    const link = await twinSvc.saveLink({
      twinId: twinId || `${accCreated.projectId}__${spCreated.siteId}`,
      projectId: accCreated.projectId,
      siteId: spCreated.siteId,
      templateId,
      vars
    });

    logger.mk('TWIN-CTRL').info('Twin creado exitosamente', { 
      twinId: link.twinId, projectId: accCreated.projectId, siteId: spCreated.siteId 
    });

    res.json({
      ok: true,
      name: resolvedName,
      link,
      acc: { projectId: accCreated.projectId, accountId: accCreated.accountId, dm: accCreated.dm, member: memberResult },
      sp: spCreated
    });
  } catch (e) {
    const { status, detail } = mapError(e, 'create_twin_failed');
    logger.mk('TWIN-CTRL').error('Error creando twin', { status, detail });
    res.status(status === 409 ? 400 : status).json({ error: { status, detail } });
  }
}

// ------------------------- Comprobar usuarios del Tenant -------------------------

async function spDiagUser(req, res, next) {
  try {
    const { id } = req.query || {};
    if (!id) return res.status(400).json({ error: 'id (upn o id AAD) requerido' });
    const { data } = await graphGet(`/users/${encodeURIComponent(id)}?$select=id,displayName,mail,userPrincipalName,userType,accountEnabled`);
    res.json(data);
  } catch (e) {
    try {
      const { id } = req.query || {};
      const { data } = await graphGet(`/users?$filter=mail eq '${id}'&$select=id,displayName,mail,userPrincipalName,userType,accountEnabled`);
      const items = data?.value || [];
      if (!items.length) return res.status(404).json({ error: 'user not found' });
      res.json(items[0]);
    } catch (err) {
      next(err);
    }
  }
}

async function spDiagUsers(req, res, next) {
  try {
    const { email, q } = req.query || {};
    if (email) {
      const { data } = await graphGet(`/users?$filter=mail eq '${email}'&$select=id,displayName,mail,userPrincipalName,userType,accountEnabled`);
      return res.json({ by: 'mail', items: data?.value || [] });
    }
    if (q) {
      const { data } = await graphGet(`/users?$filter=startswith(displayName,'${q.replace(/'/g,"''")}')&$top=10&$select=id,displayName,mail,userPrincipalName`);
      return res.json({ by: 'displayName', items: data?.value || [] });
    }
    return res.status(400).json({ error: 'pasa ?email= o ?q=' });
  } catch (e) { next(e); }
}

// GET /api/admin/sp/users?q=ana&top=20&next=...
async function spListUsers(req, res, next) {
  try {
    const { q = '', top, next, onlyEnabled = 'true', includeGuests = 'false' } = req.query || {};
    const result = await searchTenantUsers({
      q,
      top: top ? parseInt(top, 10) : 20,
      next,
      onlyEnabled: String(onlyEnabled).toLowerCase() !== 'false',
      includeGuests: String(includeGuests).toLowerCase() === 'true'
    });
    res.json(result);
  } catch (e) { next(e); }
}

// POST /api/admin/sp/sites/members
// Body:
// {
//   "siteUrl": "...", "siteId": "...", 
//   "add":    [ { "user": "a@b.com", "role": "Owner" }, ...],
//   "remove": [ { "user": "c@d.com", "role": "Member" }, ...]
// }
async function setSiteMembers(req, res, next) {
  try {
    const { siteUrl, siteId, add = [], remove = [] } = req.body || {};
    if (!(siteUrl || siteId)) return res.status(400).json({ error: 'siteUrl o siteId requerido' });

    let added = null, removed = null;

    if (Array.isArray(add) && add.length) {
      added = await assignMembersToSite({ siteUrl, siteId, assignments: add });
    }
    if (Array.isArray(remove) && remove.length) {
      removed = await removeMembersFromSite({ siteUrl, siteId, removals: remove });
    }

    res.json({ ok: true, ...(added ? { added } : {}), ...(removed ? { removed } : {}) });
  } catch (e) {
    const { status, detail } = mapError(e, 'set_members_failed');
    res.status(status === 409 ? 400 : status).json({ error: { status, detail } });
  }
}

// GET /api/admin/sp/sites/members?siteUrl=...
async function getCurrentSiteMembers(req, res, next) {
  try {
    const { siteUrl } = req.query || {};
    if (!siteUrl) return res.status(400).json({ error: 'siteUrl requerido' });
    const r = await getSiteMembers({ siteUrl });
    res.json(r);
  } catch (e) { next(e); }
}

module.exports = {
  getTemplate,
  applyAcc,
  applySp,
  applyTwin,
  twinStatus,
  listTwins,
  createAccProject,
  createSpSite,
  createTwin,
  spDiagUser,
  spDiagUsers,
  spListUsers,
  setSiteMembers,
  getCurrentSiteMembers
};
