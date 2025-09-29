// controllers/admin.controller.js

const templates = require('../services/admin.template.service');
const accAdmin  = require('../services/admin.acc.service');   // usa el unificado 3LO+DM
const spAdmin   = require('../services/admin.sp.service');
const twinSvc   = require('../services/admin.twin.service');

async function getTemplate(req, res, next) {
  try {
    const t = await templates.loadTemplate(req.params.templateId);
    if (!t) return res.status(404).json({ error: 'template not found' });
    res.json(t);
  } catch (e) { next(e); }
}

/**
 * Aplica plantilla SOLO en ACC (carpetas/permisos en Docs) sobre un proyecto EXISTENTE.
 * Nota: Construction Admin usa GUID “pelado”; Data Management necesita 'b.{guid}'.
 */
async function applyAcc(req, res, next) {
  try {
    const { projectId, templateId, vars = {}, accountId, hubId } = req.body || {};
    if (!projectId || !templateId) {
      return res.status(400).json({ error: 'projectId y templateId son obligatorios' });
    }
    const accId = (accountId || hubId || '').toString().replace(/^b\./, '');
    if (!accId) {
      return res.status(400).json({ error: 'accountId o hubId es obligatorio para aplicar carpetas en Docs' });
    }

    const tpl = await templates.loadTemplate(templateId);
    if (!tpl) return res.status(404).json({ error: 'template not found' });

    const name = templates.expandName(tpl, vars);

    const r = await accAdmin.applyTemplateToProject({
      accountId: accId,
      projectId,              // Admin GUID (sin 'b.')
      template: tpl,
      resolvedName: name
    });

    res.json({ ok: true, projectId, accountId: accId, name, result: r });
  } catch (e) { next(e); }
}

async function applySp(req, res, next) {
  try {
    const { siteId, siteUrl, templateId, vars = {} } = req.body || {};
    if (!(siteId || siteUrl) || !templateId) {
      return res.status(400).json({ error: 'siteId o siteUrl y templateId son obligatorios' });
    }
    const tpl = await templates.loadTemplate(templateId);
    if (!tpl) return res.status(404).json({ error: 'template not found' });

    const name = templates.expandName(tpl, vars);
    const r = await spAdmin.applyTemplateToSite({ siteId, siteUrl, template: tpl, resolvedName: name });
    res.json({ ok: true, siteId: r.siteId, name, result: r });
  } catch (e) { next(e); }
}

async function applyTwin(req, res, next) {
  try {
    const { projectId, accountId, hubId, siteId, siteUrl, templateId, vars = {}, twinId } = req.body || {};
    if (!projectId || !(siteId || siteUrl) || !templateId) {
      return res.status(400).json({ error: 'projectId, siteId|siteUrl y templateId son obligatorios' });
    }
    const accId = (accountId || hubId || '').toString().replace(/^b\./, '');
    if (!accId) {
      return res.status(400).json({ error: 'accountId o hubId es obligatorio para aplicar en ACC (Docs)' });
    }

    const tpl = await templates.loadTemplate(templateId);
    if (!tpl) return res.status(404).json({ error: 'template not found' });

    const name = templates.expandName(tpl, vars);

    const accRes = await accAdmin.applyTemplateToProject({
      accountId: accId,
      projectId,
      template: tpl,
      resolvedName: name
    });

    const spRes  = await spAdmin.applyTemplateToSite({ siteId, siteUrl, template: tpl, resolvedName: name });

    const link = await twinSvc.saveLink({
      twinId: twinId || `${projectId}__${spRes.siteId}`,
      projectId,
      siteId: spRes.siteId,
      templateId,
      vars
    });

    res.json({ ok: true, name, link, acc: accRes, sp: spRes });
  } catch (e) { next(e); }
}

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

// ------------------------------------------------------------------------------------------- //
// CREAR PROYECTO ACC (con o sin plantilla ACC) y opcionalmente aplicar tu plantilla de carpetas
// y añadir un miembro al proyecto para que aparezca en Docs inmediatamente.

async function createAccProject(req, res, next) {
  try {
    const {
      hubId, accountId,
      templateId, template,      // admite cualquiera de los dos (tu JSON local)
      vars = {},
      code, name,
      memberEmail,               // 👈 NUEVO: miembro a invitar (p.ej. support@labit.es)
      onNameConflict = 'suffix-timestamp'
    } = req.body || {};

    const tplKey = templateId || template;
    if (!(hubId || accountId) || !tplKey) {
      return res.status(400).json({ error: 'hubId|accountId y templateId|template son obligatorios' });
    }

    const tpl = await templates.loadTemplate(tplKey);
    if (!tpl) return res.status(404).json({ error: 'template not found' });

    const resolvedName = name || templates.expandName(tpl, vars);

    // 1) Crea el proyecto en ACC (+ activa Docs best-effort + espera DM)
    const created = await accAdmin.createProject({
      hubId, accountId, name: resolvedName, code: code || vars.code, vars,
      type: vars.type, classification: vars.classification || 'production',
      onNameConflict
    });

    // 1.1) (Opcional recomendado) invitar miembro para visibilidad inmediata en Docs
    let memberResult = null;
    if (memberEmail) {
      memberResult = await accAdmin.ensureProjectMember({
        accountId: created.accountId,
        projectId: created.projectId,
        email: memberEmail,
        makeProjectAdmin: true,            // por defecto le damos Project Admin
        grantDocs: 'admin'                 // acceso Docs admin
      });
    }

    // 2) Aplica tu plantilla en Docs
    const applied = await accAdmin.applyTemplateToProject({
      accountId: created.accountId,
      projectId: created.projectId,             // Admin GUID
      projectIdDM: created.dm.projectIdDM,      // 'b.{projectGuid}'
      template: tpl,
      resolvedName
    });

    res.json({
      ok: true,
      hubId: hubId || `b.${created.accountId}`,
      accountId: created.accountId,
      projectId: created.projectId,
      projectIdDM: created.dm.projectIdDM,
      name: created.name,
      member: memberResult,
      applied
    });
  } catch (e) {
    console.error('createAccProject ERROR:', e);
    const status = e?.response?.status;
    const data   = e?.response?.data;
    if (status && data) return res.status(400).json({ error: data });
    next(e);
  }
}

// --- Crear sitio SP desde cero y aplicar plantilla ---
async function createSpSite(req, res, next) {
  try {
    const { templateId, vars = {}, type = 'CommunicationSite', title, url, description } = req.body || {};
    if (!templateId || !url) return res.status(400).json({ error: 'templateId y url son obligatorios' });
    const tpl = await templates.loadTemplate(templateId);
    if (!tpl) return res.status(404).json({ error: 'template not found' });

    const resolvedName = title || templates.expandName(tpl, vars);
    const created = await spAdmin.createSite({ type, title: resolvedName, url, description });

    await spAdmin.applyTemplateToSite({ siteId: created.siteId, siteUrl: created.siteUrl, template: tpl, resolvedName });
    res.json({ ok: true, siteId: created.siteId, siteUrl: created.siteUrl, name: resolvedName });
  } catch (e) { next(e); }
}

// --- Crear TWIN (ACC + SP), aplicar y guardar vínculo ---
async function createTwin(req, res, next) {
  try {
    const { hubId, accountId, sp = {}, templateId, template, vars = {}, twinId, code, name, memberEmail } = req.body || {};
    if (!(hubId || accountId) || !templateId || !sp?.url) {
      return res.status(400).json({ error: 'hubId|accountId, templateId y sp.url son obligatorios' });
    }

    let tplObj = template;
    if (tplObj && typeof tplObj === 'string') {
      tplObj = await templates.loadTemplate(tplObj);
      if (!tplObj) return res.status(404).json({ error: `template "${template}" not found` });
    }

    const tplAdmin = await templates.loadTemplate(templateId).catch(() => null);
    const resolvedName = name || (tplAdmin ? templates.expandName(tplAdmin, vars) : (tplObj ? templates.expandName(tplObj, vars) : vars.name)) || null;
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
      });
    }

    if (tplObj) {
      await accAdmin.applyTemplateToProject({
        accountId: accCreated.accountId,
        projectId: accCreated.projectId,
        projectIdDM: accCreated.dm?.projectIdDM,
        template: tplObj,
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
    await spAdmin.applyTemplateToSite({ siteId: spCreated.siteId, siteUrl: spCreated.siteUrl, template: tplAdmin || tplObj, resolvedName });

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
  createTwin
};
