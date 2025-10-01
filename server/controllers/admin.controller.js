// controllers/admin.controller.js

const templates = require('../services/admin.template.service');
const accAdmin  = require('../services/admin.acc.service');   // unificado 3LO+DM
const spAdmin   = require('../services/admin.sp.service');
const twinSvc   = require('../services/admin.twin.service');
const logger    = require('../helpers/logger');
const { graphGet } = require('../clients/graphClient');

// ------------------------- Helpers locales -------------------------

/** Normaliza accountId/hubId → GUID “pelado” (sin 'b.') */
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
    // ACC típico
    (e?.response?.data?.errors && Array.isArray(e.response.data.errors) &&
      e.response.data.errors.map(x => x.detail).filter(Boolean).join(' | ')) ||
    // SP típico
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

/**
 * Aplica plantilla SOLO en ACC (Docs) sobre proyecto EXISTENTE.
 * Construction Admin usa GUID “pelado”; Data Management necesita 'b.{guid}' (lo resuelve el servicio).
 */
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
      projectId,              // Admin GUID (sin 'b.')
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

    // 1) Crea proyecto en ACC
    const created = await accAdmin.createProject({
      hubId, accountId, name: resolvedName, code: code || vars.code, vars,
      type: vars.type, classification: vars.classification || 'production',
      onNameConflict
    });

    // 2) (best-effort) invitar miembro para visibilidad inmediata en Docs
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

    // 3) Aplica plantilla en Docs
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
    const { templateId, vars = {}, type = 'CommunicationSite', title, url, description } = req.body || {};
    if (!templateId || !url) return res.status(400).json({ error: 'templateId y url son obligatorios' });

    const { tpl, name } = await loadTemplateAndExpandName(templateId, vars);
    const resolvedName = title || name;

    const created = await spAdmin.createSite({ type, title: resolvedName, url, description });

    await spAdmin.applyTemplateToSite({
      siteId: created.siteId,
      siteUrl: created.siteUrl,
      template: tpl,
      resolvedName
    });

    res.json({ ok: true, siteId: created.siteId, siteUrl: created.siteUrl, name: resolvedName });
  } catch (e) {
    const { status, detail } = mapError(e, 'create_sp_site_failed');
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

    // Plantillas: permitimos pasar templateId (admin) y, opcionalmente, una plantilla “directa”
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

    // 1) ACC
    const accCreated = await accAdmin.createProject({
      hubId, accountId, name: resolvedName, code, vars
    });

    // 1.1) miembro opcional
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

    // 1.2) aplicar plantilla ACC si procede
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

    // 2) SP
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

    // 3) Guardar twin
    const link = await twinSvc.saveLink({
      twinId: twinId || `${accCreated.projectId}__${spCreated.siteId}`,
      projectId: accCreated.projectId,
      siteId: spCreated.siteId,
      templateId,
      vars
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
    res.status(status === 409 ? 400 : status).json({ error: { status, detail } });
  }
}

// ------------------------- Comprobar usuarios del Tenant -------------------------

// GET /api/admin/sp/diag/user?id=<upn|id>
async function spDiagUser(req, res, next) {
  try {
    const { id } = req.query || {};
    if (!id) return res.status(400).json({ error: 'id (upn o id AAD) requerido' });
    const { data } = await graphGet(`/users/${encodeURIComponent(id)}?$select=id,displayName,mail,userPrincipalName,userType,accountEnabled`);
    res.json(data);
  } catch (e) {
    // si /users/{id} falla, intenta por filtro mail
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

// GET /api/admin/sp/diag/users?email=<correo>&q=<texto>
async function spDiagUsers(req, res, next) {
  try {
    const { email, q } = req.query || {};
    if (email) {
      const { data } = await graphGet(`/users?$filter=mail eq '${email}'&$select=id,displayName,mail,userPrincipalName,userType,accountEnabled`);
      return res.json({ by: 'mail', items: data?.value || [] });
    }
    if (q) {
      // Búsqueda por displayName (básica, sin $search)
      const { data } = await graphGet(`/users?$filter=startswith(displayName,'${q.replace(/'/g,"''")}')&$top=10&$select=id,displayName,mail,userPrincipalName`);
      return res.json({ by: 'displayName', items: data?.value || [] });
    }
    return res.status(400).json({ error: 'pasa ?email= o ?q=' });
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
  spDiagUsers
};
