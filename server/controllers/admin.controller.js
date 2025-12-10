// controllers/admin.controller.js

const templates = require('../services/admin.template.service');
const accAdmin = require('../services/admin.acc.service');
const spAdmin = require('../services/admin.sp.service');
const twinSvc = require('../services/admin.twin.service');
const logger = require('../helpers/logger');
const path = require('path');
const fs = require('fs');
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

/** Mapea roles de la UI a ACC */
function mapRoleToAcc(memberRole) {
  const r = String(memberRole || 'Member').toLowerCase();
  if (r === 'owner') return { makeProjectAdmin: true, grantDocs: 'admin' };
  if (r === 'visitor') return { makeProjectAdmin: false, grantDocs: 'viewer' };
  // default Member
  return { makeProjectAdmin: false, grantDocs: 'member' };
}

/** Normaliza cualquier combinación: memberEmail | members[] | accMembers[] */
function normalizeAccMembersFromBody(body) {
  const out = [];

  // Formato ACC explícito
  if (Array.isArray(body?.accMembers)) {
    for (const m of body.accMembers) {
      if (!m?.email) continue;
      out.push({
        email: String(m.email).trim(),
        makeProjectAdmin: !!m.makeProjectAdmin,
        grantDocs: (m.grantDocs || 'viewer').toLowerCase(), // admin|member|viewer
      });
    }
  }

  // Formato “Twin/SP-like”
  if (Array.isArray(body?.members)) {
    for (const m of body.members) {
      if (!m?.user) continue;
      const map = mapRoleToAcc(m.role);
      out.push({
        email: String(m.user).trim(),
        makeProjectAdmin: map.makeProjectAdmin,
        grantDocs: map.grantDocs,
      });
    }
  }

  // Compat: memberEmail como admin de docs y de proyecto
  if (body?.memberEmail) {
    out.push({
      email: String(body.memberEmail).trim(),
      makeProjectAdmin: true,
      grantDocs: 'admin',
    });
  }

  // Dedup por email (última definición gana)
  const dedup = {};
  for (const m of out) {
    if (m.email) dedup[m.email.toLowerCase()] = m;
  }
  return Object.values(dedup);
}


// ------------------------- Templates -------------------------

async function getTemplate(req, res, next) {
  try {
    const t = await templates.loadTemplate(req.params.templateId);
    if (!t) return res.status(404).json({ error: 'template not found' });
    res.json(t);
  } catch (e) { next(e); }
}

async function listTemplates(_req, res, next) {
  try {
    const dir = path.join(__dirname, '..', 'config', 'templates');
    const files = await fs.promises.readdir(dir);
    // Devolvemos solo IDs (nombre de archivo sin .json)
    const items = files
      .filter(f => f.endsWith('.json'))
      .map(f => path.basename(f, '.json'))
      .sort((a, b) => a.localeCompare(b));
    res.json({ items });
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
    const { 
      projectId, accountId, hubId, siteId, siteUrl, 
      templateId, vars = {}, twinId,
      applyTemplates = false  // ⚠️ NUEVO: Por defecto solo vincula, no aplica plantillas
    } = req.body || {};
    
    if (!projectId || !(siteId || siteUrl)) {
      return res.status(400).json({ error: 'projectId y siteId|siteUrl son obligatorios' });
    }

    // Si applyTemplates=true, requiere templateId
    if (applyTemplates && !templateId) {
      return res.status(400).json({ error: 'templateId es obligatorio cuando applyTemplates=true' });
    }

    let accRes = null, spRes = null, name = null;

    // Solo aplicar plantillas si se solicita explícitamente
    if (applyTemplates && templateId) {
      const accId = normalizeAccountId(accountId || hubId);
      if (!accId) {
        return res.status(400).json({ error: 'accountId o hubId es obligatorio para aplicar en ACC (Docs)' });
      }

      const { tpl, name: resolvedName } = await loadTemplateAndExpandName(templateId, vars);
      name = resolvedName;

      accRes = await accAdmin.applyTemplateToProject({
        accountId: accId,
        projectId,
        template: tpl,
        resolvedName: name
      });

      spRes = await spAdmin.applyTemplateToSite({
        siteId, siteUrl, template: tpl, resolvedName: name
      });
    }

    // Obtener siteId si se pasó siteUrl
    let finalSiteId = siteId;
    if (!finalSiteId && siteUrl) {
      const { data } = await graphGet(`/sites/${siteUrl}?$select=id`);
      finalSiteId = data?.id;
    }

    // Guardar vínculo Twin
    const bim360Url = `https://acc.autodesk.com/docs/files/projects/${projectId}`;
    const link = await twinSvc.saveLink({
      twinId: twinId || `${projectId}__${finalSiteId}`,
      projectId,
      siteId: finalSiteId,
      templateId: templateId || null,
      vars,
      bim360Url
    });

    res.json({ 
      ok: true, 
      link,
      ...(name ? { name } : {}),
      ...(accRes ? { acc: accRes } : {}),
      ...(spRes ? { sp: spRes } : {})
    });
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
      memberEmail,            // compat
      members = [],           // nuevo (Owner/Member/Visitor)
      accMembers = []         // nuevo (email/makeProjectAdmin/grantDocs)
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

    // --- Normalizar y citar a todos los miembros (si se pasan)
    const normalized = normalizeAccMembersFromBody({ memberEmail, members, accMembers });
    let membership = null;
    if (normalized.length) {
      membership = [];
      for (const m of normalized) {
        try {
          const accessLevel = m.grantDocs || 'viewer';
          const r = await accAdmin.ensureProjectMember({
            accountId: created.accountId,
            projectId: created.projectId,
            email: m.email,
            makeProjectAdmin: !!m.makeProjectAdmin,
            grantDocs: accessLevel,
            grantDesignCollab: accessLevel,
            grantModelCoord: accessLevel
          });
          membership.push(r);
        } catch (e) {
          const msg = e?.response?.data?.detail || e?.message || 'invite_failed';
          membership.push({ ok: false, email: m.email, error: msg });
        }
      }
    }
    // --- FIN NUEVO

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
      ...(membership ? { membership } : {}),
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
        assignments: members
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
    const {
      hubId, accountId,
      sp = {},
      templateId, template,
      vars = {},
      twinId,
      code, name,
      memberEmail,
      members = [],
      accMembers = []
    } = req.body || {};

    if (!(hubId || accountId) || !templateId || !sp?.url) {
      return res.status(400).json({ error: 'hubId|accountId, templateId y sp.url son obligatorios' });
    }

    // Cargar plantilla
    let tplObj = template;
    if (tplObj && typeof tplObj === 'string') {
      const loaded = await templates.loadTemplate(tplObj);
      if (!loaded) return res.status(404).json({ error: `template "${template}" not found` });
      tplObj = loaded;
    }
    const adminTpl = await templates.loadTemplate(templateId).catch(() => null);

    // Nombre
    const resolvedName =
      name ||
      (adminTpl ? templates.expandName(adminTpl, vars)
        : (tplObj ? templates.expandName(tplObj, vars)
          : vars.name));
    if (!resolvedName) return res.status(400).json({ error: 'name (o vars.name) es obligatorio' });

    logger.mk('TWIN-CTRL').info('Iniciando creación de twin', {
      name: resolvedName, accId: accountId || hubId, spUrl: sp.url
    });

    // === ACC: crear proyecto
    const accCreated = await accAdmin.createProject({
      hubId, accountId, name: resolvedName, code, vars
    });

    // === ACC: invitar miembros (NUEVO)
    // Acepta: memberEmail, members[{user,role}], accMembers[{email,makeProjectAdmin,grantDocs}]
    const normalizedAcc = normalizeAccMembersFromBody({ memberEmail, members, accMembers });
    let accMembership = null;
    if (normalizedAcc.length) {
      accMembership = [];
      for (const m of normalizedAcc) {
        try {
          const r = await accAdmin.ensureProjectMember({
            accountId: accCreated.accountId,
            projectId: accCreated.projectId,
            email: m.email,
            makeProjectAdmin: !!m.makeProjectAdmin,
            grantDocs: (m.grantDocs || 'viewer')
          });
          accMembership.push(r);
        } catch (e) {
          const msg = e?.response?.data?.detail || e?.message || 'invite_failed';
          accMembership.push({ ok: false, email: m.email, error: msg });
        }
      }
    }

    // (mantener compat: invitación directa solo por memberEmail si no vino en arrays)
    // Nota: normalizeAccMembersFromBody ya lo incluye; no hace falta duplicar.

    // === ACC: aplicar plantilla si existe
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

    // === SP: crear sitio
    const spCreated = await spAdmin.createSite({
      type: sp.type || 'CommunicationSite',
      title: resolvedName,
      url: sp.url,
      description: sp.description
    });

    // === SP: aplicar plantilla
    const spApplied = await spAdmin.applyTemplateToSite({
      siteId: spCreated.siteId,
      siteUrl: spCreated.siteUrl,
      template: adminTpl || tplObj,
      resolvedName
    });

    // === SP: asignar miembros (como ya estaba)
    let spMembership = null;
    if (Array.isArray(members) && members.length) {
      spMembership = await spAdmin.assignMembersToSite({
        siteId: spCreated.siteId,
        siteUrl: spCreated.siteUrl,
        assignments: members
      });
      logger.mk('TWIN-CTRL').info('Miembros SP asignados (Twin)', spMembership);
    }

    // Guardar twin
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

    // Respuesta
    res.json({
      ok: true,
      name: resolvedName,
      link,
      acc: {
        projectId: accCreated.projectId,
        accountId: accCreated.accountId,
        dm: accCreated.dm,
        ...(accMembership ? { membership: accMembership } : {})
      },
      sp: {
        ...spCreated,
        applied: spApplied,
        ...(spMembership ? { membership: spMembership } : {})
      }
    });
  } catch (e) {
    const { status, detail } = mapError(e, 'create_twin_failed');
    logger.mk('TWIN-CTRL').error('Error creando twin', { status, detail });
    res.status(status === 409 ? 400 : status).json({ error: { status, detail } });
  }
}


// ------------------------- Comprobar usuarios del Tenant SP -------------------------

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
      const { data } = await graphGet(`/users?$filter=startswith(displayName,'${q.replace(/'/g, "''")}')&$top=10&$select=id,displayName,mail,userPrincipalName`);
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

// GET /api/admin/sp/sites/members?siteUrl=...&format=flat
async function getCurrentSiteMembers(req, res, next) {
  try {
    const { siteUrl, format } = req.query || {};
    if (!siteUrl) return res.status(400).json({ error: 'siteUrl requerido' });
    const r = await getSiteMembers({ siteUrl, format });
    res.json(r);
  } catch (e) { next(e); }
}

// ------------------------- Comprobar usuarios del Hub -------------------------

// GET /api/admin/acc/accounts/:accountId/users?q=...&limit=25&offset=0
async function listAccAccountUsers(req, res) {
  try {
    const { accountId } = req.params;
    const { q = "", limit, offset, region } = req.query || {};
    const raw = await accAdmin.listAccountUsers({
      accountId, q,
      limit: limit ? parseInt(limit, 10) : 25,
      offset: offset ? parseInt(offset, 10) : 0,
      region
    });
    const norm = accAdmin.normalizeAccountUsersResponse(raw);
    res.json(norm); // { items:[{id,name,email,status,company,role}], next? }
  } catch (e) {
    const { status, detail } = mapError(e, 'list_acc_account_users_failed');
    res.status(status || 500).json({ error: { status, detail } });
  }
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
  getCurrentSiteMembers,
  listAccAccountUsers,
  listTemplates
};
